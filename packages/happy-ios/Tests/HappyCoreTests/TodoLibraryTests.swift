import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer's todo routes as API.md has them: versions on every change,
/// `If-Match` checked, a repeated creation ID answered with the first
/// todo, new todos first. It can be taken away, and every write is heard.
actor FakeTodoServer: TodoRoutes {
    struct Write: Equatable { var method: String; var todoId: String; var mutationId: String; var body: String }
    private(set) var todos: [String: TodoItem] = [:]
    private(set) var writes: [Write] = []
    private(set) var reads = 0
    var away = false
    var refuseText: String?
    private var counter = 0
    let surfaceId: String

    init(surfaceId: String) { self.surfaceId = surfaceId }

    func setAway(_ away: Bool) { self.away = away }
    func refuse(text: String?) { refuseText = text }

    private func version() -> String { counter += 1; return String(format: "v%06d", counter) }
    private func reachable() throws { if away { throw URLError(.cannotConnectToHost) } }
    private func active() -> [TodoItem] { todos.values.filter { $0.status == .active }.sorted(by: TodoOrder.active) }

    /// A change someone else made, as the computer records it.
    @discardableResult
    func elsewhere(_ id: String, _ change: (inout TodoItem) -> Void) -> TodoItem {
        var todo = todos[id]!
        change(&todo)
        todo.version = version()
        todos[id] = todo
        return todo
    }

    @discardableResult
    func seed(_ id: String, _ text: String, status: TodoItem.Status = .active, author: String? = nil) -> TodoItem {
        let key = status == .active ? TodoOrder.key(between: active().last?.orderKey, and: nil) : nil
        let todo = TodoItem(id: id, surfaceId: surfaceId, authorUserId: author, text: text, status: status, orderKey: key, createdAt: 1, updatedAt: 1,
                            completedAt: status == .completed ? 5 : nil, deletedAt: status == .deleted ? 6 : nil, version: version())
        todos[id] = todo
        return todo
    }

    func todos(_ surfaceId: String, scope: TodoItem.Status) async throws -> [TodoItem] {
        try reachable()
        reads += 1
        return todos.values.filter { $0.status == scope }
    }

    func todo(_ surfaceId: String, _ todoId: String) async throws -> TodoItem {
        try reachable()
        guard let todo = todos[todoId] else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        return todo
    }

    func createTodo(_ surfaceId: String, id: String, text: String, mutationId: String) async throws -> TodoItem {
        try reachable()
        writes.append(Write(method: "POST", todoId: id, mutationId: mutationId, body: text))
        if let held = todos[id] { return held }
        let todo = TodoItem(id: id, surfaceId: surfaceId, text: text, orderKey: TodoOrder.key(between: nil, and: active().first?.orderKey), createdAt: 2, updatedAt: 2, version: version())
        todos[id] = todo
        return todo
    }

    private func check(_ todoId: String, _ ifMatch: String) throws -> TodoItem {
        guard let todo = todos[todoId] else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        guard todo.version == ifMatch else { throw AgentClientError.status(409, code: "conflict", message: "Stale version") }
        return todo
    }

    func updateTodo(_ surfaceId: String, _ todoId: String, text: String?, status: TodoItem.Status?, ifMatch: String, mutationId: String) async throws -> TodoItem {
        try reachable()
        writes.append(Write(method: "PATCH", todoId: todoId, mutationId: mutationId, body: text ?? status?.rawValue ?? ""))
        if let refuseText, text == refuseText { throw AgentClientError.status(400, code: "invalid_request", message: "That text isn't allowed") }
        var todo = try check(todoId, ifMatch)
        if let text { todo.text = text }
        if let status, status != todo.status {
            switch status {
            case .active: todo.status = .active; todo.completedAt = nil; todo.deletedAt = nil; todo.orderKey = TodoOrder.key(between: active().last?.orderKey, and: nil)
            case .completed: todo.status = .completed; todo.completedAt = 9; todo.deletedAt = nil; todo.orderKey = nil
            case .deleted: todo.status = .deleted; todo.deletedAt = 9; todo.orderKey = nil
            }
        }
        todo.version = version()
        todos[todoId] = todo
        return todo
    }

    func deleteTodo(_ surfaceId: String, _ todoId: String, ifMatch: String, mutationId: String) async throws -> TodoItem {
        try reachable()
        writes.append(Write(method: "DELETE", todoId: todoId, mutationId: mutationId, body: ""))
        var todo = try check(todoId, ifMatch)
        guard todo.status != .deleted else { return todo }
        todo.status = .deleted; todo.deletedAt = 9; todo.orderKey = nil
        todo.version = version()
        todos[todoId] = todo
        return todo
    }

    func reorderTodo(_ surfaceId: String, _ todoId: String, afterId: String?, ifMatch: String, mutationId: String) async throws -> TodoItem {
        try reachable()
        writes.append(Write(method: "REORDER", todoId: todoId, mutationId: mutationId, body: afterId ?? "first"))
        var todo = try check(todoId, ifMatch)
        let rest = active().filter { $0.id != todoId }
        let index = afterId.flatMap { id in rest.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
        todo.orderKey = TodoOrder.key(between: index > 0 ? rest[index - 1].orderKey : nil, and: index < rest.count ? rest[index].orderKey : nil)
        todo.version = version()
        todos[todoId] = todo
        return todo
    }

    func todoVersions(_ surfaceId: String, _ todoId: String) async throws -> [TodoRevision] { [] }

    func teamUsers(_ ids: [String]) async throws -> [TeamUser] { ids.map { TeamUser(id: $0, name: "Person \($0)") } }
}

/// What a library keeps between launches, as the account's checkpoints do.
actor MemoryTodoKeep: TodoKeep {
    private(set) var values: [String: JSONValue] = [:]
    func read(_ key: String) async -> JSONValue? { values[key] }
    func write(_ key: String, _ value: JSONValue) async { values[key] = value }
}

final class TodoLibraryTests: XCTestCase {
    private let surfaceId = "s0000000000000000000000a"

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var ms: Int64 = 1_000_000
        func now() -> Int64 { lock.lock(); defer { lock.unlock() }; return ms }
        func advance(_ duration: Duration) {
            lock.lock(); defer { lock.unlock() }
            ms += Int64(duration.components.seconds * 1000) + Int64(duration.components.attoseconds / 1_000_000_000_000_000)
        }
    }

    private struct Account {
        let library: TodoLibrary
        let outbox: IntentOutbox
        let events: AsyncStream<Store.ConversationEvent>.Continuation
    }

    /// One launch of an account: its outbox over `storage`, its library over `keep`.
    private func launch(_ server: FakeTodoServer, storage: any IntentStorage, keep: MemoryTodoKeep, online: Bool = true,
                        changed: @escaping @Sendable () async -> Void = {}) async -> Account {
        let clock = Clock()
        let delivery = TodoDelivery()
        let outbox = IntentOutbox(storage: storage, deliver: { try await delivery.deliver($0) }, now: { clock.now() }, sleep: { clock.advance($0); await Task.yield() })
        let (stream, continuation) = AsyncStream.makeStream(of: Store.ConversationEvent.self)
        let box = StreamBox(stream)
        let library = TodoLibrary(routes: server, outbox: outbox, keep: keep, events: { box.take() }, now: { Double(clock.now()) }, changed: changed)
        delivery.library = library
        await outbox.setOnline(online)
        return Account(library: library, outbox: outbox, events: continuation)
    }

    private final class StreamBox: @unchecked Sendable {
        let stream: AsyncStream<Store.ConversationEvent>
        init(_ stream: AsyncStream<Store.ConversationEvent>) { self.stream = stream }
        func take() -> AsyncStream<Store.ConversationEvent> { stream }
    }

    private func eventually(_ seconds: Double = 3, _ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// The latest state of `surfaceId`, following it.
    private final class Watcher: @unchecked Sendable {
        private let lock = NSLock()
        private var latest = TodoListState()
        var state: TodoListState { lock.lock(); defer { lock.unlock() }; return latest }
        func set(_ state: TodoListState) { lock.lock(); latest = state; lock.unlock() }
    }

    private func watch(_ library: TodoLibrary) async -> Watcher {
        let watcher = Watcher()
        let stream = await library.states(surfaceId)
        Task { for await state in stream { watcher.set(state) } }
        return watcher
    }

    /// Intents that can't be written: the disk refused.
    private actor FailingIntentStorage: IntentStorage {
        struct Refused: Error {}
        func intents() -> [Intent] { [] }
        func saveIntent(_ intent: Intent) throws { throw Refused() }
        func updateIntent(_ intent: Intent) {}
        func removeIntent(id: String) {}
    }

    private final class Reports: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
        func add() { lock.lock(); value += 1; lock.unlock() }
    }

    /// `feature_used: todo_changed` goes once a change is kept in the
    /// outbox, once per change, and never for one that couldn't be kept.
    func testAChangeIsReportedOnlyOnceItIsKept() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        let reports = Reports()
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep(), changed: { reports.add() })
        _ = await account.library.add(surfaceId, text: "Bread")
        _ = await account.library.add(surfaceId, text: "Butter")
        XCTAssertEqual(reports.count, 2)

        let failed = Reports()
        let broken = await launch(server, storage: FailingIntentStorage(), keep: MemoryTodoKeep(), changed: { failed.add() })
        _ = await broken.library.add(surfaceId, text: "Eggs")
        XCTAssertEqual(failed.count, 0)
    }

    func testAChangeShowsAtOnceAndReachesTheComputerUnderItsIDs() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { watcher.state.active.map(\.text) == ["Milk"] && !watcher.state.kept }
        await account.outbox.setOnline(false)
        let added = await account.library.add(surfaceId, text: "  Bread ")
        let id = try XCTUnwrap(added)
        try await eventually { watcher.state.active.map(\.text) == ["Bread", "Milk"] && watcher.state.waiting == [id] }
        let pending = await account.outbox.pending()
        await account.outbox.setOnline(true)
        try await eventually { await server.todos[id] != nil && watcher.state.waiting.isEmpty }
        let writes = await server.writes
        XCTAssertEqual(writes.first?.todoId, id, "the todo's ID is the creation's retry key")
        XCTAssertEqual(writes.first?.mutationId, pending.first?.id, "the intent's ID is the mutation ID")
        XCTAssertEqual(watcher.state.active.map(\.text), ["Bread", "Milk"])
        XCTAssertFalse(watcher.state.active[0].version.isEmpty, "the computer's todo replaced the local one")
    }

    func testChangesWaitThroughARelaunchAndGoInTheOrderTheyWereMade() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        let storage = MemoryIntentStorage(), keep = MemoryTodoKeep()
        let first = await launch(server, storage: storage, keep: keep)
        let watcher = await watch(first.library)
        try await eventually { watcher.state.active.count == 1 && !watcher.state.kept }
        await first.outbox.setOnline(false)
        let added = await first.library.add(surfaceId, text: "Bread")
        let id = try XCTUnwrap(added)
        await first.library.setText(surfaceId, id, text: "Rye bread")
        await first.library.setDone(surfaceId, "t000000000000000000000a1", true)
        await first.library.stop()
        await first.outbox.close()

        // Killed and opened again, offline: what was kept and what waits show.
        await server.setAway(true)
        let second = await launch(server, storage: storage, keep: keep)
        let again = await watch(second.library)
        try await eventually { again.state.active.map(\.text) == ["Rye bread"] && again.state.completed.map(\.text) == ["Milk"] }
        await server.setAway(false)
        try await eventually { await storage.intents().isEmpty }
        // Each todo's changes in order; different todos' as each is due.
        let writes = await server.writes.map { "\($0.method) \($0.body)" }
        XCTAssertEqual(writes.filter { $0 != "PATCH completed" }, ["POST Bread", "PATCH Rye bread"])
        XCTAssertEqual(Set(writes), ["POST Bread", "PATCH Rye bread", "PATCH completed"])
        let held = await server.todos
        XCTAssertEqual(held[id]?.text, "Rye bread")
        XCTAssertEqual(held["t000000000000000000000a1"]?.status, .completed)
    }

    /// Someone changed the todo first: the computer's version is taken and
    /// the change made again on top of it, as desktop does.
    func testAConflictTakesTheComputersTodoAndAppliesTheChangeAgain() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { !watcher.state.kept }
        await account.outbox.setOnline(false)
        await server.elsewhere("t000000000000000000000a1") { $0.text = "Milk (2 l)" }
        await account.library.setDone(surfaceId, "t000000000000000000000a1", true)
        await account.outbox.setOnline(true)
        try await eventually { await server.todos["t000000000000000000000a1"]?.status == .completed }
        try await eventually { watcher.state.completed.first?.text == "Milk (2 l)" }
        let writes = await server.writes.map(\.method)
        XCTAssertEqual(writes, ["PATCH", "PATCH"], "refused once as stale, then sent again")
        XCTAssertNil(watcher.state.failure)
    }

    /// A change made to a todo someone since deleted is dropped unsent.
    func testAChangeToATodoDeletedElsewhereIsDropped() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { !watcher.state.kept }
        await account.outbox.setOnline(false)
        await server.elsewhere("t000000000000000000000a1") { $0.status = .deleted; $0.orderKey = nil; $0.deletedAt = 7 }
        await account.library.setText(surfaceId, "t000000000000000000000a1", text: "Oat milk")
        await account.outbox.setOnline(true)
        try await eventually { await account.outbox.pending().isEmpty }
        let writes = await server.writes.map(\.method)
        XCTAssertEqual(writes, ["PATCH"], "tried once, refused as stale")
        try await eventually { watcher.state.active.isEmpty }
    }

    func testARefusalUndoesTheChangeAndSaysWhy() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        await server.refuse(text: "Forbidden")
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { !watcher.state.kept }
        await account.library.setText(surfaceId, "t000000000000000000000a1", text: "Forbidden")
        try await eventually { watcher.state.failure != nil }
        XCTAssertEqual(watcher.state.active.map(\.text), ["Milk"], "rolled back")
        await account.library.dismissFailure(surfaceId)
        try await eventually { watcher.state.failure == nil }
    }

    func testAnUndoneDeleteComesBackWhereItWas() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        for (id, text) in [("t000000000000000000000a1", "Milk"), ("t000000000000000000000a2", "Eggs"), ("t000000000000000000000a3", "Bread")] { await server.seed(id, text) }
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { watcher.state.active.count == 3 && !watcher.state.kept }
        await account.library.delete(surfaceId, "t000000000000000000000a2")
        XCTAssertEqual(watcher.state.active.map(\.text), ["Milk", "Bread"])
        try await eventually { await server.todos["t000000000000000000000a2"]?.status == .deleted }
        await account.library.restore(surfaceId, "t000000000000000000000a2", to: .after("t000000000000000000000a1"))
        XCTAssertEqual(watcher.state.active.map(\.text), ["Milk", "Eggs", "Bread"], "back at once, in its place")
        try await eventually { await account.outbox.pending().isEmpty }
        let order = await server.todos.values.filter { $0.status == .active }.sorted(by: TodoOrder.active).map(\.text)
        XCTAssertEqual(order, ["Milk", "Eggs", "Bread"], "the computer has it in its place too")
        let writes = await server.writes.map(\.method)
        XCTAssertEqual(writes, ["DELETE", "PATCH", "REORDER"])
    }

    func testAnUndoBeforeTheDeleteIsSentSendsNothing() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { !watcher.state.kept }
        await account.outbox.setOnline(false)
        await account.library.delete(surfaceId, "t000000000000000000000a1")
        await account.library.restore(surfaceId, "t000000000000000000000a1", to: .after(nil))
        await account.outbox.setOnline(true)
        try await eventually { await account.outbox.pending().isEmpty }
        let writes = await server.writes
        XCTAssertEqual(writes, [])
        XCTAssertEqual(watcher.state.active.map(\.text), ["Milk"])
    }

    func testAMoveSendsWhatComesBeforeIt() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        for (id, text) in [("t000000000000000000000a1", "Milk"), ("t000000000000000000000a2", "Eggs"), ("t000000000000000000000a3", "Bread")] { await server.seed(id, text) }
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { watcher.state.active.count == 3 && !watcher.state.kept }
        await account.library.move(surfaceId, "t000000000000000000000a1", to: 2)
        XCTAssertEqual(watcher.state.active.map(\.text), ["Eggs", "Bread", "Milk"])
        try await eventually { await account.outbox.pending().isEmpty }
        let writes = await server.writes.map(\.body)
        XCTAssertEqual(writes, ["t000000000000000000000a3"])
        let order = await server.todos.values.filter { $0.status == .active }.sorted(by: TodoOrder.active).map(\.text)
        XCTAssertEqual(order, ["Eggs", "Bread", "Milk"])
    }

    func testEventsFromElsewhereShowAndANewTodoIsRead() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        let before = await server.seed("t000000000000000000000a1", "Milk", author: "u1")
        let account = await launch(server, storage: MemoryIntentStorage(), keep: MemoryTodoKeep())
        let watcher = await watch(account.library)
        try await eventually { watcher.state.names == ["u1": "Person u1"] }
        let after = await server.elsewhere("t000000000000000000000a1") { $0.text = "Oat milk" }
        account.events.yield(.event(.object(["type": "todo.updated", "payload": .object([
            "surfaceId": .string(surfaceId), "todoId": "t000000000000000000000a1", "previousVersion": .string(before.version),
            "version": .string(after.version), "changes": .object(["text": "Oat milk", "updatedAt": 3]),
        ])])))
        try await eventually { watcher.state.active.map(\.text) == ["Oat milk"] }
        // One it never saw: read whole.
        let new = await server.seed("t000000000000000000000a2", "Eggs")
        account.events.yield(.event(.object(["type": "todo.updated", "payload": .object([
            "surfaceId": .string(surfaceId), "todoId": "t000000000000000000000a2", "previousVersion": "v000000", "version": .string(new.version), "changes": .object([:]),
        ])])))
        try await eventually { watcher.state.active.map(\.text) == ["Oat milk", "Eggs"] }
    }

    func testTheDeletedListIsReadWhenAskedFor() async throws {
        let server = FakeTodoServer(surfaceId: surfaceId)
        await server.seed("t000000000000000000000a1", "Milk")
        await server.seed("t000000000000000000000a2", "Old", status: .deleted)
        let keep = MemoryTodoKeep()
        let account = await launch(server, storage: MemoryIntentStorage(), keep: keep)
        let watcher = await watch(account.library)
        try await eventually { !watcher.state.kept }
        XCTAssertEqual(watcher.state.deleted, [])
        await account.library.showDeleted(surfaceId)
        try await eventually { watcher.state.deleted.map(\.text) == ["Old"] && watcher.state.deletedRead }
        await account.library.restore(surfaceId, "t000000000000000000000a2")
        XCTAssertEqual(watcher.state.active.map(\.text), ["Milk", "Old"])
        let counts = await account.library.outstanding([surfaceId])
        XCTAssertEqual(counts, [surfaceId: 2])
    }
}
