import Foundation
import HappyWire

// What protocol 34 adds to a task (happy-agent `API.md`, rich tasks). Every
// field is optional; one this build can't read is left out, never a lost task.

/// A field that reads as nil when absent or unreadable, rather than failing what holds it.
@propertyWrapper public struct Lenient<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var wrappedValue: Value?
    public init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }
    public init(from decoder: Decoder) throws { wrappedValue = try? Value(from: decoder) }
    public func encode(to encoder: Encoder) throws { try wrappedValue.encode(to: encoder) }
}

/// A list that drops the entries it can't read, and reads as nil when it isn't one.
@propertyWrapper public struct LenientList<Element: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var wrappedValue: [Element]?
    public init(wrappedValue: [Element]?) { self.wrappedValue = wrappedValue }
    public init(from decoder: Decoder) throws { wrappedValue = (try? [Lossy<Element>](from: decoder))?.compactMap(\.value) }
    public func encode(to encoder: Encoder) throws { try wrappedValue.encode(to: encoder) }
}

extension KeyedDecodingContainer {
    func decode<T>(_ type: Lenient<T>.Type, forKey key: Key) throws -> Lenient<T> {
        (try? decodeIfPresent(type, forKey: key)) ?? Lenient(wrappedValue: nil)
    }
    func decode<T>(_ type: LenientList<T>.Type, forKey key: Key) throws -> LenientList<T> {
        (try? decodeIfPresent(type, forKey: key)) ?? LenientList(wrappedValue: nil)
    }
}

/// A task's picture; only the icon library's are drawn.
public struct TaskIcon: Codable, Equatable, Sendable {
    public var type: String
    public var slug: String?
    /// The SHA-256 of the daemon's 128px WebP; an older daemon sends none.
    @Lenient public var hash: String?

    public var librarySlug: String? { type == "library" ? slug : nil }

    /// Where the daemon serves its picture, versioned by its hash so a copy never goes stale; nil without a well-formed one.
    public var path: String? {
        guard let slug = librarySlug?.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-"])), let hash, hash.count == 64,
              hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return "/v0/task-icons/\(slug)?v=\(hash)"
    }
}

/// One choice about whether something shows under a task: a link, or a
/// derived child hidden. No choice is the default: what the task made shows.
public struct TaskChild: Codable, Equatable, Sendable {
    public struct Ref: Codable, Hashable, Sendable {
        /// `workspace`, `agent` or `artifact`.
        public var kind: String
        public var id: String
        public init(kind: String, id: String) { self.kind = kind; self.id = id }
    }
    public struct Who: Codable, Equatable, Sendable {
        public var agentId: String?
        public var userId: String?
    }

    public var ref: Ref
    /// `shown` or `hidden`.
    public var visibility: String
    public var by: Who?
    public var updatedAt: Double?
}

/// A header in the person's task list. It sits in the memberships' order-key
/// space: a task belongs to the last header whose key is below its own.
public struct TaskSection: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var orderKey: String
    public var collapsed: Bool?
}

/// An artifact a task's agents made (bootstrap `taskArtifacts`, newest first).
public struct TaskArtifact: Codable, Equatable, Sendable {
    public var artifactId: String
    public var taskId: String?
    public var agentId: String?
    public var title: String?
    public var type: String?
    public var updatedAt: Double?
}
