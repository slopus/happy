import Foundation
import HappyWire

/// The todo routes the library uses (happy-agent API.md, "Todo routes");
/// `AgentClient` is the account's.
public protocol TodoRoutes: Sendable {
    func todos(_ surfaceId: String, scope: TodoItem.Status) async throws -> [TodoItem]
    func todo(_ surfaceId: String, _ todoId: String) async throws -> TodoItem
    func createTodo(_ surfaceId: String, id: String, text: String, mutationId: String) async throws -> TodoItem
    func updateTodo(_ surfaceId: String, _ todoId: String, text: String?, status: TodoItem.Status?, ifMatch: String, mutationId: String) async throws -> TodoItem
    func deleteTodo(_ surfaceId: String, _ todoId: String, ifMatch: String, mutationId: String) async throws -> TodoItem
    func reorderTodo(_ surfaceId: String, _ todoId: String, afterId: String?, ifMatch: String, mutationId: String) async throws -> TodoItem
    func todoVersions(_ surfaceId: String, _ todoId: String) async throws -> [TodoRevision]
    func teamUsers(_ ids: [String]) async throws -> [TeamUser]
}

/// Where the lists are kept between launches: the account's checkpoints.
public protocol TodoKeep: Sendable {
    func read(_ key: String) async -> JSONValue?
    func write(_ key: String, _ value: JSONValue) async
}

/// One todo list as a screen shows it.
public struct TodoListState: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        /// Nothing kept and the computer not read yet.
        case loading
        case ready
        /// No such todo list (`404`).
        case missing
    }

    public var status = Status.loading
    /// In the list's order, headings among them.
    public var active: [TodoItem] = []
    /// Newest completed first.
    public var completed: [TodoItem] = []
    /// Newest deleted first; read once asked for (`showDeleted`).
    public var deleted: [TodoItem] = []
    public var deletedRead = false
    /// The todos with a change still on its way.
    public var waiting: Set<String> = []
    /// Authors' names, by user ID.
    public var names: [String: String] = [:]
    /// A change the computer refused, and why: it was undone.
    public var failure: String?
    /// Shown from the phone: the computer hasn't been read this time.
    public var kept = true

    public init() {}
}

/// The intent outbox's way to the library, which is made after it.
final class TodoDelivery: @unchecked Sendable {
    weak var library: TodoLibrary?

    func deliver(_ intent: Intent) async throws {
        guard let library else { throw CancellationError() }
        try await library.deliver(intent)
    }
}

/// What a delivery throws while an earlier change to the same todo waits:
/// a todo's changes go in the order they were made.
struct TodoWaiting: Error {}

