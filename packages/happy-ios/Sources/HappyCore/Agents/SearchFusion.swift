import Foundation
import HappyWire

/// The computer's search (`POST /v0/search`, happy-agent API.md "Search"),
/// and how its results fuse with what the phone finds in what it already
/// holds (`local`): Reciprocal Rank Fusion, as every client fuses them, so
/// each shows the same order.
extension Search {
    /// The fusion's constant: a result at position `p` scores `1 / (k + p)`.
    public static let k = 60.0

    /// What the phone asks for: what it can open. Projects and workspaces
    /// open nothing here, as their sidebar rows don't; people and skills
    /// have no screen on the phone.
    public static let types = ["vault_file", "vault_folder", "document", "message", "todo", "calendar_event", "artifact", "surface", "agent"]

    /// One thing the computer found. Every result has `type`, `key` and
    /// `rank`; the rest are its type's (API.md "Result types"), and fields
    /// the phone doesn't know are passed over.
    public struct Result: Decodable, Equatable, Sendable {
        public var type: String
        public var key: String
        public var rank: Int
        public var surfaceId: String?
        public var fileId: String?
        public var folderId: String?
        public var messageId: String?
        public var todoId: String?
        public var eventId: String?
        public var artifactId: String?
        public var agentId: String?
        /// An agent's or a message's workspace and project, when it has them.
        public var workspaceId: String?
        public var projectId: String?
        public var name: String?
        public var title: String?
        public var text: String?
        public var path: String?
        /// A vault file's `file` or `artifact`; an agent's `chat`, `task`, `subtask` or `bot`.
        public var kind: String?
        /// A message's `user` or `agent`.
        public var role: String?
        /// When a message was accepted, in epoch milliseconds.
        public var createdAt: Double?
        /// `name`, `content` or `path`.
        public var match: String?
        public var line: Int?
        public var snippet: String?
        public var status: String?
        public var artifactType: String?
        public var surfaceType: String?
        public var archived: Bool?

        public init(type: String, key: String, rank: Int) {
            self.type = type
            self.key = key
            self.rank = rank
        }

        /// What its row is called.
        public var label: String { name ?? title ?? text ?? snippet ?? "" }
    }

    public struct Answer: Equatable, Sendable {
        public var results: [Result]
        public var truncated: Bool
        public var partial: Bool
    }

    /// One fused result: its key, and where it stands in each list.
    public struct Fused: Equatable, Sendable {
        public var key: String
        public var remote: Int?
        public var local: Int?
    }

    /// The computer's results and the phone's, as one list: each scores
    /// `1 / (k + p)` in each list it is in, the computer's at its `rank`
    /// and the phone's at its 1-based position, summed for a key in both.
    /// Highest first; equal scores by the computer's rank, those it didn't
    /// return after, then by the phone's position. A key in both lists
    /// shows the computer's fields (`remote` set).
    public static func fuse(remote: [(key: String, rank: Int)], local: [String]) -> [Fused] {
        var remoteAt: [String: Int] = [:]
        var localAt: [String: Int] = [:]
        var keys: [String] = []
        for (index, result) in remote.enumerated() where remoteAt[result.key] == nil {
            remoteAt[result.key] = index
            keys.append(result.key)
        }
        for (index, key) in local.enumerated() where localAt[key] == nil {
            localAt[key] = index
            if remoteAt[key] == nil { keys.append(key) }
        }
        func score(_ key: String) -> Double {
            var total = 0.0
            if let index = remoteAt[key] { total += 1 / (k + Double(remote[index].rank)) }
            if let index = localAt[key] { total += 1 / (k + Double(index + 1)) }
            return total
        }
        let scored = keys.map { (key: $0, score: score($0), rank: remoteAt[$0].map { remote[$0].rank }, local: localAt[$0]) }
        return scored.sorted { a, b in
            if a.score != b.score { return a.score > b.score }
            if a.rank != b.rank { return (a.rank ?? .max) < (b.rank ?? .max) }
            return (a.local ?? .max) < (b.local ?? .max)
        }.map { Fused(key: $0.key, remote: remoteAt[$0.key], local: $0.local) }
    }
}

extension AgentClient {
    /// Whether the computer answers search (`capabilities.search`).
    public func servesSearch() async throws -> Bool {
        try await decode(JSONValue.self, "GET", "/v0/health")["capabilities"]?["search"]?.boolValue == true
    }

    /// What the computer finds for `query`, best first. Results of a type
    /// the phone doesn't know are left out.
    public func search(_ query: String, types: [String] = Search.types, limit: Int = 30) async throws -> Search.Answer {
        let body: JSONValue = .object(["q": .string(query), "types": .array(types.map(JSONValue.string)), "limit": .number(Double(limit))])
        let answer = try await decode(JSONValue.self, "POST", "/v0/search", json: body)
        let known = Set(types)
        let results = (answer["results"]?.arrayValue ?? []).compactMap { value -> Search.Result? in
            guard let data = try? JSONEncoder().encode(value), let result = try? JSONDecoder().decode(Search.Result.self, from: data) else { return nil }
            return known.contains(result.type) ? result : nil
        }
        return Search.Answer(results: results, truncated: answer["truncated"]?.boolValue ?? false, partial: answer["partial"]?.boolValue ?? false)
    }
}
