import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// Compose opens a task that nothing exists of yet: opening it, typing in
/// it and leaving it ask nothing of the computer, and its first message
/// makes the task, once, before it goes into it (`NewTask`).
final class NewTaskTests: XCTestCase {
    private let mode = AgentWire.Mode(providerId: "p", modelId: "m", effort: "medium", serviceTier: nil, permissionMode: "default")

    private func conversation(_ computer: TaskComputer, _ task: NewTask) -> (Conversation, Store) {
        let client = AgentClient(transport: computer, token: "t")
        let store = Store(client: client)
        return (Conversation(client: client, store: store, agentId: task.agentId, newTask: task, mode: mode), store)
    }

    /// Opened, typed in and left: the computer hears nothing. Compose
    /// again opens the same task, with what was typed.
    func testOpeningTypingAndLeavingMakeNothing() async throws {
        let computer = TaskComputer()
        let store = Store(client: AgentClient(transport: computer, token: "t"))
        let task = await store.newTask()
        let drafts = Drafts(offline: nil)
        let (chat, _) = conversation(computer, task)
        await chat.start()
        await chat.useDrafts(drafts)
        await chat.setDraft("Half a thought", at: Date().timeIntervalSince1970 * 1000)
        await chat.flushDraft()
        try await Task.sleep(for: .milliseconds(500))
        await chat.stop()

        let writes = await computer.writes.map(\.path)
        XCTAssertEqual(writes, [], "opening a new task asked the computer for something")
        let made = await task.isMade
        XCTAssertFalse(made)

        let again = await store.newTask()
        XCTAssertTrue(again === task, "compose again opened another task")
        let (reopened, _) = conversation(computer, again)
        var updates = reopened.updates.makeAsyncIterator()
        await reopened.start()
        await reopened.useDrafts(drafts)
        var shown = ""
        while shown.isEmpty, let snapshot = await updates.next() {
            if snapshot.localDraftLoaded { shown = snapshot.draft ?? "" ; break }
        }
        XCTAssertEqual(shown, "Half a thought", "what was typed didn't come back")
        await reopened.stop()
        let after = await computer.writes.map(\.path)
        XCTAssertEqual(after, [])
    }

    /// The first message makes the task, once, even sent twice at once,
    /// and then goes into it; the next compose opens a new task.
    func testTheFirstSendMakesExactlyOneTaskThenGoesIntoIt() async throws {
        let computer = TaskComputer()
        let store = Store(client: AgentClient(transport: computer, token: "t"))
        let task = await store.newTask()
        let (chat, _) = conversation(computer, task)
        await chat.start()

        await computer.holdCreates()
        async let first = chat.send(id: "m1", text: "Audit the billing exports")
        async let second = chat.send(id: "m2", text: "and the refunds")
        try await Task.sleep(for: .milliseconds(200))
        await computer.releaseCreates()
        let (one, two) = await (first, second)
        XCTAssertTrue(one)
        XCTAssertTrue(two)

        let agentId = task.agentId
        var writes = await computer.writes
        for _ in 0..<100 where writes.filter({ $0.path.hasSuffix("/send") }).count < 2 {
            try await Task.sleep(for: .milliseconds(20))
            writes = await computer.writes
        }
        let creates = writes.filter { $0.path == "/v0/tasks" }
        XCTAssertEqual(creates.count, 1, "the task was made more than once")
        XCTAssertEqual(creates.first?.method, "POST")
        XCTAssertEqual(creates.first?.body?["id"]?.stringValue, task.identity.taskId)
        XCTAssertEqual(creates.first?.body?["agentId"]?.stringValue, agentId)
        XCTAssertEqual(creates.first?.body?["workspaceId"]?.stringValue, task.identity.workspaceId)
        XCTAssertNil(creates.first?.body?["name"], "the task was named here: its first message names it")
        let sends = writes.filter { $0.path.hasSuffix("/send") }
        XCTAssertEqual(sends.map(\.path), ["/v0/agents/\(agentId)/send", "/v0/agents/\(agentId)/send"])
        XCTAssertEqual(Set(sends.compactMap { $0.body?["id"]?.stringValue }), ["m1", "m2"])
        XCTAssertEqual(writes.first?.path, "/v0/tasks", "a message went before its task was made")

        let made = try await task.make()
        XCTAssertEqual(made, agentId)
        let creates2 = await computer.writes.filter { $0.path == "/v0/tasks" }.count
        XCTAssertEqual(creates2, 1, "asking again after it was made made it again")
        let next = await store.newTask()
        XCTAssertFalse(next === task, "compose after the first message opened the made task")
        await chat.stop()
    }