/// The account's todo lists: each kept on the phone, read whole from the
/// computer, then kept current by its `todo.*` events; every change a
/// person makes shows at once, is kept in the intent outbox, and goes to
/// the computer when it can, in order, under its mutation ID
/// (docs/offline-first.md). A conflict is settled as desktop settles it:
/// the computer's todo is taken, and the change applied to it again, up
/// to three times.
public actor TodoLibrary {
    private struct List {
        var confirmed: [String: TodoItem] = [:]
        var status = TodoListState.Status.loading
        var opened = false
        var read = false
        var deletedRead = false
        var failure: String?
        var listeners: [UUID: AsyncStream<TodoListState>.Continuation] = [:]
        var reading: Task<Void, Never>?
        var again = false
        /// Changed by events while a read was under way.
        var touched: Set<String> = []
        var published: TodoListState?
    }

    public static func resource(_ surfaceId: String) -> String { "todos:\(surfaceId)" }
    static let conflictRetries = 3

    private let routes: TodoRoutes
    private let outbox: IntentOutbox
    private let keep: TodoKeep
    private let events: @Sendable () async -> AsyncStream<Store.ConversationEvent>
    private let now: @Sendable () -> Double
    private var lists: [String: List] = [:]
    /// Every todo change on its way, oldest first.
    private var ops: [(intent: Intent, op: TodoOp)] = []
    private var names: [String: String] = [:]
    private var asked: Set<String> = []
    private var following: [Task<Void, Never>] = []
    private var started = false

    public init(routes: TodoRoutes, outbox: IntentOutbox, keep: TodoKeep,
                events: @escaping @Sendable () async -> AsyncStream<Store.ConversationEvent>,
                now: @escaping @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }) {
        self.routes = routes
        self.outbox = outbox
        self.keep = keep
        self.events = events
        self.now = now
    }

    // MARK: Following

    private func start() async {
        guard !started else { return }
        started = true
        ops = Self.todoOps(await outbox.pending())
        let outbox = outbox, events = events
        following.append(Task { [weak self] in
            for await list in await outbox.changes() { await self?.opsChanged(list) }
        })
        following.append(Task { [weak self] in
            for await rejection in await outbox.rejections() { await self?.refused(rejection) }
        })
        following.append(Task { [weak self] in
            for await event in await events() {
                switch event {
                case .resync: await self?.resync()
                case .event(let envelope): await self?.receive(envelope)
                }
            }
        })
    }

    public func stop() {
        following.forEach { $0.cancel() }
        following = []
        for (id, list) in lists {
            list.reading?.cancel()
            list.listeners.values.forEach { $0.finish() }
            lists[id]?.listeners = [:]
        }
    }

    private static func todoOps(_ intents: [Intent]) -> [(intent: Intent, op: TodoOp)] {
        intents.compactMap { intent in intent.kind.isTodo ? TodoOp(intent).map { (intent, $0) } : nil }
    }

    private func opsChanged(_ intents: [Intent]) {
        let next = Self.todoOps(intents)
        let surfaces = Set(ops.map(\.op.surfaceId)).union(next.map(\.op.surfaceId))
        ops = next
        for id in surfaces { publish(id) }
    }

    private func refused(_ rejection: IntentOutbox.Rejection) {
        guard rejection.intent.kind.isTodo, let op = TodoOp(rejection.intent), lists[op.surfaceId] != nil else { return }
        lists[op.surfaceId]?.failure = rejection.reason.isEmpty ? "The computer refused it." : rejection.reason
        publish(op.surfaceId)
    }

    private func resync() {
        for (id, list) in lists where !list.listeners.isEmpty { refresh(id) }
    }

    private func receive(_ event: JSONValue) async {
        let payload = event["payload"]
        guard let surfaceId = payload?["surfaceId"]?.stringValue ?? payload?["todo"]?["surfaceId"]?.stringValue,
              var list = lists[surfaceId], list.opened else { return }
        switch TodoReducer.receive(event, surfaceId: surfaceId, into: &list.confirmed) {
        case .ignored:
            return
        case .applied:
            if list.reading != nil, let id = payload?["todoId"]?.stringValue ?? payload?["todo"]?["id"]?.stringValue { list.touched.insert(id) }
            lists[surfaceId] = list
            await changed(surfaceId)
        case .read(let todoId):
            guard let todo = try? await routes.todo(surfaceId, todoId) else { return }
            await take(todo)
        }
    }

    // MARK: Lists

    /// The list now and after every change; opens it: what was kept, then
    /// the computer.
    public func states(_ surfaceId: String) async -> AsyncStream<TodoListState> {
        await start()
        await open(surfaceId)
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: TodoListState.self, bufferingPolicy: .bufferingNewest(1))
        lists[surfaceId]?.listeners[id] = continuation
        continuation.yield(state(surfaceId))
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(surfaceId, id) } }
        if lists[surfaceId]?.read == false { refresh(surfaceId) }
        return stream
    }

    private func unlisten(_ surfaceId: String, _ id: UUID) { lists[surfaceId]?.listeners[id] = nil }

    /// The kept list, read once into memory.
    private func open(_ surfaceId: String) async {
        guard lists[surfaceId]?.opened != true else { return }
        var list = lists[surfaceId] ?? List()
        list.opened = true
        lists[surfaceId] = list
        guard let kept = await keep.read(Self.resource(surfaceId)) else { return }
        let todos = (kept["todos"]?.arrayValue ?? []).compactMap(TodoItem.init(json:))
        for (id, name) in kept["names"]?.objectValue ?? [:] { if let name = name.stringValue, names[id] == nil { names[id] = name } }
        guard var current = lists[surfaceId] else { return }
        for todo in todos where current.confirmed[todo.id] == nil { current.confirmed[todo.id] = todo }
        if current.status == .loading, !todos.isEmpty || kept["read"] == .bool(true) { current.status = .ready }
        current.deletedRead = current.deletedRead || kept["deletedRead"] == .bool(true)
        lists[surfaceId] = current
        publish(surfaceId)
    }

    /// Reads the list whole again; one under way is followed by one more.
    public func refresh(_ surfaceId: String) {
        guard var list = lists[surfaceId] else { return }
        if list.reading != nil { list.again = true; lists[surfaceId] = list; return }
        list.touched = []
        list.reading = Task { await self.read(surfaceId) }
        lists[surfaceId] = list
    }

    private func read(_ surfaceId: String) async {
        defer {
            lists[surfaceId]?.reading = nil
            if lists[surfaceId]?.again == true {
                lists[surfaceId]?.again = false
                refresh(surfaceId)
            }
        }
        let withDeleted = lists[surfaceId]?.deletedRead == true
        let fetched: [TodoItem]
        do {
            async let active = routes.todos(surfaceId, scope: .active)
            async let completed = routes.todos(surfaceId, scope: .completed)
            let deleted = withDeleted ? try await routes.todos(surfaceId, scope: .deleted) : []
            fetched = try await active + completed + deleted
        } catch AgentClientError.status(404, _, _) {
            guard var list = lists[surfaceId] else { return }
            list.confirmed = [:]
            list.status = .missing
            list.read = true
            lists[surfaceId] = list
            publish(surfaceId)
            return
        } catch {
            return
        }
        guard var list = lists[surfaceId] else { return }
        var next = Dictionary(fetched.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // What deleted reads haven't covered stays as it was known.
        if !withDeleted { for todo in list.confirmed.values where todo.status == .deleted && next[todo.id] == nil { next[todo.id] = todo } }
        // Events newer than the read's snapshot stand.
        for id in list.touched {
            guard let held = list.confirmed[id] else { continue }
            if let read = next[id], !TodoOrder.newer(held.version, than: read.version) { continue }
            next[id] = held
        }
        list.confirmed = next
        list.touched = []
        list.status = .ready
        list.read = true
        lists[surfaceId] = list
        await changed(surfaceId)
        await readNames(surfaceId)
    }

    /// Reads the deleted todos too, now and in every read after.
    public func showDeleted(_ surfaceId: String) {
        guard lists[surfaceId] != nil else { return }
        lists[surfaceId]?.deletedRead = true
        publish(surfaceId)
        refresh(surfaceId)
    }

    public func dismissFailure(_ surfaceId: String) {
        guard lists[surfaceId]?.failure != nil else { return }
        lists[surfaceId]?.failure = nil
        publish(surfaceId)
    }

    /// The unfinished todos of each kept list, headings left out.
    public func outstanding(_ surfaceIds: [String]) async -> [String: Int] {
        var counts: [String: Int] = [:]
        for id in surfaceIds {
            if lists[id]?.opened == true {
                counts[id] = state(id).active.filter { $0.heading == nil }.count
            } else if let kept = await keep.read(Self.resource(id)) {
                counts[id] = (kept["todos"]?.arrayValue ?? []).compactMap(TodoItem.init(json:)).filter { $0.status == .active && $0.heading == nil }.count
            }
        }
        return counts
    }

    // MARK: State

    private func shown(_ surfaceId: String) -> [String: TodoItem] {
        TodoReducer.overlay(lists[surfaceId]?.confirmed ?? [:], ops.filter { $0.op.surfaceId == surfaceId }.map(\.op))
    }

    private func state(_ surfaceId: String) -> TodoListState {
        guard let list = lists[surfaceId] else { return TodoListState() }
        let split = TodoReducer.split(shown(surfaceId))
        var state = TodoListState()
        state.status = list.status
        state.active = split.active
        state.completed = split.completed
        state.deleted = split.deleted
        state.deletedRead = list.deletedRead
        state.waiting = Set(ops.filter { $0.op.surfaceId == surfaceId }.map(\.op.todoId))
        state.failure = list.failure
        state.kept = !list.read
        // A todo made here is there at once, before the computer is read.
        if state.status == .loading, !state.active.isEmpty { state.status = .ready }
        let authors = Set((split.active + split.completed + split.deleted).compactMap(\.authorUserId))
        state.names = names.filter { authors.contains($0.key) }
        return state
    }

    private func publish(_ surfaceId: String) {
        guard let list = lists[surfaceId], !list.listeners.isEmpty else { return }
        let next = state(surfaceId)
        guard next != list.published else { return }
        lists[surfaceId]?.published = next
        for listener in list.listeners.values { listener.yield(next) }
    }

    /// Publishes and writes down list `surfaceId`.
    private func changed(_ surfaceId: String) async {
        publish(surfaceId)
        guard let list = lists[surfaceId] else { return }
        let todos = list.confirmed.values.sorted { $0.id < $1.id }
        guard let encoded = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(todos)) else { return }
        let authors = Set(todos.compactMap(\.authorUserId))
        let kept: [String: JSONValue] = [
            "todos": encoded,
            "read": .bool(list.read),
            "deletedRead": .bool(list.deletedRead),
            "names": .object(names.filter { authors.contains($0.key) }.mapValues(JSONValue.string)),
        ]
        await keep.write(Self.resource(surfaceId), .object(kept))
    }

    private func take(_ todo: TodoItem) async {
        guard var list = lists[todo.surfaceId] else { return }
        guard TodoReducer.accept(todo, into: &list.confirmed) else { return }
        if list.reading != nil { list.touched.insert(todo.id) }
        lists[todo.surfaceId] = list
        await changed(todo.surfaceId)
    }

    private func readNames(_ surfaceId: String) async {
        let ids = Set(lists[surfaceId]?.confirmed.values.compactMap(\.authorUserId) ?? []).subtracting(names.keys).subtracting(asked)
        guard !ids.isEmpty else { return }
        asked.formUnion(ids)
        guard let users = try? await routes.teamUsers(Array(ids)) else { asked.subtract(ids); return }
        for user in users where !user.name.isEmpty { names[user.id] = user.name }
        await changed(surfaceId)
    }

    /// Names for `ids`, read where not known yet (a revision's people).
    public func names(_ ids: Set<String>) async -> [String: String] {
        let missing = ids.subtracting(names.keys)
        if !missing.isEmpty, let users = try? await routes.teamUsers(Array(missing)) {
            for user in users where !user.name.isEmpty { names[user.id] = user.name }
        }
        return names.filter { ids.contains($0.key) }
    }

    // MARK: Changes

    /// `reported`: one change the person made, `feature_used` once it is
    /// queued; a restore's second step is the same change.
    private func enqueue(_ op: TodoOp, reported: Bool = true) async {
        if reported { Task { @MainActor in Analytics.shared.log(.featureUsed(.todoChanged)) } }
        await start()
        await open(op.surfaceId)
        lists[op.surfaceId]?.failure = nil
        _ = try? await outbox.enqueue(op.intentKind, target: op.todoId, value: op.value)
        // The outbox publishes the change; this shows it without waiting.
        ops = Self.todoOps(await outbox.pending())
        publish(op.surfaceId)
    }

    /// A new todo at the top; its ID, or nil when `text` is nothing.
    @discardableResult
    public func add(_ surfaceId: String, text: String) async -> String? {
        guard let text = TodoText.normalized(text) else { return nil }
        await open(surfaceId)
        guard lists[surfaceId]?.status != .missing else { return nil }
        let first = TodoReducer.split(shown(surfaceId)).active.first?.orderKey
        let id = TodoID.make()
        await enqueue(TodoOp(surfaceId: surfaceId, todoId: id, kind: .create(text: text, orderKey: TodoOrder.key(between: nil, and: first)), at: now()))
        return id
    }

    public func setText(_ surfaceId: String, _ todoId: String, text: String) async {
        guard let text = TodoText.normalized(text), let todo = shown(surfaceId)[todoId], todo.text != text else { return }
        await enqueue(TodoOp(surfaceId: surfaceId, todoId: todoId, kind: .text(text), at: now()))
    }

    /// Done or not done; one done again goes to the end of the list.
    public func setDone(_ surfaceId: String, _ todoId: String, _ done: Bool) async {
        guard let todo = shown(surfaceId)[todoId], todo.status != .deleted else { return }
        let status: TodoItem.Status = done ? .completed : .active
        guard todo.status != status else { return }
        let last = TodoReducer.split(shown(surfaceId)).active.last?.orderKey
        await enqueue(TodoOp(surfaceId: surfaceId, todoId: todoId, kind: .status(status, orderKey: done ? nil : TodoOrder.key(between: last, and: nil)), at: now()))
    }

    public func delete(_ surfaceId: String, _ todoId: String) async {
        guard let todo = shown(surfaceId)[todoId], todo.status != .deleted else { return }
        await enqueue(TodoOp(surfaceId: surfaceId, todoId: todoId, kind: .status(.deleted, orderKey: nil), at: now()))
    }

    /// Where a todo brought back goes.
    public enum Place: Equatable, Sendable {
        /// The end of the list, as the computer puts it.
        case end
        /// After this todo, or first for nil: where an undo had it.
        case after(String?)
    }

    /// Brings a deleted todo back, active at `place` or completed.
    public func restore(_ surfaceId: String, _ todoId: String, to place: Place = .end, as status: TodoItem.Status = .active) async {
        guard let todo = shown(surfaceId)[todoId], todo.status == .deleted, status != .deleted else { return }
        let active = TodoReducer.split(shown(surfaceId)).active
        var key: String?
        var moves = false
        if status == .active {
            switch place {
            case .after(let afterId?):
                if let index = active.firstIndex(where: { $0.id == afterId }) {
                    key = TodoOrder.key(between: active[index].orderKey, and: index + 1 < active.count ? active[index + 1].orderKey : nil)
                    moves = index + 1 < active.count
                }
            case .after(nil):
                key = TodoOrder.key(between: nil, and: active.first?.orderKey)
                moves = !active.isEmpty
            case .end:
                break
            }
            if key == nil { key = TodoOrder.key(between: active.last?.orderKey, and: nil) }
        }
        await enqueue(TodoOp(surfaceId: surfaceId, todoId: todoId, kind: .status(status, orderKey: key), at: now()))
        // The computer puts it back at the end; then where it was.
        if moves, let key { await enqueue(TodoOp(surfaceId: surfaceId, todoId: todoId, kind: .move(orderKey: key), at: now()), reported: false) }
    }

    /// Moves an active todo to `index` of the active list.
    public func move(_ surfaceId: String, _ todoId: String, to index: Int) async {
        let active = TodoReducer.split(shown(surfaceId)).active
        guard let key = TodoReducer.key(moving: todoId, to: index, in: active) else { return }
        await enqueue(TodoOp(surfaceId: surfaceId, todoId: todoId, kind: .move(orderKey: key), at: now()))
    }

    /// Every revision of a todo, oldest first, with its people's names.
    public func history(_ surfaceId: String, _ todoId: String) async throws -> (revisions: [TodoRevision], names: [String: String]) {
        let revisions = try await routes.todoVersions(surfaceId, todoId)
        let people = Set(revisions.compactMap(\.userId) + revisions.compactMap(\.todo.authorUserId))
        return (revisions, await names(people))
    }

    // MARK: Delivery

    /// Sends one waiting change: gone when the computer took it or already
    /// has it; `IntentRefusal` when it said no for good, after reading the
    /// list again; anything else is tried again later.
    func deliver(_ intent: Intent) async throws {
        guard let op = TodoOp(intent) else { throw IntentRefusal("") }
        await start()
        // A todo's changes go in the order they were made.
        let pending = await outbox.pending()
        if pending.contains(where: { $0.kind.isTodo && $0.target == intent.target && $0.id != intent.id && ($0.createdAt, $0.id) < (intent.createdAt, intent.id) }) {
            throw TodoWaiting()
        }
        await open(op.surfaceId)
        var conflicts = 0
        while true {
            let confirmed = lists[op.surfaceId]?.confirmed ?? [:]
            let shown = shown(op.surfaceId)
            guard TodoReducer.needed(op, confirmed: confirmed, shown: shown) else { return }
            do {
                if case .create(let text, _) = op.kind {
                    await take(try await routes.createTodo(op.surfaceId, id: op.todoId, text: text, mutationId: intent.id))
                    return
                }
                guard let held = confirmed[op.todoId] else {
                    // Not read on this phone yet: read it, then decide.
                    await take(try await routes.todo(op.surfaceId, op.todoId))
                    guard lists[op.surfaceId]?.confirmed[op.todoId] != nil else { return }
                    continue
                }
                let todo: TodoItem
                switch op.kind {
                case .create:
                    return
                case .text(let text):
                    todo = try await routes.updateTodo(op.surfaceId, op.todoId, text: text, status: nil, ifMatch: held.version, mutationId: intent.id)
                case .status(.deleted, _):
                    todo = try await routes.deleteTodo(op.surfaceId, op.todoId, ifMatch: held.version, mutationId: intent.id)
                case .status(let status, _):
                    todo = try await routes.updateTodo(op.surfaceId, op.todoId, text: nil, status: status, ifMatch: held.version, mutationId: intent.id)
                case .move:
                    todo = try await routes.reorderTodo(op.surfaceId, op.todoId, afterId: TodoReducer.after(op.todoId, in: shown), ifMatch: held.version, mutationId: intent.id)
                }
                await take(todo)
                return
            } catch AgentClientError.status(409, let code, let message) {
                // Someone changed it first: take theirs, and apply this to it again.
                conflicts += 1
                if let fresh = try? await routes.todo(op.surfaceId, op.todoId) { await take(fresh) }
                if conflicts <= Self.conflictRetries { continue }
                throw IntentRefusal(Store.describe(AgentClientError.status(409, code: code, message: message)))
            } catch AgentClientError.status(404, let code, let message) {
                refresh(op.surfaceId)
                // A todo gone has nothing left to change; a list gone takes nothing.
                if case .create = op.kind { throw IntentRefusal(Store.describe(AgentClientError.status(404, code: code, message: message))) }
                return
            } catch let error as AgentClientError {
                if let status = error.status, (400..<500).contains(status), status != 408, status != 429 {
                    refresh(op.surfaceId)
                    throw IntentRefusal(Store.describe(error))
                }
                throw error
            }
        }
    }
}

/// A todo's ID made on this phone: the daemon's CUID2 form, a lowercase
/// letter then 23 lowercase letters or digits, so the computer takes it
/// as the creation's retry key.
public enum TodoID {
    public static func make() -> String {
        let letters = Array("abcdefghijklmnopqrstuvwxyz")
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var generator = SystemRandomNumberGenerator()
        return String(letters.randomElement(using: &generator)!) + String((0..<23).map { _ in alphabet.randomElement(using: &generator)! })
    }
}
