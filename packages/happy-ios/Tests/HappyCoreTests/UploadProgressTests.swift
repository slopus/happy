import Foundation
import XCTest
import HappyCrypto
import HappyWire
@testable import HappyCore

/// A computer that takes bodies `chunk` bytes at a time, as the tunnel
/// writes them, noting each piece's phase on `board` after every write.
/// Held, it waits after each write until let go, or until cancelled.
private actor UploadComputer: AgentTransport {
    let board: UploadProgressBoard
    var chunk = 1000
    var held = false
    var rejectSends = 0
    var watched: [String] = []
    private(set) var snapshots: [[UploadPhase?]] = []
    private(set) var sends: [JSONValue] = []
    private(set) var sendBodies: [Data] = []
    private(set) var uploadBodies: [Data] = []
    private(set) var written = 0

    init(board: UploadProgressBoard) { self.board = board }

    func configure(chunk: Int = 1000, held: Bool = false, rejectSends: Int = 0, watched: [String] = []) {
        self.chunk = chunk; self.held = held; self.rejectSends = rejectSends; self.watched = watched
    }
    func release() { held = false }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        try answer(method: method, path: path, body: body)
    }

    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        if upload { uploadBodies.append(body) }
        var offset = 0
        while offset < body.count {
            offset = min(body.count, offset + chunk)
            sent(offset)
            written += 1
            snapshots.append(watched.map { board.phase($0) })
            while held { try await Task.sleep(for: .milliseconds(5)) }
        }
        return try answer(method: upload ? "PUT" : method, path: path, body: body)
    }

    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    /// The account's event stream, so its outbox delivers.
    func stream(path: String, credential: String, headers: [String: String]) -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func close() { streams.forEach { $0.finish() }; streams.removeAll() }

    private func answer(method: String, path: String, body: Data?) throws -> HTTP1Response {
        let value = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
        if path == "/v0/bootstrap/desktop" {
            return try response(200, .object(["cursor": .string("c"), "projects": .array([]), "workspaces": .array([])]))
        }
        if path.hasSuffix("/bootstrap") {
            return try response(200, .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])]))
        }
        if path.contains("/messages?") { return try response(200, .object(["runs": .array([]), "hasMore": .bool(false)])) }
        if method == "GET", path.hasPrefix("/v0/agents/") {
            return try response(200, .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")])]))
        }
        if method == "PUT", let content = value?["content"]?.stringValue, let bytes = Data(base64Encoded: content) {
            return try response(200, .object(["hash": .string(Hashing.sha256(bytes).map { String(format: "%02x", $0) }.joined())]))
        }
        if method == "POST", path.hasSuffix("/send"), let value {
            if rejectSends > 0 { rejectSends -= 1; return try response(400, .object(["code": .string("rejected"), "error": .string("Rejected")])) }
            sends.append(value)
            sendBodies.append(body ?? Data())
        }
        return try response(200, .object([:]))
    }

    private func response(_ status: Int, _ value: JSONValue) throws -> HTTP1Response {
        .init(status: status, body: try JSONEncoder().encode(value))
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func add() { lock.withLock { value += 1 } }
    var count: Int { lock.withLock { value } }
}

final class UploadProgressTests: XCTestCase {
    private let mode = AgentWire.Mode(providerId: "test", modelId: "model", effort: "high", serviceTier: nil, permissionMode: "auto")

    private func quantized(_ share: Double) -> UploadPhase {
        .uploading((min(1, max(0, share)) / UploadProgressBoard.step).rounded(.down) * UploadProgressBoard.step)
    }

    // MARK: The board

