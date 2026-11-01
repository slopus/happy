import Foundation
import HappyWire

/// A change a person made to a todo here, waiting in the account's intent
/// outbox (`Intent`, kinds `todo.*`) until the computer takes it. It also
/// says where the todo shows meanwhile: `orderKey` and `at` are local.
public struct TodoOp: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case create(text: String, orderKey: String)
        case text(String)
        /// To active (with where it shows), completed or deleted.
        case status(TodoItem.Status, orderKey: String?)
        /// Placed after `afterId` in the list as it stands here when sent;
        /// `orderKey` is where it shows meanwhile.
        case move(orderKey: String)
    }

    public var surfaceId: String
    public var todoId: String
    public var kind: Kind
    /// When it was asked for (ms).
    public var at: Double

    public init(surfaceId: String, todoId: String, kind: Kind, at: Double) {
        self.surfaceId = surfaceId
        self.todoId = todoId
        self.kind = kind
        self.at = at
    }

    /// The outbox kind it waits under: one per todo for each.
    public var intentKind: Intent.Kind {
        switch kind {
        case .create: .todoCreate
        case .text: .todoText
        case .status: .todoStatus
        case .move: .todoMove
        }
    }

    public var value: JSONValue {
        var object: [String: JSONValue] = ["surfaceId": .string(surfaceId), "at": .number(at)]
        switch kind {
        case .create(let text, let key):
            object["text"] = .string(text); object["orderKey"] = .string(key)
        case .text(let text):
            object["text"] = .string(text)
        case .status(let status, let key):
            object["status"] = .string(status.rawValue)
            if let key { object["orderKey"] = .string(key) }
        case .move(let key):
            object["orderKey"] = .string(key)
        }
        return .object(object)
    }

    /// The op an intent carries, nil for one that isn't a todo's.
    public init?(_ intent: Intent) {
        let value = intent.value
        guard let surfaceId = value["surfaceId"]?.stringValue else { return nil }
        let at = value["at"]?.numberValue ?? Double(intent.createdAt)
        let key = value["orderKey"]?.stringValue
        let kind: Kind
        switch intent.kind {
        case .todoCreate:
            guard let text = value["text"]?.stringValue else { return nil }
            kind = .create(text: text, orderKey: key ?? "")
        case .todoText:
            guard let text = value["text"]?.stringValue else { return nil }
            kind = .text(text)
        case .todoStatus:
            guard let status = value["status"]?.stringValue.flatMap(TodoItem.Status.init(rawValue:)) else { return nil }
            kind = .status(status, orderKey: key)
        case .todoMove:
            kind = .move(orderKey: key ?? "")
        default:
            return nil
        }
        self.init(surfaceId: surfaceId, todoId: intent.target, kind: kind, at: at)
    }
}

/// A todo list as this phone shows it, worked out from what the computer
/// last said and the changes still on their way (docs/offline-first.md,
/// "Pending wins"), as desktop's todo store does. Pure: the library and
/// its tests drive it.
public enum TodoReducer {
    /// `todo` with `op` laid over it; nil where there is still no todo.
    public static func apply(_ op: TodoOp, to todo: TodoItem?) -> TodoItem? {
        if case .create(let text, let key) = op.kind {
            return todo ?? TodoItem(id: op.todoId, surfaceId: op.surfaceId, text: text, status: .active, orderKey: key, createdAt: op.at, updatedAt: op.at)
        }
        guard var todo else { return nil }
        switch op.kind {
        case .create:
            break
        case .text(let text):
            todo.text = text
        case .status(let status, let key):
            guard todo.status != status else { return todo }
            switch status {
            case .active:
                todo.status = .active; todo.orderKey = key ?? todo.orderKey; todo.completedAt = nil; todo.deletedAt = nil
            case .completed:
                todo.status = .completed; todo.orderKey = nil; todo.completedAt = op.at; todo.deletedAt = nil
            case .deleted:
                todo.status = .deleted; todo.orderKey = nil; todo.deletedAt = op.at
            }
        case .move(let key):
            if todo.status == .active { todo.orderKey = key }
        }
        return todo
    }

    /// Every todo as it shows: `confirmed` with `ops` laid over in order.
    public static func overlay(_ confirmed: [String: TodoItem], _ ops: [TodoOp]) -> [String: TodoItem] {
        guard !ops.isEmpty else { return confirmed }
        var shown = confirmed
        for op in ops {
            if let next = apply(op, to: shown[op.todoId]) { shown[op.todoId] = next }
        }
        return shown
    }

