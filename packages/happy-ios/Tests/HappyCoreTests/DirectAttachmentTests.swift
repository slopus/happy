import Foundation
import XCTest
import HappyCrypto
import HappyWire
@testable import HappyCore

private actor AttachmentServer: DirectTransport {
    var stored: [String: Data] = [:]
    var requests: [(String, String, JSONValue?)] = []
    var loseUploadAcknowledgement = false
    var rejectPath: String?
    var workspace = "actual-execution-workspace"
    var accepted: [String: JSONValue] = [:]
    var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    var uploadBodySizes: [Int] = []

    func configure(lostAck: Bool = false, reject: String? = nil, workspace: String = "actual-execution-workspace") {
        loseUploadAcknowledgement = lostAck; rejectPath = reject; self.workspace = workspace
    }
    func saved() -> [(String, String, JSONValue?)] { requests }
    func bytes(_ path: String) -> Data? { stored[path] }
    func encodedUploadSizes() -> [Int] { uploadBodySizes }
    func occupy(_ path: String, bytes: Data) { stored[path] = bytes }
    func stream(path: String, credential: String, headers: [String: String]) -> DirectHTTPStream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func close() { streams.forEach { $0.finish() }; streams.removeAll() }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> DirectHTTPResponse {
        let value = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
        requests.append((method, path, value))
        XCTAssertEqual(credential, "paired-device-token")
        if path == "/v0/bootstrap/desktop" {
            return try response(200, .object(["cursor": .string("cursor-1"), "projects": .array([]), "workspaces": .array([])]))
        }
        if path.hasSuffix("/bootstrap") {
            return try response(200, .object([
                "agent": .object(["id": .string("recipient"), "workspaceId": .string(workspace), "status": .string("idle")]),
                "pending": .array(Array(accepted.values)),
            ]))
        }
        if path.contains("/messages?") {
            return try response(200, .object(["runs": .array([]), "hasMore": .bool(false)]))
        }
        if method == "GET", path.hasPrefix("/v0/agents/") {
            return try response(200, .object(["agent": .object([
                "id": .string("recipient"), "workspaceId": .string(workspace), "status": .string("idle"),
            ])]))
        }
        if method == "PUT" {
            uploadBodySizes.append(body?.count ?? 0)
            guard let name = value?["path"]?.stringValue,
                  let encoded = value?["content"]?.stringValue, let bytes = Data(base64Encoded: encoded) else {
                return try response(400, .object([:]))
            }
            XCTAssertEqual(value?["expectedHash"], .null)
            if name == rejectPath { return try response(403, .object(["code": .string("denied")])) }
            if let existing = stored[name] {
                return try response(409, .object(["code": .string("hash_mismatch"), "hash": .string(hash(existing))]))
            }
            stored[name] = bytes
            if loseUploadAcknowledgement { loseUploadAcknowledgement = false; throw URLError(.networkConnectionLost) }
            return try response(200, .object(["hash": .string(hash(bytes))]))
        }
        if method == "POST", path.hasSuffix("/send"), let id = value?["id"]?.stringValue {
            accepted[id] = .object([
                "id": .string(id), "role": .string("user"), "createdAt": .number(1), "status": .string("pending"),
                "content": .array([.object(["type": .string("text"), "text": value?["text"] ?? .string("")])]),
            ])
        }
        return try response(200, .object([:]))
    }
    private func response(_ status: Int, _ value: JSONValue) throws -> DirectHTTPResponse {
        .init(status: status, body: try JSONEncoder().encode(value))
    }
    private func hash(_ bytes: Data) -> String { Hashing.sha256(bytes).map { String(format: "%02x", $0) }.joined() }
}