    /// However many writes land between two frames, the screen is woken
    /// once and reads each piece once, at its latest share.
    func testWritesBetweenFramesWakeOnceAndDrainTheLatestShare() {
        let board = UploadProgressBoard()
        let wakes = Counter()
        board.observe { wakes.add() }
        board.set("m:1", .uploading(0.25))
        board.set("m:1", .uploading(0.5))
        board.set("m:1", .uploading(0.75))
        board.set("m:f1", .preparing)
        XCTAssertEqual(wakes.count, 1)
        let drained = board.drain()
        XCTAssertEqual(drained.map(\.key), ["m:1", "m:f1"])
        XCTAssertEqual(drained.map(\.phase), [.uploading(0.75), .preparing])
        XCTAssertTrue(board.drain().isEmpty)

        // Finer than a ring can draw changes nothing, and wakes nothing.
        board.set("m:1", .uploading(0.75 + UploadProgressBoard.step / 2))
        XCTAssertEqual(wakes.count, 1)
        XCTAssertTrue(board.drain().isEmpty)
        XCTAssertTrue(board.active)

        board.set("m:1", .done)
        board.set("m:f1", .done)
        XCTAssertEqual(wakes.count, 2)
        XCTAssertFalse(board.active)
        board.clear(message: "m")
        XCTAssertEqual(board.drain().map(\.phase), [nil, nil])
        XCTAssertNil(board.phase("m:1"))
    }

    func testKeysNameThePiecesOfTheirMessage() {
        XCTAssertEqual(UploadProgressBoard.pictureKey("m-1", 0), "m-1:1")
        XCTAssertEqual(UploadProgressBoard.fileKey("m-1", 2), "m-1:f3")
        XCTAssertEqual(UploadProgressBoard.piece("m-1:1", message: "m-1"), .picture(0))
        XCTAssertEqual(UploadProgressBoard.piece("m-1:f3", message: "m-1"), .file(2))
        XCTAssertNil(UploadProgressBoard.piece("m-1:0", message: "m-1"))
        XCTAssertNil(UploadProgressBoard.piece("m-2:1", message: "m-1"))
    }