    /// The three lists, each in its order.
    public static func split(_ todos: [String: TodoItem]) -> (active: [TodoItem], completed: [TodoItem], deleted: [TodoItem]) {
        var active: [TodoItem] = [], completed: [TodoItem] = [], deleted: [TodoItem] = []
        for todo in todos.values {
            switch todo.status {
            case .active: active.append(todo)
            case .completed: completed.append(todo)
            case .deleted: deleted.append(todo)
            }
        }
        return (active.sorted(by: TodoOrder.active), completed.sorted(by: TodoOrder.completed), deleted.sorted(by: TodoOrder.deleted))
    }

    /// Takes `todo` from the computer unless what is held is as new.
    public static func accept(_ todo: TodoItem, into confirmed: inout [String: TodoItem]) -> Bool {
        if let held = confirmed[todo.id], !TodoOrder.newer(todo.version, than: held.version) { return false }
        confirmed[todo.id] = todo
        return true
    }

    /// What one of the stream's `todo.*` events did.
    public enum EventResult: Equatable, Sendable {
        /// Nothing to do: another list's, or older than what is held.
        case ignored
        case applied
        /// The chain broke here, or the todo is new to this phone: read it.
        case read(String)
    }

    /// Applies `event` (`{ type, payload }`) to list `surfaceId`.
    public static func receive(_ event: JSONValue, surfaceId: String, into confirmed: inout [String: TodoItem]) -> EventResult {
        let payload = event["payload"] ?? .null
        switch event["type"]?.stringValue {
        case "todo.created":
            guard let todo = payload["todo"].flatMap(TodoItem.init(json:)), todo.surfaceId == surfaceId else { return .ignored }
            return accept(todo, into: &confirmed) ? .applied : .ignored
        case "todo.updated":
            guard payload["surfaceId"]?.stringValue == surfaceId, let id = payload["todoId"]?.stringValue,
                  let version = payload["version"]?.stringValue else { return .ignored }
            guard var held = confirmed[id] else { return .read(id) }
            guard TodoOrder.newer(version, than: held.version) else { return .ignored }
            guard payload["previousVersion"]?.stringValue == held.version, let changes = payload["changes"]?.objectValue else { return .read(id) }
            for (field, value) in changes {
                switch field {
                case "text": if let text = value.stringValue { held.text = text }
                case "status": if let status = value.stringValue.flatMap(TodoItem.Status.init(rawValue:)) { held.status = status }
                case "orderKey": held.orderKey = value.stringValue
                case "completedAt": held.completedAt = value.numberValue
                case "deletedAt": held.deletedAt = value.numberValue
                case "updatedAt": held.updatedAt = value.numberValue ?? held.updatedAt
                default: break
                }
            }
            held.version = version
            confirmed[id] = held
            return .applied
        default:
            return .ignored
        }
    }

    /// Whether `op` still changes anything the computer holds: a change
    /// it already has, or one to a todo since deleted, is dropped unsent.
    /// `shown` is the list with every waiting change laid over.
    public static func needed(_ op: TodoOp, confirmed: [String: TodoItem], shown: [String: TodoItem]) -> Bool {
        let held = confirmed[op.todoId]
        if case .create = op.kind { return held == nil }
        guard let held else { return true }
        // Deleted meanwhile, by anyone: only bringing it back still counts.
        if held.status == .deleted {
            if case .status(let status, _) = op.kind { return status != .deleted }
            return false
        }
        switch op.kind {
        case .create:
            return false
        case .text(let text):
            return held.text != text
        case .status(let status, _):
            return held.status != status
        case .move:
            guard held.status == .active, shown[op.todoId]?.status == .active else { return false }
            return after(op.todoId, in: confirmed) != after(op.todoId, in: shown)
        }
    }

    /// The active todo before `id` in `todos`' order; nil when it is first.
    public static func after(_ id: String, in todos: [String: TodoItem]) -> String? {
        let active = todos.values.filter { $0.status == .active }.sorted(by: TodoOrder.active)
        guard let index = active.firstIndex(where: { $0.id == id }), index > 0 else { return nil }
        return active[index - 1].id
    }

    /// Where a todo moved to `index` of `active` (without it) shows.
    public static func key(moving id: String, to index: Int, in active: [TodoItem]) -> String? {
        guard let from = active.firstIndex(where: { $0.id == id }) else { return nil }
        let target = max(0, min(active.count - 1, index))
        guard target != from else { return nil }
        let rest = active.filter { $0.id != id }
        return TodoOrder.key(between: target > 0 ? rest[target - 1].orderKey : nil, and: target < rest.count ? rest[target].orderKey : nil)
    }
}