final class DirectAttachmentTests: XCTestCase {
    private let mode = AgentWire.Mode(providerId: "test", modelId: "model", effort: "high", serviceTier: nil, permissionMode: "auto")

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func file(_ bytes: Data, name: String = "recording.mov", directory: URL) throws -> DirectQueuedFile {
        let url = directory.appendingPathComponent(UUID().uuidString)
        try bytes.write(to: url)
        return DirectQueuedFile(fileURL: url, name: name, mimeType: "video/quicktime", size: bytes.count,
            path: ".happy-uploads/stable-message/\(DirectAttachmentRules.safeName(name))")
    }

    func testLostUploadAcknowledgementSurvivesReopenAndUsesCapturedWorkspace() async throws {
        let root = try directory()
        let bytes = Data([0, 1, 2, 255, 0, 10])
        let attachment = try file(bytes, directory: root)
        let server = AttachmentServer()
        await server.configure(lostAck: true)
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        let dbURL = root.appendingPathComponent("queue.sqlite")
        let first = try await Task.detached { try DirectSyncStorage(url: dbURL) }.value
        let message = DirectQueuedMessage(id: "stable-message", agentID: "recipient", text: "", pictures: [], mode: mode, files: [attachment])
        try await first.enqueueMessage(message)
        do {
            try await client.deliverMessage(message) { try await first.updateMessage($0) }
            XCTFail("Expected a lost upload acknowledgement")
        } catch is URLError {}
        try await first.close()

        await server.configure(workspace: "a-different-current-workspace")
        let reopened = try await Task.detached { try DirectSyncStorage(url: dbURL) }.value
        let restoredMessages = try await reopened.queuedMessages()
        let restored = try XCTUnwrap(restoredMessages.first)
        XCTAssertEqual(restored.workspaceID, "actual-execution-workspace")
        try await client.deliverMessage(restored) { try await reopened.updateMessage($0) }
        let requests = await server.saved()
        XCTAssertEqual(requests.filter { $0.0 == "GET" }.count, 1)
        XCTAssertEqual(requests.filter { $0.0 == "PUT" }.map(\.1), [
            "/v0/workspaces/actual-execution-workspace/file", "/v0/workspaces/actual-execution-workspace/file",
        ])
        XCTAssertEqual(requests.last?.1, "/v0/agents/recipient/send")
        XCTAssertEqual(requests.last?.2?["id"]?.stringValue, message.id)
        XCTAssertTrue(requests.last?.2?["text"]?.stringValue?.contains("./\(attachment.path)") == true)
        let stored = await server.bytes(attachment.path)
        XCTAssertEqual(stored, bytes)
        try await reopened.close()
    }

    func testPartialBatchNeverSendsTextAndResumeSkipsCompletedFile() async throws {
        let root = try directory()
        let one = try file(Data([1]), name: "first.pdf", directory: root)
        let two = try file(Data([2]), name: "second.mp4", directory: root)
        let server = AttachmentServer()
        await server.configure(reject: two.path)
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        let db = try await Task.detached { try DirectSyncStorage() }.value
        let message = DirectQueuedMessage(id: "stable-message", agentID: "recipient", text: "Review both", pictures: [], mode: mode, files: [one, two])
        try await db.enqueueMessage(message)
        do {
            try await client.deliverMessage(message) { try await db.updateMessage($0) }
            XCTFail("Expected the second file to be refused")
        } catch DirectAgentError.status(403, _, _) {}
        let failedRequests = await server.saved()
        XCTAssertFalse(failedRequests.contains { $0.1.hasSuffix("/send") })
        let restoredMessages = try await db.queuedMessages()
        let restored = try XCTUnwrap(restoredMessages.first)
        XCTAssertEqual(restored.files?.map(\.uploaded), [true, false])
        await server.configure()
        try await client.deliverMessage(restored) { try await db.updateMessage($0) }
        let requests = await server.saved()
        XCTAssertEqual(requests.filter { $0.2?["path"]?.stringValue == one.path }.count, 1)
        XCTAssertEqual(requests.filter { $0.1.hasSuffix("/send") }.count, 1)
        try await db.close()
    }