    /// A refused make draws nothing and sends nothing, says why, and the
    /// next send asks again under the same names.
    func testARefusedMakeDrawsNothingAndTriesAgainUnderTheSameNames() async throws {
        let computer = TaskComputer()
        let store = Store(client: AgentClient(transport: computer, token: "t"))
        let task = await store.newTask()
        let (chat, _) = conversation(computer, task)
        await chat.start()

        await computer.refuseCreates(409, "No room for another task")
        let refused = await chat.send(id: "m1", text: "Audit the billing exports")
        XCTAssertFalse(refused)
        let reason = await chat.sendRefusal
        XCTAssertEqual(reason, "No room for another task")
        var writes = await computer.writes
        XCTAssertEqual(writes.map(\.path), ["/v0/tasks"])
        let made = await task.isMade
        XCTAssertFalse(made)

        await computer.refuseCreates(nil, nil)
        let sent = await chat.send(id: "m2", text: "Audit the billing exports")
        XCTAssertTrue(sent)
        let cleared = await chat.sendRefusal
        XCTAssertNil(cleared)
        for _ in 0..<100 where !writes.contains(where: { $0.path.hasSuffix("/send") }) {
            try await Task.sleep(for: .milliseconds(20))
            writes = await computer.writes
        }
        let creates = writes.filter { $0.path == "/v0/tasks" }
        XCTAssertEqual(creates.count, 2)
        XCTAssertEqual(creates[0].body, creates[1].body, "the retry named another task")
        XCTAssertEqual(writes.filter { $0.path.hasSuffix("/send") }.compactMap { $0.body?["id"]?.stringValue }, ["m2"], "the refused message was sent")
        await chat.stop()
    }
}

/// A computer that makes tasks under the names it is given and takes
/// messages; `holdCreates` keeps a make waiting, `refuseCreates` refuses it.
private actor TaskComputer: AgentTransport {
    struct Write: Sendable { let method: String; let path: String; let body: JSONValue? }
    private(set) var writes: [Write] = []
    private var holding = false
    private var held: [CheckedContinuation<Void, Never>] = []
    private var refusal: (status: Int, error: String?)?

    func holdCreates() { holding = true }

    func releaseCreates() {
        holding = false
        for waiter in held { waiter.resume() }
        held = []
    }

    func refuseCreates(_ status: Int?, _ error: String?) {
        refusal = status.map { ($0, error) }
    }

    nonisolated func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await respond(method, path, body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) })
    }

    private func respond(_ method: String, _ path: String, _ body: JSONValue?) async throws -> HTTP1Response {
        func json(_ value: JSONValue, status: Int = 200) throws -> HTTP1Response {
            HTTP1Response(status: status, body: try JSONEncoder().encode(value))
        }
        if method != "GET" { writes.append(Write(method: method, path: path, body: body)) }
        switch (method, path.split(separator: "?").first.map(String.init) ?? path) {
        case ("POST", "/v0/tasks"):
            if holding { await withCheckedContinuation { held.append($0) } }
            if let refusal { return try json(.object(["error": refusal.error.map(JSONValue.string) ?? .null]), status: refusal.status) }
            let agentId = body?["agentId"] ?? .string("given")
            return try json(.object([
                "task": .object(["id": body?["id"] ?? .null, "name": .string("New Task"), "agent": .object(["id": agentId, "workspaceId": body?["workspaceId"] ?? .null])]),
                "membership": .object(["taskId": body?["id"] ?? .null]),
            ]))
        case (_, let route) where route.hasSuffix("/messages"):
            return try json(.object(["runs": .array([]), "hasMore": .bool(false)]))
        case (_, let route) where route.hasSuffix("/bootstrap"):
            return try json(.object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])]))
        case ("POST", let route) where route.hasSuffix("/send"):
            return try json(.object([:]))
        default:
            return try json(.object(["error": .string("Not here.")]), status: 404)
        }
    }

    nonisolated func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
    nonisolated func reset() async {}
    nonisolated func close() async {}
}
