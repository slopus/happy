import Foundation
import HappyWire

/// A person a card's faces or a story names, as `GET /v0/users` has them.
public struct Person: Equatable, Sendable {
    public var name: String
    public var thumbhash: String?
    /// `/v0/users/:id/photo` has a picture to read.
    public var hasPhoto: Bool

    public static func photoPath(_ userId: String) -> String { "/v0/users/\(AgentClient.escape(userId))/photo" }
}

extension AgentClient {
    /// People by ID, a hundred a read; unknown ones are left out.
    public func people(_ ids: [String]) async throws -> [String: Person] {
        var people: [String: Person] = [:]
        for start in stride(from: 0, to: ids.count, by: 100) {
            let answer = try await decode(JSONValue.self, "GET", "/v0/users?ids=" + ids[start..<min(start + 100, ids.count)].map(Self.escape).joined(separator: ","))
            for user in answer["users"]?.arrayValue ?? [] {
                guard let id = user["id"]?.stringValue else { continue }
                let photo = user["photo"]?.objectValue
                people[id] = Person(name: user["name"]?.stringValue ?? "", thumbhash: photo?["thumbhash"]?.stringValue, hasPhoto: photo != nil)
            }
        }
        return people
    }
}