    func testCreateOnlyConflictNeverOverwritesDifferentBytesOrSends() async throws {
        let attachment = try file(Data([1]), directory: directory())
        let server = AttachmentServer()
        await server.occupy(attachment.path, bytes: Data([99]))
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        let message = DirectQueuedMessage(id: "stable-message", agentID: "recipient", text: "", pictures: [], mode: mode, files: [attachment])
        do {
            try await client.deliverMessage(message) { _ in }
            XCTFail("A different file must not be overwritten")
        } catch DirectAgentError.status(409, _, _) {}
        let stored = await server.bytes(attachment.path)
        let requests = await server.saved()
        XCTAssertEqual(stored, Data([99]))
        XCTAssertFalse(requests.contains { $0.1.hasSuffix("/send") })
    }

    func testStagingOwnsBytesAndEnforcesExactFiftyMiBLimit() throws {
        let root = try directory()
        let source = root.appendingPathComponent("source")
        FileManager.default.createFile(atPath: source.path, contents: nil)
        let handle = try FileHandle(forWritingTo: source)
        try handle.truncate(atOffset: UInt64(DirectAttachmentRules.maxFileBytes))
        try handle.close()
        let input = OutgoingAttachment(fileURL: source, name: "../folder\\..\nReport: Q1?<>\"|*.pdf. ", mimeType: "application/pdf", size: 0)
        let staged = try DirectAttachmentRules.stage([input], messageID: "stable-message", directory: root.appendingPathComponent("queue"))
        XCTAssertEqual(staged.first?.size, 50 * 1024 * 1024)
        XCTAssertEqual(staged.first?.path, ".happy-uploads/stable-message/0-Report_ Q1______.pdf")
        XCTAssertEqual(staged.first?.name, input.name)
        try FileManager.default.removeItem(at: source)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(staged.first).fileURL.path))

        FileManager.default.createFile(atPath: source.path, contents: nil)
        let oversized = try FileHandle(forWritingTo: source)
        try oversized.truncate(atOffset: UInt64(DirectAttachmentRules.maxFileBytes + 1))
        try oversized.close()
        XCTAssertThrowsError(try DirectAttachmentRules.stage([input], messageID: "different-message", directory: root))
    }

    func testOldPictureQueueDecodesAndLargePictureMovesToDirectFile() throws {
        let old = Data(#"{"id":"old-message","agentID":"recipient","text":"hello","pictures":[{"mimeType":"image/png","data":"AQID"}]}"#.utf8)
        var message = try JSONDecoder().decode(DirectQueuedMessage.self, from: old)
        XCTAssertNil(message.files)
        XCTAssertNil(message.workspaceID)
        XCTAssertEqual(message.pictures.first?.data, Data([1, 2, 3]))
        message.pictures = [.init(mimeType: "image/png", data: Data(repeating: 7, count: 6 * 1024 * 1024))]
        let migrated = try DirectAttachmentRules.migratePictures(message, directory: directory())
        XCTAssertTrue(migrated.pictures.isEmpty)
        XCTAssertEqual(migrated.files?.first?.size, 6 * 1024 * 1024)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(migrated.files?.first).fileURL), message.pictures.first?.data)
    }

    func testInlineImagePreservesSingleCaptionAndUsesPublicMimeTypeField() async throws {
        let server = AttachmentServer()
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        let caption = "Look here\n\nAttached file:\n- ./.happy-uploads/message/0-recording.mov"
        try await client.sendMessage("recipient", id: "cabcdefghijklmnopqrstuvw", text: caption, images: [("image/png", Data([1, 2, 3]))], mode: mode)
        let requests = await server.saved()
        let blocks = requests.last?.2?["content"]?.arrayValue
        XCTAssertEqual(requests.last?.2?["text"]?.stringValue, caption)
        XCTAssertEqual(requests.last?.2?["mode"]?["serviceTier"], .null)
        XCTAssertEqual(blocks?.count, 1)
        XCTAssertEqual(blocks?.last?["mimeType"]?.stringValue, "image/png")
        XCTAssertNil(blocks?.last?["mediaType"])
        try await client.sendMessage("recipient", id: "cbcdefghijklmnopqrstuvwx", text: "", images: [("image/png", Data([1]))], mode: mode)
        let imageOnly = await server.saved()
        XCTAssertEqual(imageOnly.last?.2?["text"]?.stringValue, "Attached image.")
        try await client.sendMessage("recipient", id: "ccdefghijklmnopqrstuvwxy", text: "Attached file:\n- ./.happy-uploads/message/0-recording.mov", images: [], mode: mode)
        do {
            try await client.sendMessage("recipient", id: "too-large", text: "", images: [("image/png", Data(repeating: 0, count: 5 * 1024 * 1024 + 1))], mode: mode)
            XCTFail("Oversized inline images must be staged as files")
        } catch DirectAgentError.status(400, _, _) {}
        let final = await server.saved()
        XCTAssertEqual(final.count, 3)
        XCTAssertNil(final.last?.2?["content"])
    }

    func testUnicodeFilenameFitsRealFilesystemByteLimit() throws {
        let root = try directory()
        let name = String(repeating: "漢", count: 85)
        let source = root.appendingPathComponent("picker-copy.pdf")
        try Data([1, 2, 3]).write(to: source)
        let staged = try DirectAttachmentRules.stage([
            .init(fileURL: source, name: name, mimeType: "application/pdf", size: 3),
        ], messageID: "unicode-message", directory: root.appendingPathComponent("queue"))
        let copy = try XCTUnwrap(staged.first)
        XCTAssertLessThanOrEqual(copy.fileURL.lastPathComponent.utf8.count, 255)
        XCTAssertEqual(try Data(contentsOf: copy.fileURL), Data([1, 2, 3]))
    }

    func testAcknowledgedSendKeepsBytesAcrossRestartUntilEchoCheckpoint() async throws {
        let root = try directory()
        let source = root.appendingPathComponent("source.pdf")
        try Data([0, 1, 2, 255]).write(to: source)
        let server = AttachmentServer()
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        let engine = DirectSyncEngine(client: client, directory: root.appendingPathComponent("account"))
        let conversation = StemCellConversation(client: client, store: engine.spaces, agentId: "recipient", mode: mode, persistence: engine)
        let saved = await conversation.send(id: "crash-window", text: "Review", attachments: [
            .init(fileURL: source, name: "source.pdf", mimeType: "application/pdf", size: 4),
        ])
        XCTAssertTrue(saved)
        await conversation.stop()
        try FileManager.default.removeItem(at: source)
        await engine.start()
        var drained = false
        for _ in 0..<200 {
            if try await engine.queuedMessages(for: "recipient").isEmpty { drained = true; break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(drained)
        await engine.stop()

        // Simulate death after queue ACK but before the conversation heard it.
        let reopened = DirectSyncEngine(client: client, directory: root.appendingPathComponent("account"))
        let stale = try await reopened.cachedResource("conversation:recipient")
        XCTAssertEqual(stale?["outgoing"]?.arrayValue?.first?["accepted"], .bool(false))
        let owned = engine.attachmentDirectory.appendingPathComponent("crash-window/0-source.pdf")
        XCTAssertEqual(try Data(contentsOf: owned), Data([0, 1, 2, 255]))

        // Restoring the daemon's echo replaces that stale outgoing descriptor.
        // Flush also waits for any older debounced checkpoint before cleanup.
        let restored = StemCellConversation(client: client, store: reopened.spaces, agentId: "recipient", persistence: reopened)
        await restored.start()
        var echoed = false
        for _ in 0..<200 {
            let kept = try await reopened.cachedResource("conversation:recipient")
            if kept?["outgoing"]?.arrayValue?.isEmpty == true { echoed = true; break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(echoed)
        await restored.stop()
        let checkpoint = try await reopened.cachedResource("conversation:recipient")
        XCTAssertEqual(checkpoint?["outgoing"], .array([]))
        XCTAssertNotNil(checkpoint?["messages"]?["crash-window"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: owned.path))
        let requests = await server.saved()
        XCTAssertEqual(requests.filter { $0.0 == "POST" && $0.1.hasSuffix("/send") }.count, 1)
        await reopened.stop()
    }

    func testLateOldConversationCannotRestoreDeletedFilesAndStillQueuesNewSends() async throws {
        let root = try directory()
        let source = root.appendingPathComponent("source.pdf")
        try Data([0, 1, 2, 255]).write(to: source)
        let attachment = OutgoingAttachment(fileURL: source, name: "source.pdf", mimeType: "application/pdf", size: 4)
        let server = AttachmentServer()
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        let engine = DirectSyncEngine(client: client, directory: root.appendingPathComponent("account"))
        let old = StemCellConversation(client: client, store: engine.spaces, agentId: "recipient", mode: mode, persistence: engine)
        let first = await old.send(id: "old-screen-send", text: "First", attachments: [attachment])
        XCTAssertTrue(first)

        let current = StemCellConversation(client: client, store: engine.spaces, agentId: "recipient", persistence: engine)
        await current.start()
        for _ in 0..<200 {
            if (await server.saved()).contains(where: { $0.1.hasSuffix("/bootstrap") }) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        // An active creation screen can coexist with a newer warm chat. Its
        // stale cache ownership must not stop new, durably queued user input.
        let second = await old.send(id: "active-screen-send", text: "Second", attachments: [attachment])
        XCTAssertTrue(second)
        let queued = try await engine.queuedMessages(for: "recipient")
        XCTAssertEqual(Set(queued.map(\.id)), ["old-screen-send", "active-screen-send"])

        await engine.start()
        for _ in 0..<200 {
            if try await engine.queuedMessages(for: "recipient").isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await engine.spaces.externalResync(loadSidebar: false)
        var echoed = false
        for _ in 0..<200 {
            let kept = try await engine.cachedResource("conversation:recipient")
            if kept?["outgoing"] == .array([]), kept?["messages"]?["active-screen-send"] != nil { echoed = true; break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(echoed)
        await current.stop()
        let firstCopy = engine.attachmentDirectory.appendingPathComponent("old-screen-send/0-source.pdf")
        let secondCopy = engine.attachmentDirectory.appendingPathComponent("active-screen-send/0-source.pdf")
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstCopy.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: secondCopy.path))

        // Release the old screen's deliberately held final flush only after
        // the newer instance committed its echoes and removed the bytes.
        await old.stop()
        let kept = try await engine.cachedResource("conversation:recipient")
        XCTAssertEqual(kept?["outgoing"], .array([]))
        XCTAssertNotNil(kept?["messages"]?["old-screen-send"])
        XCTAssertNotNil(kept?["messages"]?["active-screen-send"])
        await engine.stop()
    }

    func testWorstCaseFiftyMiBFileStaysInsideActualEncodedRequestLimit() async throws {
        let bytes = Data(repeating: 255, count: DirectAttachmentRules.maxFileBytes)
        let attachment = try file(bytes, directory: directory())
        let server = AttachmentServer()
        let client = DirectAgentClient(transport: server, token: "paired-device-token")
        try await client.uploadFile(attachment, workspaceID: "actual-execution-workspace")
        let sizes = await server.encodedUploadSizes()
        XCTAssertEqual(sizes.count, 1)
        XCTAssertLessThanOrEqual(try XCTUnwrap(sizes.first), 72 * 1024 * 1024)
        let decoded = await server.bytes(attachment.path)
        XCTAssertEqual(decoded, bytes)
    }
}