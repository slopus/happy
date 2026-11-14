import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// A computer with happy-agent's attachments (`API.md`, "Attachments"):
/// chunks in any order, `received` as inclusive ranges, the hash checked
/// once all bytes are there. Faults are queued per request.
private actor AttachmentComputer: AgentTransport {
    enum Fault: Equatable { case drop, unavailable, forget, tooMany, missingRoute(Int) }
    struct Upload { var size: Int; var bytes: Data; var received: IndexSet }

    var stored: [String: Data] = [:]
    var uploads: [String: Upload] = [:]
    var faults: [Fault] = []
    private(set) var log: [(method: String, path: String, range: String?, body: Int)] = []
    private(set) var sends: [JSONValue] = []

    func fail(_ faults: [Fault]) { self.faults = faults }
    func hold(_ id: String, bytes: Data, received: [Range<Int>]) {
        var upload = Upload(size: bytes.count, bytes: Data(count: bytes.count), received: IndexSet())
        for range in received {
            upload.received.insert(integersIn: range)
            upload.bytes.replaceSubrange(range, with: bytes.subdata(in: range))
        }
        uploads[id] = upload
    }
    func store(_ id: String, _ bytes: Data) { stored[id] = bytes }
    func requests() -> [(method: String, path: String, range: String?, body: Int)] { log }
    func sent() -> [JSONValue] { sends }
    func close() {}

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let body = body ?? Data()
        log.append((method, path, headers["Content-Range"], body.count))
        if path.hasSuffix("/send") {
            let value = try JSONDecoder().decode(JSONValue.self, from: body)
            sends.append(value)
            return try respond(200, ["message": .object(["id": value["id"] ?? .null])])
        }
        guard path.contains("/attachments/") else { return try respond(404, ["code": .string("not_found")]) }
        let fault = faults.isEmpty ? nil : faults.removeFirst()
        switch fault {
        case .drop: throw URLError(.networkConnectionLost)
        case .unavailable: return try respond(503, ["code": .string("unavailable")])
        case .tooMany: return try respond(400, ["code": .string("invalid_request")])
        case .missingRoute(let status): return try respond(status, ["code": .string("not_found")])
        case .forget, nil: break
        }
        let id = String(path.split(separator: "/").last!.split(separator: "?").first!)
        if method == "DELETE" { uploads[id] = nil; return try respond(200, [:]) }
        if let bytes = stored[id] { return try respond(201, ["attachment": attachment(id, bytes)]) }
        guard let range = headers["Content-Range"] else {
            guard Attachments.id(body) == id else { return try respond(409, ["code": .string("hash_mismatch")]) }
            stored[id] = body
            return try respond(201, ["attachment": attachment(id, body)])
        }
        let total = Int(range.split(separator: "/").last!)!
        var upload = uploads[id] ?? Upload(size: total, bytes: Data(count: total), received: IndexSet())
        if !range.hasPrefix("bytes */") {
            let bounds = range.dropFirst(6).split(separator: "/")[0].split(separator: "-").map { Int($0)! }
            XCTAssertEqual(bounds[1] - bounds[0] + 1, body.count)
            if fault != .forget {
                upload.bytes.replaceSubrange(bounds[0]...bounds[1], with: body)
                upload.received.insert(integersIn: bounds[0]...bounds[1])
            }
        }
        uploads[id] = upload
        if upload.received.count == upload.size {
            uploads[id] = nil
            guard Attachments.id(upload.bytes) == id else { return try respond(409, ["code": .string("hash_mismatch")]) }
            stored[id] = upload.bytes
            return try respond(201, ["attachment": attachment(id, upload.bytes)])
        }
        let received: [JSONValue] = upload.received.rangeView.map { .object(["start": .number(Double($0.lowerBound)), "end": .number(Double($0.upperBound - 1))]) }
        return try respond(200, ["upload": .object(["id": .string(id), "name": .string("f"), "size": .number(Double(total)), "received": .array(received), "expiresAt": .number(0)])])
    }

    private func attachment(_ id: String, _ bytes: Data) -> JSONValue {
        .object(["id": .string(id), "name": .string("f"), "mimeType": .string("image/png"), "size": .number(Double(bytes.count))])
    }
    private func respond(_ status: Int, _ object: [String: JSONValue]) throws -> HTTP1Response {
        .init(status: status, body: try JSONEncoder().encode(JSONValue.object(object)))
    }
}

