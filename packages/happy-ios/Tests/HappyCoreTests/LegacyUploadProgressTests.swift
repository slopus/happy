import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Network)
import Network
#endif

/// `FakeHTTP` whose blob PUT writes its body in `parts` equal pieces,
/// telling `progress` after each, and, before going on, notes what the
/// board says about the file then. `hold` keeps it after the first piece
/// until let go (or cancelled).
private final class ChunkedHTTP: HTTPTransport, @unchecked Sendable {
    let http = FakeHTTP()
    let board: UploadProgressBoard
    let key: String
    var parts = 4
    private let lock = NSLock()
    private var _seen: [UploadPhase?] = []
    private var _held = false
    private var _hold = false

    init(board: UploadProgressBoard, key: String) {
        self.board = board
        self.key = key
    }

    var seen: [UploadPhase?] { lock.withLock { _seen } }
    var held: Bool { lock.withLock { _held } }
    func hold(_ value: Bool) { lock.withLock { _hold = value } }
    func note() { lock.withLock { _seen.append(board.phase(key)) } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse { try await http.send(request) }

    func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse {
        let total = Int64(request.body?.count ?? 0)
        for part in 1...parts {
            progress(total * Int64(part) / Int64(parts), total)
            note()
            if part == 1 {
                lock.withLock { _held = _hold }
                while lock.withLock({ _hold }) { try await Task.sleep(for: .milliseconds(2)) }
            }
        }
        return try await http.send(request)
    }
}

final class LegacyUploadProgressTests: XCTestCase, @unchecked Sendable {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A store with session "s", a picture "f" queued with the text "t"
    /// waiting on it, and an engine sending through `transport`.
    private func setup(_ transport: ChunkedHTTP, board: UploadProgressBoard) async throws -> (LocalStore, LegacySyncEngine) {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        var options = LegacySyncEngine.Options()
        options.sendAttempts = 1
        options.uploads = board
        let api = HappyAPI(serverURL: testServer, clientID: "ios/9.9.9", transport: transport).authenticated(token: "token-1")
        let engine = LegacySyncEngine(api: api, store: store, keys: fixture.keys, options: options, now: { 1_000 })
        await engine.configureSending(filesDirectory: directory)
        try Data(repeating: 7, count: 1000).write(to: directory.appendingPathComponent("f"))
        try store.enqueueBatch([
            OutboxRecord(localId: "f", kind: .file, sessionId: "s", payload: .null, createdAt: 1),
            OutboxRecord(localId: "t", kind: .message, sessionId: "s", payload: .object(["role": .string("user")]), createdAt: 1, dependsOn: "f"),
        ], attachments: [AttachmentRecord(localId: "f", sessionId: "s", outboxLocalId: "f", path: "f", name: "photo.jpg", mimeType: "image/jpeg", size: 1000, width: 4, height: 3, createdAt: 1)])
        transport.http.on("POST /v1/sessions/s/attachments/request-upload") { _ in
            // Read and sealed, asking where to go: the ring turns.
            transport.note()
            return (200, Data(#"{"ref":"blob-ref","uploadUrl":"https://api.example.test/blob","method":"PUT"}"#.utf8))
        }
        transport.http.onRaw("PUT /blob", "")
        transport.http.on("POST /v3/sessions/s/messages") { request in
            let localId = try request.jsonBody(SendMessagesRequest.self).messages[0].localId
            return (200, Data(#"{"messages":[{"id":"m-\#(localId)","seq":1,"localId":"\#(localId)","createdAt":1,"updatedAt":1}]}"#.utf8))
        }
        return (store, engine)
    }

    private func posted(_ transport: ChunkedHTTP) throws -> [String] {
        try transport.http.requests("POST /v3/sessions/s/messages").map { try $0.jsonBody(SendMessagesRequest.self).messages[0].localId }
    }

    /// The board hears the file's phases in order: preparing while it is
    /// sealed and given a place, then each quarter of the bytes as it is
    /// written, exactly, and nothing once the file is in the chat.
    func testAnOutboxFileFillsTheBoardWithEachWrite() async throws {
        let board = UploadProgressBoard()
        let key = UploadProgressBoard.outboxKey("f")
        let transport = ChunkedHTTP(board: board, key: key)
        let (store, engine) = try await setup(transport, board: board)
        try await engine.flushOutbox()
        XCTAssertEqual(transport.seen, [.preparing, .uploading(0.25), .uploading(0.5), .uploading(0.75), .uploading(1)])
        XCTAssertNil(board.phase(key), "a sent file is forgotten")
        XCTAssertEqual(try posted(transport), ["f", "t"])
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        await engine.stop()
    }

    /// The cross while it uploads: the upload stops, only the picture goes,
    /// and the text it was sent with is posted without it.
    func testDiscardingAFileMidUploadStopsItAndSendsTheText() async throws {
        let board = UploadProgressBoard()
        let key = UploadProgressBoard.outboxKey("f")
        let transport = ChunkedHTTP(board: board, key: key)
        transport.hold(true)
        let (store, engine) = try await setup(transport, board: board)
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory)
        await engine.invalidate(.outbox)
        let deadline = ContinuousClock.now + .seconds(5)
        while !transport.held, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(transport.held, "the upload never started")
        XCTAssertEqual(board.phase(key), .uploading(0.25))
        XCTAssertEqual(try store.outbox(localId: "f")?.state, .sending)

        try await sender.discard(localId: "f")
        await engine.waitForIdle()
        XCTAssertNil(board.phase(key))
        XCTAssertEqual(transport.seen, [.preparing, .uploading(0.25)], "the upload went on after the cross")
        XCTAssertTrue(transport.http.requests("PUT /blob").isEmpty, "the PUT was answered")
        XCTAssertEqual(try posted(transport), ["t"], "the text didn't go on its own")
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        XCTAssertNil(try store.attachment(outboxLocalId: "f"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("f").path))
        await engine.stop()
    }

    /// An upload the server couldn't take (503): the picture is out of tries
    /// and forgotten by the board, and its text waits with it; retried by
    /// hand, it uploads in full and both go.
    func testAFailedUploadRetriesFromNothing() async throws {
        let board = UploadProgressBoard()
        let key = UploadProgressBoard.outboxKey("f")
        let transport = ChunkedHTTP(board: board, key: key)
        let (store, engine) = try await setup(transport, board: board)
        transport.http.onRaw("PUT /blob", "busy", status: 503)
        try await engine.flushOutbox()
        XCTAssertEqual(try store.outbox(localId: "f")?.state, .interrupted)
        XCTAssertEqual(try store.outbox(localId: "t")?.state, .interrupted)
        XCTAssertNil(board.phase(key), "a failed upload keeps its share")
        XCTAssertEqual(try posted(transport), [], "the text went without its picture")

        transport.http.onRaw("PUT /blob", "")
        try await OutboxSender(store: store, sync: engine, filesDirectory: directory).retry(localId: "f")
        await engine.waitForIdle()
        XCTAssertEqual(Array(transport.seen.suffix(5)), [.preparing, .uploading(0.25), .uploading(0.5), .uploading(0.75), .uploading(1)])
        XCTAssertEqual(try posted(transport), ["f", "t"])
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        XCTAssertNil(board.phase(key))
        await engine.stop()
    }

    /// Taking out the middle one of two pictures leaves the first, and the
    /// text waits on the first.
    func testDiscardingOneFileRelinksTheChain() throws {
        let store = try LocalStore.inMemory()
        try store.enqueueBatch([
            OutboxRecord(localId: "a", kind: .file, sessionId: "s", payload: .null, createdAt: 1),
            OutboxRecord(localId: "b", kind: .file, sessionId: "s", payload: .null, createdAt: 1, dependsOn: "a"),
            OutboxRecord(localId: "t", kind: .message, sessionId: "s", payload: .null, createdAt: 1, dependsOn: "b"),
        ], attachments: ["a", "b"].map { AttachmentRecord(localId: $0, sessionId: "s", outboxLocalId: $0, path: $0, name: $0, mimeType: "image/jpeg", size: 1, createdAt: 1) })
        let gone = try store.discardOutbox(localId: "b")
        XCTAssertEqual(gone.map(\.localId), ["b"])
        XCTAssertEqual(try store.pendingOutbox().map(\.localId), ["a", "t"])
        XCTAssertEqual(try store.outbox(localId: "t")?.dependsOn, "a")
        XCTAssertNotNil(try store.attachment(outboxLocalId: "a"))
        // The text still takes the pictures it was sent with.
        XCTAssertEqual(try store.discardOutbox(localId: "t").map(\.localId), ["a"])
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
    }

    /// A recording from the menu goes as a file: its shape would make it
    /// read as a picture, which is all happy-app ever sends a shape for.
    func testARecordingGoesWithoutAPicturesShape() {
        let video = AttachmentRecord(localId: "v", sessionId: "s", path: "v", name: "clip.mov", mimeType: "video/quicktime", size: 9, width: 1920, height: 1080, createdAt: 1)
        XCTAssertNil(LegacySyncEngine.filePayload(id: "v", time: 1, attachment: video, ref: "r")["content"]?["data"]?["ev"]?["image"])
        var photo = video
        photo.mimeType = "image/jpeg"
        XCTAssertEqual(LegacySyncEngine.filePayload(id: "v", time: 1, attachment: photo, ref: "r")["content"]?["data"]?["ev"]?["image"]?["width"], .number(1920))
    }

    // MARK: Transport

    /// A transport that can't see its bytes says they all went once answered.
    func testTheDefaultTransportReportsTheWholeBodyOnceAnswered() async throws {
        let http = FakeHTTP()
        http.onRaw("PUT /blob", "")
        let calls = Calls()
        _ = try await http.send(HTTPRequest(method: "PUT", url: URL(string: "https://api.example.test/blob")!, body: Data(count: 300))) { sent, total in
            calls.add(sent, total)
        }
        XCTAssertEqual(calls.all.map { [$0.0, $0.1] }, [[300, 300]])
    }

    /// The upload task's delegate passes on what URLSession says was
    /// written, out of the body's length when the task doesn't know it.
    func testTheUploadDelegatePassesOnEachWrite() {
        let calls = Calls()
        let delegate = UploadProgressDelegate(total: 1000) { calls.add($0, $1) }
        let task = URLSession.shared.dataTask(with: URL(string: "https://api.example.test/blob")!)
        delegate.urlSession(.shared, task: task, didSendBodyData: 400, totalBytesSent: 400, totalBytesExpectedToSend: 1000)
        delegate.urlSession(.shared, task: task, didSendBodyData: 600, totalBytesSent: 1000, totalBytesExpectedToSend: -1)
        XCTAssertEqual(calls.all.map { [$0.0, $0.1] }, [[400, 1000], [1000, 1000]])
    }

    #if canImport(Network)
    /// A real upload to a server on the loopback: the shares reported are
    /// URLSession's writes of the body, rising to all of it.
    func testURLSessionReportsTheBytesItWrites() async throws {
        let server = try LoopbackServer()
        defer { server.stop() }
        let port = try await server.start()
        let body = Data(repeating: 9, count: 16 * 1024 * 1024)
        let calls = Calls()
        let transport = URLSessionTransport(session: URLSession(configuration: .ephemeral))
        let response = try await transport.send(HTTPRequest(method: "PUT", url: URL(string: "http://127.0.0.1:\(port)/blob")!, body: body)) { sent, total in
            calls.add(sent, total)
        }
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(server.received, body.count)
        let all = calls.all
        XCTAssertGreaterThan(all.count, 1, "one report for 16 MB")
        XCTAssertEqual(all.map(\.0), all.map(\.0).sorted())
        XCTAssertEqual(all.last.map { [$0.0, $0.1] }, [Int64(body.count), Int64(body.count)])
        XCTAssertTrue(all.allSatisfy { $0.1 == Int64(body.count) })
    }
    #endif
}

private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [(Int64, Int64)] = []
    func add(_ sent: Int64, _ total: Int64) { lock.withLock { calls.append((sent, total)) } }
    var all: [(Int64, Int64)] { lock.withLock { calls } }
}

#if canImport(Network)
/// An HTTP/1.1 server on 127.0.0.1 for one request: reads the headers and
/// `Content-Length` bytes of body, a little at a time, then answers 200.
private final class LoopbackServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback")
    private let lock = NSLock()
    private var _received = 0
    var received: Int { lock.withLock { _received } }

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
        let started = Started()
        return try await withCheckedThrowingContinuation { continuation in
            started.continuation = continuation
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready: started.resume(.success(listener.port?.rawValue ?? 0))
                case .failed(let error): started.resume(.failure(error))
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }

    /// Everything here runs on `queue`, one thing at a time.
    private final class Started: @unchecked Sendable {
        var continuation: CheckedContinuation<UInt16, Error>?
        func resume(_ result: Result<UInt16, Error>) {
            continuation?.resume(with: result)
            continuation = nil
        }
    }

    private final class Incoming: @unchecked Sendable {
        var buffer = Data()
        var expected: Int?
        var headerEnd = 0
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, Incoming())
    }

    private func receive(_ connection: NWConnection, _ incoming: Incoming) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data { incoming.buffer.append(data) }
            if incoming.expected == nil, let range = incoming.buffer.range(of: Data("\r\n\r\n".utf8)) {
                incoming.headerEnd = range.upperBound
                let head = String(decoding: incoming.buffer[..<range.lowerBound], as: UTF8.self)
                incoming.expected = head.split(separator: "\r\n").compactMap { line -> Int? in
                    let parts = line.split(separator: ":", maxSplits: 1)
                    guard parts.count == 2, parts[0].lowercased() == "content-length" else { return nil }
                    return Int(parts[1].trimmingCharacters(in: .whitespaces))
                }.first ?? 0
            }
            if let expected = incoming.expected, incoming.buffer.count - incoming.headerEnd >= expected {
                lock.withLock { _received = incoming.buffer.count - incoming.headerEnd }
                let reply = Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".utf8)
                connection.send(content: reply, completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            if done || error != nil { connection.cancel(); return }
            // Read slowly, as a far server does, so the writes back up.
            queue.asyncAfter(deadline: .now() + .milliseconds(4)) { self.receive(connection, incoming) }
        }
    }
}
#endif
