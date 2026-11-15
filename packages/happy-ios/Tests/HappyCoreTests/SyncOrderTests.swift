import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

/// A computer that writes down every request in the order it arrives, and
/// when it answered home's bootstrap. It serves one chat, "s"; anything
/// else is a 404, written down all the same.
private actor OrderServer: AgentTransport {
    static let health: JSONValue = ["ready": .bool(true), "version": ["protocol": 37], "instanceId": "k3x9q2m7p0a4b8c1d5e6f7g2",
                                    "capabilities": ["feed": .bool(true), "sidebarOperations": .bool(false)]]
    var log: [String] = []
    /// Whether the bootstrap carries `health` and `config`.
    var carries = true

    /// Home's bootstrap is held unanswered until `answer`.
    var holding = false
    var held: [CheckedContinuation<Void, Never>] = []

    /// The chat's history is held unanswered until `answerChat`.
    var holdingChat = false
    var heldChat: [CheckedContinuation<Void, Never>] = []

    func setCarries(_ carries: Bool) { self.carries = carries }
    func holdChat() { holdingChat = true }
    func answerChat() { holdingChat = false; heldChat.forEach { $0.resume() }; heldChat = [] }
    func hold() { holding = true }
    func answer() { holding = false; held.forEach { $0.resume() }; held = [] }
    func requests() -> [String] { log }
    func clear() { log = [] }

    private let cursor = "c0001"

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers, category: .query)
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
        let route = method + " " + (path.split(separator: "?").first.map(String.init) ?? path)
        log.append(category == .file ? route + " (file)" : route)
        let value: JSONValue
        switch route {
        case "GET /v0/bootstrap/desktop":
            var bootstrap: [String: JSONValue] = [
                "cursor": .string(cursor), "profile": ["userId": .null], "userSettings": [], "feedUnread": 0,
                "projects": [["id": "p", "name": "App", "status": "active", "orderKey": "a",
                              "agents": [["id": "s", "workspaceId": "p", "title": "Chat", "status": "idle", "version": "v0001"]]]],
                "workspaces": [],
            ]
            if holding { await withCheckedContinuation { held.append($0) } }
            if carries {
                bootstrap["health"] = Self.health
                bootstrap["config"] = ["node": ["name": "Studio", "avatar": ["thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI"]]]
            }
            value = .object(bootstrap)
            log.append("answered " + route)
        case "GET /v0/health":
            value = Self.health
        case "GET /v0/config":
            value = ["config": ["node": ["name": "Paired name", "avatar": ["thumbhash": "paired"]]]]
        case "GET /v0/node/avatar":
            return .init(status: 200, headers: ["content-type": "image/png", "etag": "\"v1\""], body: Data([1, 2, 3]))
        case "GET /v0/agents/s/bootstrap":
            value = ["agent": ["id": "s", "workspaceId": "p", "status": "idle"], "pending": [], "cursor": .string(cursor),
                     "mode": ["providerId": "claude", "modelId": "anthropic/sonnet-5", "effort": "medium", "permissionMode": "auto"]]
        case "GET /v0/agents/s/messages":
            if holdingChat { await withCheckedContinuation { heldChat.append($0) } }
            value = ["cursor": .string(cursor), "hasMore": .bool(false), "runs": [[
                "id": "r1", "status": "completed", "startedAt": 1, "endedAt": 2,
                "messages": [["id": "a1", "role": "agent", "createdAt": 1, "metadata": [:], "content": [["type": "text", "text": "hello"]]]],
            ]]]
        default:
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        log.append("GET " + path)
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"\(cursor)\",\"resumed\":false,\"gap\":false,\"daemonId\":\"d1\"}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() {}
}