final class AttachmentUploadTests: XCTestCase {
    private let mode = AgentWire.Mode(providerId: "test", modelId: "model", effort: "high", serviceTier: nil, permissionMode: "auto")

    private func bytes(_ count: Int) -> Data { Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }) }

    private func attach(_ computer: AttachmentComputer, _ data: Data, chunk: Int = 100) async throws -> AgentClient {
        let client = AgentClient(transport: computer, token: "t")
        try await client.attach("agent", id: Attachments.id(data), bytes: data, name: "a b.png", mimeType: "image/png", chunk: chunk, retryDelay: .zero)
        return client
    }

    func testNextSendsTheFirstMissingRangeUpToTheNextHeld() {
        XCTAssertEqual(Attachments.next([], size: 250, chunk: 100), 0..<100)
        XCTAssertEqual(Attachments.next([0...99], size: 250, chunk: 100), 100..<200)
        XCTAssertEqual(Attachments.next([0...99, 130...249], size: 250, chunk: 100), 100..<130)
        XCTAssertEqual(Attachments.next([50...249], size: 250, chunk: 100), 0..<50)
        XCTAssertEqual(Attachments.next([0...199], size: 250, chunk: 100), 200..<250)
        XCTAssertNil(Attachments.next([0...249], size: 250, chunk: 100))
    }

    func testSmallFileGoesWholeNamedByItsHash() async throws {
        let computer = AttachmentComputer()
        let data = bytes(80)
        _ = try await attach(computer, data)
        let log = await computer.requests()
        XCTAssertEqual(log.count, 1)
        XCTAssertEqual(log[0].path, "/v0/agents/agent/attachments/\(Attachments.id(data))?name=a%20b.png")
        XCTAssertNil(log[0].range)
        let stored = await computer.stored[Attachments.id(data)]
        XCTAssertEqual(stored, data)
    }

    func testLargeFileAsksThenSendsChunksInOrder() async throws {
        let computer = AttachmentComputer()
        let data = bytes(250)
        _ = try await attach(computer, data)
        let ranges = await computer.requests().map(\.range)
        XCTAssertEqual(ranges, ["bytes */250", "bytes 0-99/250", "bytes 100-199/250", "bytes 200-249/250"])
        let stored = await computer.stored[Attachments.id(data)]
        XCTAssertEqual(stored, data)
    }

    func testResumeSendsOnlyWhatTheComputerLacks() async throws {
        let computer = AttachmentComputer()
        let data = bytes(250)
        let id = Attachments.id(data)
        // An earlier attempt left the start and the end there.
        await computer.hold(id, bytes: data, received: [0..<120, 200..<250])
        _ = try await attach(computer, data)
        let ranges = await computer.requests().map(\.range)
        XCTAssertEqual(ranges, ["bytes */250", "bytes 120-199/250"])
        let stored = await computer.stored[id]
        XCTAssertEqual(stored, data)
    }

    func testAlreadyStoredSendsNoBytes() async throws {
        let computer = AttachmentComputer()
        let data = bytes(250)
        await computer.store(Attachments.id(data), data)
        _ = try await attach(computer, data)
        let log = await computer.requests()
        XCTAssertEqual(log.map(\.range), ["bytes */250"])
        XCTAssertEqual(log.map(\.body), [0])
    }

    func testDroppedConnectionAndUnavailableAskAgainAndResend() async throws {
        let computer = AttachmentComputer()
        let data = bytes(250)
        // Ask, first chunk, then a drop and a 503 on the second.
        await computer.fail([.forget, .forget, .drop, .unavailable])
        _ = try await attach(computer, data)
        let ranges = await computer.requests().map(\.range)
        // The ask went through (`.forget` on an ask keeps nothing anyway);
        // the first chunk was forgotten, so it went again after asking.
        XCTAssertEqual(ranges, [
            "bytes */250", "bytes 0-99/250", "bytes 0-99/250", "bytes */250", "bytes */250", "bytes 0-99/250", "bytes 100-199/250", "bytes 200-249/250",
        ])
        let stored = await computer.stored[Attachments.id(data)]
        XCTAssertEqual(stored, data)
    }

    func testChunksNeverKeptGiveUpAfterAttempts() async throws {
        let computer = AttachmentComputer()
        let data = bytes(250)
        await computer.fail([.forget] + Array(repeating: .forget, count: 10))
        do {
            _ = try await attach(computer, data)
            XCTFail("Expected to give up")
        } catch AgentClientError.invalidResponse {}
        let sent = await computer.requests().filter { $0.body > 0 }.count
        XCTAssertEqual(sent, Attachments.attempts)
    }

    func testTooManyRequestsCancelsAndStartsAgain() async throws {
        let computer = AttachmentComputer()
        let data = bytes(250)
        await computer.fail([.forget, .forget, .tooMany])
        _ = try await attach(computer, data)
        let log = await computer.requests()
        XCTAssertEqual(log.map(\.method), ["PUT", "PUT", "PUT", "DELETE", "PUT", "PUT", "PUT", "PUT"])
        XCTAssertEqual(log.suffix(4).map(\.range), ["bytes */250", "bytes 0-99/250", "bytes 100-199/250", "bytes 200-249/250"])
    }

    func testHashMismatchFails() async throws {
        let computer = AttachmentComputer()
        let data = bytes(80)
        let client = AgentClient(transport: computer, token: "t")
        do {
            try await client.attach("agent", id: Attachments.id(bytes(81)), bytes: data, name: "x", mimeType: "image/png", chunk: 100, retryDelay: .zero)
            XCTFail("Expected hash_mismatch")
        } catch AgentClientError.status(409, let code, _) {
            XCTAssertEqual(code, "hash_mismatch")
        }
        // Chunked: the last chunk finds the bytes aren't the ID's.
        do {
            try await client.attach("agent", id: Attachments.id(bytes(251)), bytes: bytes(250), name: "x", mimeType: "image/png", chunk: 100, retryDelay: .zero)
            XCTFail("Expected hash_mismatch")
        } catch AgentClientError.status(409, let code, _) {
            XCTAssertEqual(code, "hash_mismatch")
        }
    }

    func testMissingRouteIsUnsupported() async throws {
        for status in [404, 405, 501] {
            let computer = AttachmentComputer()
            await computer.fail([.missingRoute(status)])
            let client = AgentClient(transport: computer, token: "t")
            XCTAssertTrue(client.attachmentSupport.worthTrying)
            do {
                try await client.attach("agent", id: Attachments.id(bytes(10)), bytes: bytes(10), name: "x", mimeType: "image/png", retryDelay: .zero)
                XCTFail("Expected unsupported")
            } catch is AttachmentsUnsupported {}
            XCTAssertFalse(client.attachmentSupport.worthTrying)
        }
    }

    func testDeliverSendsFileBlocksAndKeepsTheBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let picture = bytes(300)
        let document = bytes(40)
        let file = root.appendingPathComponent("doc")
        try document.write(to: file)
        let computer = AttachmentComputer()
        let client = AgentClient(transport: computer, token: "t")
        let media = MediaStore(directory: root.appendingPathComponent("media"))
        let message = QueuedMessage(id: "m1", agentID: "agent", text: "", pictures: [.init(mimeType: "image/png", data: picture)], mode: mode,
            files: [QueuedFile(fileURL: file, name: "notes.pdf", mimeType: "application/pdf", size: document.count, path: ".happy-uploads/m1/0-notes.pdf")])
        try await client.deliverMessage(message, board: UploadProgressBoard(), media: media, retryDelay: .zero) { _ in }
        let sends = await computer.sent()
        XCTAssertEqual(sends.count, 1)
        XCTAssertEqual(sends[0]["text"], .string("Attached files."))
        XCTAssertEqual(sends[0]["content"], .array([
            .object(["type": .string("file"), "attachment": .string(Attachments.id(picture)), "name": .string("image-1.png")]),
            .object(["type": .string("file"), "attachment": .string(Attachments.id(document)), "name": .string("notes.pdf")]),
        ]))
        // Nothing went to the workspace, and the bytes never travelled in the send.
        let paths = await computer.requests().map(\.path)
        XCTAssertFalse(paths.contains { $0.contains("/workspaces/") })
        let sendBody = await computer.requests().last!.body
        XCTAssertLessThan(sendBody, 1000)
        let kept = media.read(Media.attachmentResource(agentId: "agent", id: Attachments.id(picture)), 0..<picture.count, seal: nil)
        XCTAssertEqual(kept, picture)
    }

    func testOlderComputerGetsPicturesInline() async throws {
        let computer = AttachmentComputer()
        await computer.fail([.missingRoute(404)])
        let client = AgentClient(transport: computer, token: "t")
        let picture = bytes(300)
        let message = QueuedMessage(id: "m2", agentID: "agent", text: "look", pictures: [.init(mimeType: "image/png", data: picture)], mode: mode)
        try await client.deliverMessage(message, board: UploadProgressBoard(), retryDelay: .zero) { _ in }
        let sends = await computer.sent()
        XCTAssertEqual(sends.count, 1)
        XCTAssertEqual(sends[0]["content"]?.arrayValue?.first?["type"], .string("image"))
        XCTAssertEqual(sends[0]["content"]?.arrayValue?.first?["data"], .string(picture.base64EncodedString()))
        // Remembered: the next message doesn't ask again.
        try await client.deliverMessage(QueuedMessage(id: "m3", agentID: "agent", text: "", pictures: [.init(mimeType: "image/png", data: picture)], mode: mode),
            board: UploadProgressBoard(), retryDelay: .zero) { _ in }
        let attempts = await computer.requests().filter { $0.path.contains("/attachments/") }.count
        XCTAssertEqual(attempts, 1)
    }

    func testFileBlockDecodesAsAttachedMedia() throws {
        let json = #"{"type":"file","attachment":"ab","name":"IMG.jpg","mimeType":"image/jpeg","size":2000000,"kind":"image","width":4032,"height":3024,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}"#
        let block = try JSONDecoder().decode(AgentWire.Block.self, from: Data(json.utf8))
        guard case .file(let file) = block else { return XCTFail("Expected a file block") }
        let media = Media(file: file)
        XCTAssertEqual(media.key, "attachment/ab")
        XCTAssertTrue(media.isVisual)
        XCTAssertEqual(media.item.width, 4032)
        XCTAssertEqual(media.item.thumbhash, "1QcSHQRnh493V4dIh4eXh1h4kJUI")
        // Kept and read back, it is the same block.
        let again = try JSONDecoder().decode(AgentWire.Block.self, from: JSONEncoder().encode(block))
        XCTAssertEqual(again, block)
        // Happy Cloud's, without details, and an unknown kind, are files.
        let bare = try JSONDecoder().decode(AgentWire.Block.self, from: Data(#"{"type":"file","attachment":"cd","name":"x.avif","kind":"hologram"}"#.utf8))
        guard case .file(let plain) = bare else { return XCTFail("Expected a file block") }
        XCTAssertEqual(plain.item.kind, "file")
        XCTAssertFalse(Media(file: plain).isVisual)
    }
}