    /// Each picture's base64 is found in the body, so the bytes written
    /// say how far each one is.
    func testRangesSayHowFarEachPictureIsInTheBody() {
        let body = Data(#"{"a":"QUJD","b":"REVGR0hJ","t":"x"}"#.utf8)
        let ranges = UploadRanges(body: body, encoded: ["QUJD", "REVGR0hJ"])
        XCTAssertEqual(ranges.ranges, [6..<10, 17..<25])
        XCTAssertEqual(ranges.shares(sent: 0), [0, 0])
        XCTAssertEqual(ranges.shares(sent: 8), [0.5, 0])
        XCTAssertEqual(ranges.shares(sent: 19), [1, 0.25])
        XCTAssertEqual(ranges.shares(sent: body.count), [1, 1])
    }

    // MARK: From the bytes written

    /// A file's ring follows its upload's bytes chunk by chunk, read and
    /// encoded first (waiting), done once the computer has it.
    func testAFileFillsWithItsUploadsBytes() async throws {
        let board = UploadProgressBoard()
        let computer = UploadComputer(board: board)
        let key = UploadProgressBoard.fileKey("m", 0)
        await computer.configure(chunk: 1000, watched: [key])
        let client = AgentClient(transport: computer, token: "t")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data((0..<6000).map { UInt8($0 % 251) })
        let url = root.appendingPathComponent("clip.mov")
        try bytes.write(to: url)
        let file = QueuedFile(fileURL: url, name: "clip.mov", mimeType: "video/quicktime", size: bytes.count, path: ".happy-uploads/m/0-clip.mov")
        let message = QueuedMessage(id: "m", agentID: "a", text: "", pictures: [], mode: mode, files: [file])

        try await client.deliverMessage(message, board: board) { _ in }

        // The body is the content's base64 (8000 bytes) in its JSON: the
        // ring moves only over the content, a write at a time.
        let content = bytes.base64EncodedString()
        let uploaded = await computer.uploadBodies
        let wrapper = try XCTUnwrap(uploaded.first)
        let start = try XCTUnwrap(wrapper.range(of: Data(content.utf8))).lowerBound
        let writes = (wrapper.count + 999) / 1000
        let expected = (1...writes).map { write -> UploadPhase? in
            quantized(Double(min(wrapper.count, write * 1000) - start) / Double(content.utf8.count))
        }
        let snapshots = await computer.snapshots
        // The file's writes, then the /send's one (which carries no picture).
        XCTAssertEqual(Array(snapshots.prefix(writes)).map { $0[0] }, expected)
        XCTAssertEqual(expected.last, .uploading(1))
        XCTAssertEqual(board.phase(key), .done)
    }

    /// Inline pictures share the /send body: the first fills while the
    /// second waits, then the second.
    func testInlinePicturesFillInTheirOrderInOneBody() async throws {
        let board = UploadProgressBoard()
        let computer = UploadComputer(board: board)
        let keys = [UploadProgressBoard.pictureKey("m", 0), UploadProgressBoard.pictureKey("m", 1)]
        await computer.configure(chunk: 400, watched: keys)
        let client = AgentClient(transport: computer, token: "t")
        let first = Data(repeating: 1, count: 900), second = Data(repeating: 2, count: 1200)
        let message = QueuedMessage(id: "m", agentID: "a", text: "Look", pictures: [.init(mimeType: "image/png", data: first), .init(mimeType: "image/png", data: second)], mode: mode)

        try await client.deliverMessage(message, board: board) { _ in }

        let snapshots = await computer.snapshots
        let bodies = await computer.sendBodies
        let body = try XCTUnwrap(bodies.first)
        let ranges = UploadRanges(body: body, encoded: [first.base64EncodedString(), second.base64EncodedString()])
        XCTAssertEqual(snapshots.count, (body.count + 399) / 400)
        for (index, snapshot) in snapshots.enumerated() {
            let shares = ranges.shares(sent: min(body.count, (index + 1) * 400))
            XCTAssertEqual(snapshot, shares.map(quantized), "write \(index + 1)")
        }
        // The second has not begun while the first is still going.
        for snapshot in snapshots where snapshot[0] != .uploading(1) { XCTAssertEqual(snapshot[1], .uploading(0)) }
        XCTAssertEqual(keys.map(board.phase), [.done, .done])
    }

    // MARK: Failure and cancel in a conversation

    private func conversation(_ computer: UploadComputer) -> (Conversation, SyncEngine) {
        let client = AgentClient(transport: computer, token: "t")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let engine = SyncEngine(client: client, directory: root)
        return (Conversation(client: client, store: engine.spaces, agentId: "a", mode: mode), engine)
    }

    private func item(_ conversation: Conversation, _ id: String, until done: @escaping (ChatItem?) -> Bool) async -> ChatItem? {
        var updates = conversation.updates.makeAsyncIterator()
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline, let snapshot = await updates.next() {
            let item = snapshot.items.first { $0.id == id }
            if done(item) { return item }
        }
        return nil
    }

    /// A send that fails keeps its pictures, marked failed: its ring turns
    /// to retry and waits; retried, it goes and its ring is let go.
    func testAFailedSendKeepsItsPicturesAndARetrySendsThem() async throws {
        let computer = UploadComputer(board: .shared)
        await computer.configure(rejectSends: 1)
        let (conversation, _) = conversation(computer)
        let id = "fail-\(UUID().uuidString)"
        let key = UploadProgressBoard.pictureKey(id, 0)
        let picture = Data(repeating: 7, count: 3000)
        let saved = await conversation.send(id: id, text: "", pictures: [("image/png", picture)])
        XCTAssertTrue(saved)
        // A conversation without an outbox sends what it holds once it follows.
        await conversation.start()
        let failed = await item(conversation, id) { if case .failed = $0?.delivery { true } else { false } }
        XCTAssertEqual(failed?.pieces, [.picture(id: key, mimeType: "image/png", data: picture)])
        XCTAssertEqual(UploadProgressBoard.shared.phase(key), .preparing)

        await conversation.retry(id)
        let sent = await item(conversation, id) { $0?.delivery == .pending }
        XCTAssertNotNil(sent)
        XCTAssertNil(UploadProgressBoard.shared.phase(key))
        let sends = await computer.sends
        XCTAssertEqual(sends.count, 1)
        XCTAssertEqual(sends.first?["content"]?.arrayValue?.first?["data"]?.stringValue, picture.base64EncodedString())
        await conversation.stop()
    }

    /// Telegram's cross on one picture of a sending message takes it out
    /// and sends the rest, text and all; on the last, the message goes.
    func testCancelTakesOnePictureOutAndTheRestStillGoes() async throws {
        let computer = UploadComputer(board: .shared)
        await computer.configure(chunk: 500, held: true)
        let (conversation, _) = conversation(computer)
        let id = "cancel-\(UUID().uuidString)"
        let first = Data(repeating: 1, count: 2000), second = Data(repeating: 2, count: 2000)
        _ = await conversation.send(id: id, text: "Two", pictures: [("image/png", first), ("image/png", second)])
        await conversation.start()
        // The first write is out, and the send waits on the next.
        for _ in 0..<400 where await computer.written == 0 { try await Task.sleep(for: .milliseconds(5)) }
        guard case .uploading = UploadProgressBoard.shared.phase(UploadProgressBoard.pictureKey(id, 0)) else { return XCTFail("the first picture is uploading") }

        await conversation.removeAttachment(id, key: UploadProgressBoard.pictureKey(id, 0))
        await computer.release()
        let sent = await item(conversation, id) { $0?.delivery == .pending }
        XCTAssertEqual(sent?.pieces, [.text("Two"), .picture(id: UploadProgressBoard.pictureKey(id, 0), mimeType: "image/png", data: second)])
        let sends = await computer.sends
        XCTAssertEqual(sends.count, 1)
        XCTAssertEqual(sends.first?["text"]?.stringValue, "Two")
        XCTAssertEqual(sends.first?["content"]?.arrayValue?.compactMap { $0["data"]?.stringValue }, [second.base64EncodedString()])
        await conversation.stop()

        // A picture alone: its cross takes the message back whole.
        let lone = "lone-\(UUID().uuidString)"
        await computer.configure(chunk: 500, held: true)
        let (other, _) = self.conversation(computer)
        let before = await computer.written
        _ = await other.send(id: lone, text: "", pictures: [("image/png", first)])
        await other.start()
        for _ in 0..<400 where await computer.written == before { try await Task.sleep(for: .milliseconds(5)) }
        await other.removeAttachment(lone, key: UploadProgressBoard.pictureKey(lone, 0))
        let gone = await item(other, lone) { $0 == nil }
        XCTAssertNil(gone)
        await computer.release()
        try await Task.sleep(for: .milliseconds(50))
        let after = await computer.sends
        XCTAssertEqual(after.count, 1, "the taken-back message never went")
        await other.stop()
    }

    /// The account's outbox: a queued message's picture is taken out while
    /// it uploads, and the rest is what reaches the computer.
    func testCancelInTheOutboxStopsItsDeliveryAndSendsTheRest() async throws {
        let computer = UploadComputer(board: .shared)
        await computer.configure(chunk: 500, held: true)
        let client = AgentClient(transport: computer, token: "t")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = SyncEngine(client: client, directory: root)
        let id = "outbox-\(UUID().uuidString)"
        let first = Data(repeating: 3, count: 2000), second = Data(repeating: 4, count: 2000)
        try await engine.enqueueMessage(QueuedMessage(id: id, agentID: "a", text: "", pictures: [.init(mimeType: "image/png", data: first), .init(mimeType: "image/png", data: second)], mode: mode))
        await engine.start()
        for _ in 0..<400 where await computer.written == 0 { try await Task.sleep(for: .milliseconds(5)) }

        let result = try await engine.removeAttachment(id, .picture(1))
        XCTAssertTrue(result.removed)
        XCTAssertEqual(result.message?.pictures.map(\.data), [first])
        await computer.release()
        for _ in 0..<400 where try await !engine.queuedMessages(for: "a").isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        let sends = await computer.sends
        XCTAssertEqual(sends.last?["content"]?.arrayValue?.compactMap { $0["data"]?.stringValue }, [first.base64EncodedString()])
        await engine.stop()
    }
}