/// The order a connect asks the computer in (the sync order contract):
/// the stream, then the chat on screen, then home's bootstrap; what waits
/// for the computer's owner to be checked only after home's answer.
final class SyncOrderTests: XCTestCase {
    private func folder() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("sync-order-\(UUID().uuidString)") }

    private func eventually(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<250 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("not in time: \(what)", file: file, line: line)
    }

    /// Everything that waits for home has gone out, and a moment more
    /// for anything that shouldn't.
    private func settled(_ server: OrderServer, file: StaticString = #filePath, line: UInt = #line) async throws {
        try await eventually("what waits for home asked", file: file, line: line) {
            Self.waitsForHome.subtracting(["GET /v0/users"]).isSubset(of: Set(await server.requests()))
        }
        try await Task.sleep(for: .milliseconds(300))
    }

    /// What went before home's bootstrap was answered, and after it.
    private static func split(_ log: [String]) -> (before: [String], after: [String]) {
        guard let answered = log.firstIndex(of: "answered GET /v0/bootstrap/desktop") else { return (log, []) }
        return (Array(log[..<answered]), Array(log[(answered + 1)...]))
    }

    /// What the bootstrap already carries (`health`, `config.node`).
    private static let identity: Set<String> = ["GET /v0/health", "GET /v0/config"]

    /// What waits for home's owner to be checked (P2).
    private static let waitsForHome: Set<String> = ["GET /v0/artifacts", "GET /v0/feed", "POST /v0/git/watch", "GET /v0/users"]

    func testWhatWaitsForHomeIsAskedAfterItsBootstrap() async throws {
        let server = OrderServer()
        let engine = SyncEngine(client: AgentClient(transport: server, token: "t"), directory: folder(), resumeWindow: .zero)
        await server.hold()
        await engine.start()
        try await eventually("home asked") { await server.requests().contains("GET /v0/bootstrap/desktop") }
        try await Task.sleep(for: .milliseconds(300))
        let unanswered = await server.requests()
        XCTAssertEqual(unanswered.filter(Self.waitsForHome.contains), [], "asked before home was verified")
        await server.answer()
        try await settled(server)
        let log = await server.requests()
        print("SYNC_ORDER home cold launch: \(log)")
        let (before, after) = Self.split(log)
        XCTAssertEqual(before.filter(Self.waitsForHome.contains), [])
        XCTAssertEqual(after.filter(Self.waitsForHome.contains).sorted(), ["GET /v0/artifacts", "GET /v0/feed", "POST /v0/git/watch"])
        XCTAssertEqual(log.filter(Self.identity.contains), [], "health and identity come with the bootstrap")

        // Back after longer than the resume window: from now, the same order.
        await engine.pause()
        await server.clear()
        await server.hold()
        await engine.start()
        try await eventually("home asked again") { await server.requests().contains("GET /v0/bootstrap/desktop") }
        try await Task.sleep(for: .milliseconds(300))
        let unansweredAgain = await server.requests()
        XCTAssertEqual(unansweredAgain.filter(Self.waitsForHome.contains), [], "asked before home was verified again")
        await server.answer()
        try await settled(server)
        let again = await server.requests()
        print("SYNC_ORDER home reconnect: \(again)")
        let (beforeAgain, afterAgain) = Self.split(again)
        XCTAssertEqual(beforeAgain.filter(Self.waitsForHome.contains), [])
        XCTAssertEqual(afterAgain.filter(Self.waitsForHome.contains).sorted(), ["GET /v0/artifacts", "GET /v0/feed", "POST /v0/git/watch"])
        XCTAssertEqual(again.filter(Self.identity.contains), [], "health and identity come with the bootstrap again")
        await engine.stop()
    }

    /// A launch straight into a chat (a link, a push): the stream, then the
    /// chat's two reads, then home's bootstrap, and the chat read once.
    func testAColdLaunchIntoAChatAsksTheStreamThenTheChatThenHome() async throws {
        let server = OrderServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        // Opened before the engine has read what this phone keeps.
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s", persistence: engine)
        let shown = Shown()
        let updates = conversation.updates
        Task { for await snapshot in updates { shown.set(snapshot) } }
        await conversation.start()
        await conversation.setVisible(true)
        await engine.start()
        try await eventually("the chat read") { shown.snapshot.synced }
        try await settled(server)
        let log = await server.requests()
        print("SYNC_ORDER chat cold launch: \(log)")
        // Home is asked once the chat's reads have been (`Store.chatOpening`);
        // the three then race to the computer, so their order is not asserted.
        let p0: Set = ["GET /v0/events/stream", "GET /v0/agents/s/bootstrap", "GET /v0/agents/s/messages", "GET /v0/bootstrap/desktop"]
        let asked = log.filter(p0.contains)
        XCTAssertEqual(asked.first, "GET /v0/events/stream")
        XCTAssertEqual(asked.dropFirst().sorted(), ["GET /v0/agents/s/bootstrap", "GET /v0/agents/s/messages", "GET /v0/bootstrap/desktop"])
        XCTAssertEqual(log.filter { $0 == "GET /v0/agents/s/messages" }.count, 1)
        let (before, after) = Self.split(log)
        XCTAssertEqual(before.filter(Self.waitsForHome.contains), [])
        XCTAssertEqual(after.filter(Self.waitsForHome.contains).sorted(), ["GET /v0/artifacts", "GET /v0/feed", "POST /v0/git/watch"])
        XCTAssertEqual(log.filter(Self.identity.contains), [])
        await conversation.stop()
        await engine.stop()
    }

    /// Home verified while the chat on screen is still being read: what
    /// waits for home waits for the chat too, and the chat never waits for
    /// home.
    func testWhatWaitsForHomeWaitsForTheChatOnScreen() async throws {
        let server = OrderServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await server.holdChat()
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s", persistence: engine)
        let shown = Shown()
        let updates = conversation.updates
        Task { for await snapshot in updates { shown.set(snapshot) } }
        await conversation.start()
        await conversation.setVisible(true)
        await engine.start()
        try await eventually("home verified") { let home = await Self.home(engine); return home.live && !home.syncing }
        try await Task.sleep(for: .milliseconds(300))
        let reading = await server.requests()
        XCTAssertEqual(reading.filter(Self.waitsForHome.contains), [], "asked beside the chat's read")
        await server.answerChat()
        try await eventually("the chat read") { shown.snapshot.synced }
        try await settled(server)
        let log = await server.requests()
        let landed = log.firstIndex(of: "GET /v0/agents/s/messages")!
        XCTAssertEqual(log[..<landed].filter(Self.waitsForHome.contains), [])
        XCTAssertEqual(log.filter(Self.waitsForHome.contains).sorted(), ["GET /v0/artifacts", "GET /v0/feed", "POST /v0/git/watch"])
        await conversation.stop()
        await engine.stop()
    }

    /// The chat on screen is current with home's bootstrap still unanswered.
    func testTheChatIsCurrentWithHomesBootstrapHeld() async throws {
        let server = OrderServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await server.hold()
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s", persistence: engine)
        let shown = Shown()
        let updates = conversation.updates
        Task { for await snapshot in updates { shown.set(snapshot) } }
        await conversation.start()
        await conversation.setVisible(true)
        await engine.start()
        try await eventually("the chat current") { shown.snapshot.synced && shown.snapshot.loaded }
        let log = await server.requests()
        XCTAssertFalse(log.contains("answered GET /v0/bootstrap/desktop"))
        XCTAssertEqual(log.filter { $0 == "GET /v0/agents/s/messages" }.count, 1)
        await server.answer()
        await conversation.stop()
        await engine.stop()
    }

    private static func home(_ engine: SyncEngine) async -> HomeSnapshot {
        var iterator = await engine.snapshots().makeAsyncIterator()
        return await iterator.next()!
    }

    private final class Shown: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ChatSnapshot()
        var snapshot: ChatSnapshot { lock.withLock { value } }
        func set(_ snapshot: ChatSnapshot) { lock.withLock { value = snapshot } }
    }

    /// A bootstrap without `health` (Happy Cloud's, for now) serves
    /// nothing optional: no Feed, and nobody asks `/v0/health` instead.
    func testABootstrapWithoutHealthServesNothingOptional() async throws {
        let server = OrderServer()
        await server.setCarries(false)
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        try await eventually("home asked") { await server.requests().contains("GET /v0/artifacts") }
        let health = try await client.health()
        XCTAssertNil(health.capabilities)
        let search = try await client.servesSearch()
        XCTAssertFalse(search)
        try await Task.sleep(for: .milliseconds(300))
        let log = await server.requests()
        XCTAssertEqual(log.filter { $0 == "GET /v0/health" || $0 == "GET /v0/feed" }, [])
        await engine.stop()
    }

    /// A cold launch with a paired computer open: its connection's name
    /// and picture come from the bootstrap, never an identity check, and
    /// the picture's bytes are read once, after home, on a file client,
    /// because its ThumbHash changed.
    @MainActor
    func testTheOpenComputersIdentityComesWithItsBootstrap() async throws {
        let server = OrderServer()
        let store = InMemoryAgentConnectionCredentialStore()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sync-order-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let paired = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in server })
        await paired.setForeground(false)
        let credentials = AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: "device", deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
        let account = try await paired.add(credentials, name: "Mac")
        XCTAssertEqual(account.name, "Paired name")

        await server.clear()
        let launched = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in server })
        try await launched.restore()
        let engine = try XCTUnwrap(launched.syncEngine(for: account.id))
        for _ in 0..<250 where launched.accounts.first?.name != "Studio" || launched.accounts.first?.avatar != Data([1, 2, 3]) {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(launched.accounts.first?.name, "Studio")
        XCTAssertEqual(launched.accounts.first?.avatar, Data([1, 2, 3]))
        try await Task.sleep(for: .milliseconds(300))
        let log = await server.requests()
        print("SYNC_ORDER identity cold launch: \(log)")
        XCTAssertEqual(log.filter(Self.identity.contains), [])
        let (_, after) = Self.split(log)
        XCTAssertEqual(after.filter { $0.contains("/v0/node/avatar") }, ["GET /v0/node/avatar (file)"])
        XCTAssertEqual(launched.accounts.first?.status, .connected)
        XCTAssertEqual(launched.accounts.first?.thumbhash, "1QcSHQRnh493V4dIh4eXh1h4kJUI")
        XCTAssertEqual(launched.accounts.first?.instanceId, "k3x9q2m7p0a4b8c1d5e6f7g2")
        await engine.stop()
        await launched.setForeground(false)
    }
}
