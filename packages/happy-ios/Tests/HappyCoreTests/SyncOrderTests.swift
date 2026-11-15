import Foundation
import XCTest
@testable import HappyCore
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

    func setCarries(_ carries: Bool) { self.carries = carries }
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
        case "GET /v0/agents/s/bootstrap":
            value = ["agent": ["id": "s", "workspaceId": "p", "status": "idle"], "pending": [], "cursor": .string(cursor),
                     "mode": ["providerId": "claude", "modelId": "anthropic/sonnet-5", "effort": "medium", "permissionMode": "auto"]]
        case "GET /v0/agents/s/messages":
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
        await engine.stop()
    }
}
