import Foundation
import HappyWire

/// One todo of a todo Surface as the computer keeps it (happy-agent
/// API.md, "Todo data and permanent versions"). Only an active todo has an
/// order key; a deleted one keeps the time it was completed, if it was.
public struct TodoItem: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Status: String, Codable, Sendable {
        case active
        case completed
        case deleted
    }

    public var id: String
    public var surfaceId: String
    public var authorUserId: String?
    public var text: String
    public var status: Status
    public var orderKey: String?
    /// Epoch milliseconds.
    public var createdAt: Double
    public var updatedAt: Double
    public var completedAt: Double?
    public var deletedAt: Double?
    /// The todo's UUIDv7 version; empty for one made here and not yet taken.
    public var version: String

    public init(id: String, surfaceId: String, authorUserId: String? = nil, text: String, status: Status = .active, orderKey: String? = nil,
                createdAt: Double = 0, updatedAt: Double = 0, completedAt: Double? = nil, deletedAt: Double? = nil, version: String = "") {
        self.id = id
        self.surfaceId = surfaceId
        self.authorUserId = authorUserId
        self.text = text
        self.status = status
        self.orderKey = orderKey
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.deletedAt = deletedAt
        self.version = version
    }

    /// A todo as the computer sends it; nil for one it can't be read as.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let surfaceId = json["surfaceId"]?.stringValue,
              let text = json["text"]?.stringValue, let status = json["status"]?.stringValue.flatMap(Status.init(rawValue:)) else { return nil }
        self.init(
            id: id, surfaceId: surfaceId, authorUserId: json["authorUserId"]?.stringValue, text: text, status: status,
            orderKey: json["orderKey"]?.stringValue, createdAt: json["createdAt"]?.numberValue ?? 0, updatedAt: json["updatedAt"]?.numberValue ?? 0,
            completedAt: json["completedAt"]?.numberValue, deletedAt: json["deletedAt"]?.numberValue, version: json["version"]?.stringValue ?? ""
        )
    }

    /// The label of a section heading (`# Groceries`), nil for a todo.
    public var heading: String? { TodoText.heading(text) }
}

/// The text rules desktop's todo list keeps (`happy-agent` todo store).
public enum TodoText {
    /// The most a todo holds.
    public static let limit = 10_000

    /// A heading's label: what follows an exact `# ` prefix.
    public static func heading(_ text: String) -> String? {
        text.hasPrefix("# ") ? String(text.dropFirst(2)) : nil
    }

    /// What a person typed as a todo's text, or nil for nothing: control
    /// characters become spaces and the ends are trimmed. A heading stays
    /// one; a todo that trimming would turn into a heading keeps a space
    /// in front, so it stays a todo.
    public static func normalized(_ typed: String) -> String? {
        let heading = heading(typed)
        let cleaned = String(String.UnicodeScalarView((heading ?? typed).unicodeScalars.map { scalar in
            let value = scalar.value
            return value <= 0x08 || (0x0B...0x1F).contains(value) || value == 0x7F ? " " : scalar
        })).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        let text = if heading != nil { "# \(cleaned)" } else if self.heading(cleaned) != nil { " \(cleaned)" } else { cleaned }
        return String(text.prefix(limit))
    }
}

/// Keys and versions as the computer compares them: plain byte order,
/// never locale-aware.
public enum TodoOrder {
    public static func precedes(_ a: String, _ b: String) -> Bool { a.utf8.lexicographicallyPrecedes(b.utf8) }

    /// Whether version `a` is newer than `b` (UUIDv7s sort by time).
    public static func newer(_ a: String, than b: String) -> Bool { precedes(b, a) }

    /// Active todos in their list's order: by key, then ID.
    public static func active(_ a: TodoItem, _ b: TodoItem) -> Bool {
        let left = a.orderKey ?? "", right = b.orderKey ?? ""
        return left != right ? precedes(left, right) : precedes(a.id, b.id)
    }

    /// Completed todos, newest first, then ID.
    public static func completed(_ a: TodoItem, _ b: TodoItem) -> Bool {
        let left = a.completedAt ?? 0, right = b.completedAt ?? 0
        return left != right ? left > right : precedes(a.id, b.id)
    }

    /// Deleted todos, newest first, then ID.
    public static func deleted(_ a: TodoItem, _ b: TodoItem) -> Bool {
        let left = a.deletedAt ?? 0, right = b.deletedAt ?? 0
        return left != right ? left > right : precedes(a.id, b.id)
    }

    /// A key between `a` and `b` (nil: the list's start or end), for where
    /// a todo shows until the computer gives it its own. Keys are decimal
    /// fractions compared by bytes; the one made is the shortest midpoint.
    public static func key(between a: String?, and b: String?) -> String {
        let low = Array((a ?? "").utf8)
        let high = b.map { Array($0.utf8) }
        let floor = UInt8(ascii: "0") - 1, ceiling = UInt8(ascii: "9") + 1
        var result: [UInt8] = []
        var bounded = high != nil
        var index = 0
        while index < 64 {
            let lower = index < low.count ? low[index] : floor
            let upper = bounded && index < (high?.count ?? 0) ? high![index] : ceiling
            if lower == upper {
                result.append(lower)
                index += 1
                continue
            }
            if upper > lower + 1 {
                result.append(lower + (upper - lower) / 2)
                return String(decoding: result, as: UTF8.self)
            }
            // Next to each other here. With `a` used up, anything under
            // `b`'s byte will do, a digit or not: the key is only local.
            if lower == floor { return String(decoding: result + [floor], as: UTF8.self) }
            // Else keep `a`'s byte, and find room after it above what `a`
            // has left.
            result.append(lower)
            bounded = false
            index += 1
        }
        return String(decoding: result, as: UTF8.self)
    }
}

/// A permanent revision of a todo: its whole state after one change, and
/// who made it (`GET …/:todoId/versions`).
public struct TodoRevision: Equatable, Sendable {
    public var todo: TodoItem
    /// The person, when one is known.
    public var userId: String?
    /// The agent that made it, for a tool's change.
    public var agentId: String?
    /// `api` or `tool`.
    public var source: String

    public init(todo: TodoItem, userId: String? = nil, agentId: String? = nil, source: String = "api") {
        self.todo = todo
        self.userId = userId
        self.agentId = agentId
        self.source = source
    }

    public init?(json: JSONValue) {
        guard let todo = json["todo"].flatMap(TodoItem.init(json:)) else { return nil }
        self.init(todo: todo, userId: json["actor"]?["userId"]?.stringValue, agentId: json["actor"]?["agentId"]?.stringValue, source: json["source"]?.stringValue ?? "api")
    }

    /// What a revision did to the todo before it.
    public indirect enum Change: Equatable, Sendable {
        case created
        case edited(from: String)
        case completed
        case reopened
        case deleted
        case restored
        case moved
        /// The text changed and the state too, in one go.
        case editedAnd(Change)
    }

    /// What each of `revisions` (oldest first) changed.
    public static func changes(_ revisions: [TodoRevision]) -> [Change] {
        var previous: TodoItem?
        return revisions.map { revision in
            defer { previous = revision.todo }
            guard let before = previous else { return .created }
            let now = revision.todo
            let state: Change? = switch (before.status, now.status) {
            case (.active, .completed): .completed
            case (.completed, .active): .reopened
            case (_, .deleted) where before.status != .deleted: .deleted
            case (.deleted, _) where now.status != .deleted: .restored
            default: nil
            }
            if before.text != now.text {
                return state.map { .editedAnd($0) } ?? .edited(from: before.text)
            }
            return state ?? .moved
        }
    }
}
