import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer with a Feed of references only: its bootstrap (`FeedFixture`)
/// can be changed and its events sent, as a rename on desktop does; the
/// todo, agent, people and artifact routes answer by ID, and every path
/// read is heard.
private actor FeedComputer: AgentTransport {
    var bootstrap: String = FeedFixture.bootstrap
    var feed: [JSONValue]
    var todos: [String: JSONValue] = [
        "s1/td1": ["id": "td1", "surfaceId": "s1", "text": "Buy milk", "status": "active", "version": "1"],
    ]
    var users: [String: JSONValue] = ["bo": ["id": "bo", "name": "Bo", "photo": .null]]
    var agents: [String: JSONValue] = ["far-agent": ["id": "far-agent", "workspaceId": "x", "title": "Deep subtask", "status": "idle"]]
    var requested: [String] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    init() {
        func item(_ n: Int, _ type: String, _ id: String, latest: JSONValue, actors: [JSONValue] = []) -> JSONValue {
            [
                "id": .string("item\(n)"), "version": .string("v\(n)"), "cursor": .string(String(format: "0199%08x-0000-7000-8000-000000000000", 100 - n)),
                "subject": ["type": .string(type), "id": .string(id)], "cluster": "team", "created": .bool(true), "updates": 1,
                "actors": .array(actors), "actorCount": .number(Double(actors.count)), "latest": latest,
                "firstAt": 1, "lastAt": .number(Double(1_000_000 - n)), "seenAt": .null,
            ]
        }
        feed = [
            item(1, "task", "t1", latest: ["type": "task.created"], actors: [["userId": "bo", "agentId": .null]]),
            item(2, "surface", "s1", latest: ["type": "todo.created", "todoId": "td1"], actors: [["userId": .null, "agentId": "far-agent"]]),
            item(3, "task", "t2", latest: ["type": "task.created"]),
            item(4, "bot", "research", latest: ["type": "bot.created"], actors: [["userId": "bo", "agentId": .null]]),
        ]
    }

    func setBootstrap(_ json: String) { bootstrap = json }
    func setTodo(_ key: String, _ value: JSONValue) { todos[key] = value }
    func setUser(_ id: String, _ value: JSONValue) { users[id] = value }
    func requestedPaths() -> [String] { requested }

    func emit(_ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }

    private func json(_ value: JSONValue) throws -> HTTP1Response { .init(status: 200, body: try JSONEncoder().encode(value)) }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requested.append(path)
        if path == "/v0/bootstrap/desktop" { return .init(status: 200, body: Data(bootstrap.utf8)) }
        if path == "/v0/health" { return try json(["ready": .bool(true), "capabilities": ["feed": .bool(true)]]) }
        if path.hasPrefix("/v0/feed?") { return try json(["items": .array(feed), "unread": 4, "hasMore": .bool(false), "cursor": "cursor-1"]) }
        if path.hasPrefix("/v0/artifacts?") { return try json(["artifacts": [], "nextPageCursor": .null]) }
        if path.hasPrefix("/v0/users?ids=") {
            let ids = path.dropFirst("/v0/users?ids=".count).split(separator: ",").map(String.init)
            return try json(["users": .array(ids.compactMap { users[$0] })])
        }
        if path.hasPrefix("/v0/agents/"), let agent = agents[String(path.dropFirst("/v0/agents/".count))] { return try json(["agent": agent]) }
        if path.hasPrefix("/v0/surfaces/todo/") {
            let key = path.dropFirst("/v0/surfaces/todo/".count)
            if let todo = todos[String(key)] { return try json(["todo": todo]) }
        }
        return .init(status: 404, body: Data(#"{"error":{"code":"not_found"}}"#.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

/// The Feed's rows are joined from the account's synced entities, so a
/// change to one of them reconfigures exactly the rows that show it, and
/// a change nothing in the feed shows reaches no row (AGENTS.md rule 8).
final class FeedChangesetTests: XCTestCase {
    private struct Timeout: Error {}

    /// The rows the Feed screen would draw from the engine's entries and
    /// directory as they are now, once `predicate` holds of them.
    private func rows(_ engine: SyncEngine, where predicate: @escaping @Sendable ([FeedRow], FeedDirectory) -> Bool = { _, _ in true }) async throws -> [FeedRow] {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            var directories = await engine.feedDirectories().makeAsyncIterator()
            guard let directory = await directories.next() else { break }
            let state = await engine.feed.current
            let rows = FeedRows.make(state.items, unread: state.isUnread, directory: directory, personSeed: "p")
            if predicate(rows, directory) { return rows }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw Timeout()
    }

    private func rows(_ engine: SyncEngine, _ predicate: @escaping @Sendable ([FeedRow]) -> Bool) async throws -> [FeedRow] {
        try await rows(engine) { rows, _ in predicate(rows) }
    }

    private func start() async throws -> (FeedComputer, SyncEngine, [FeedRow]) {
        let computer = FeedComputer()
        let engine = SyncEngine(client: AgentClient(transport: computer, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        // Every entry resolved, the newest todo's text and the people read.
        let rows = try await rows(engine) { rows in
            rows.count == 4 && rows.contains { $0.detail == "Buy milk" } && rows.contains { $0.actorNames == [.named("Bo")] }
                && rows.contains { $0.actorNames == [.named("Deep subtask")] }
        }
        return (computer, engine, rows)
    }

    /// A task renamed on desktop (its name was "New Task" when the entry
    /// was made): the bootstrap read after `task.updated` brings the name,
    /// and exactly its row is reconfigured.
    func testATaskRenameReconfiguresExactlyThatRow() async throws {
        let (computer, engine, before) = try await start()
        XCTAssertEqual(before.map(\.title), ["Ship the feed", "Groceries", "Fix login", "Research"])
        await computer.setBootstrap(FeedFixture.bootstrap.replacingOccurrences(of: #""name":"Ship the feed""#, with: #""name":"Ship the references""#))
        await computer.emit(["type": "task.updated", "cursor": "e2", "payload": ["taskId": "t1", "changes": ["name": "Ship the references"]]])
        let after = try await rows(engine) { $0.first?.title == "Ship the references" }
        let changes = RowChangeset(from: before, to: after, id: \.id)
        XCTAssertEqual(changes, RowChangeset(reconfigures: [0]))
        XCTAssertEqual(after[0].target, .chat(agentId: "t1-agent", title: "Ship the references"), "it opens under its name too")
        await engine.stop()
    }

    /// A task the feed doesn't show, renamed: the directory changes, no row does.
    func testARenameNoRowShowsTouchesNoRow() async throws {
        let (computer, engine, before) = try await start()
        await computer.setBootstrap(FeedFixture.bootstrap.replacingOccurrences(of: #""name":"Not in the feed""#, with: #""name":"Still not in it""#))
        await computer.emit(["type": "task.updated", "cursor": "e2", "payload": ["taskId": "t3", "changes": ["name": "Still not in it"]]])
        let after = try await rows(engine) { _, directory in directory.tasks["t3"]?.name == "Still not in it" }
        XCTAssertEqual(RowChangeset(from: before, to: after, id: \.id), RowChangeset())
        await engine.stop()
    }

    /// A new bot picture redraws the bot's row and nothing else.
    func testAPictureChangeReconfiguresExactlyThatRow() async throws {
        let (computer, engine, before) = try await start()
        await computer.setBootstrap(FeedFixture.bootstrap.replacingOccurrences(of: #""avatar":{"thumbhash":"bot-th"}"#, with: #""avatar":{"thumbhash":"bot-th-2"}"#))
        await computer.emit(["type": "bot.updated", "cursor": "e2", "payload": ["botId": "research", "changes": ["avatar": ["thumbhash": "bot-th-2"]]]])
        let after = try await rows(engine) { $0.last?.face == .mark(.image(path: "/v0/bots/research/avatar", thumbhash: "bot-th-2"), round: false) }
        XCTAssertEqual(RowChangeset(from: before, to: after, id: \.id), RowChangeset(reconfigures: [3]))
        await engine.stop()
    }

    /// The todo an entry names is edited: its row says the new words.
    func testATodoEditReconfiguresExactlyItsRow() async throws {
        let (computer, engine, before) = try await start()
        await computer.setTodo("s1/td1", ["id": "td1", "surfaceId": "s1", "text": "Buy oat milk", "status": "active", "version": "2"])
        await computer.emit(["type": "todo.updated", "cursor": "e2", "payload": ["surfaceId": "s1", "todoId": "td1", "changes": ["text": "Buy oat milk"]]])
        let after = try await rows(engine) { $0.contains { $0.detail == "Buy oat milk" } }
        XCTAssertEqual(RowChangeset(from: before, to: after, id: \.id), RowChangeset(reconfigures: [1]))
        await engine.stop()
    }

    /// A person renamed (`profile.updated`): the rows crediting them.
    func testAPersonRenamedReconfiguresTheRowsCreditingThem() async throws {
        let (computer, engine, before) = try await start()
        await computer.setUser("bo", ["id": "bo", "name": "Bo Diddley", "photo": .null])
        await computer.emit(["type": "profile.updated", "cursor": "e2", "payload": ["userId": "bo"]])
        let after = try await rows(engine) { $0.first?.actorNames == [.named("Bo Diddley")] }
        XCTAssertEqual(RowChangeset(from: before, to: after, id: \.id), RowChangeset(reconfigures: [0, 3]))
        await engine.stop()
    }

    /// What the Feed names is read by ID once, and only what the bootstrap
    /// lacks: no task, bot or Surface is ever asked for.
    func testOnlyWhatTheBootstrapLacksIsRead() async throws {
        let (computer, engine, _) = try await start()
        let paths = await computer.requestedPaths()
        XCTAssertEqual(paths.filter { $0.hasPrefix("/v0/agents/") && !$0.dropFirst("/v0/agents/".count).contains("/") }, ["/v0/agents/far-agent"])
        XCTAssertEqual(paths.filter { $0.hasPrefix("/v0/surfaces/todo/") }, ["/v0/surfaces/todo/s1/td1"])
        XCTAssertFalse(paths.contains { $0.hasPrefix("/v0/tasks/") || $0.hasPrefix("/v0/bots/") })
        await engine.stop()
    }
}
