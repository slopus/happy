import Foundation

/// The read-only fields of a Happy Cloud zone. A null member list admits the whole team.
public struct CloudZone: Decodable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let color: String
    public let critical: Bool
    public let isDefault: Bool
    public let members: [String]?
}

/// Only the metadata displayed in settings. This does not decode or fetch secret values.
public struct CloudSecretMetadata: Decodable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let owner: String?
}

extension AgentClient {
    public func cloudZones() async throws -> [CloudZone] {
        struct Answer: Decodable { let zones: [Lossy<CloudZone>] }
        return try await decode(Answer.self, "GET", "/v0/zones").zones.compactMap(\.value)
    }

    public func cloudSecretMetadata() async throws -> [CloudSecretMetadata] {
        struct Page: Decodable {
            let secrets: [Lossy<CloudSecretMetadata>]
            let nextCursor: String?
        }
        let path = "/v0/cluster/secrets?limit=100"
        var secrets: [CloudSecretMetadata] = []
        var cursor: String?
        var cursors: Set<String> = []
        repeat {
            try Task.checkCancellation()
            let page = try await decode(Page.self, "GET", path + (cursor.map { "&cursor=\(Self.escape($0))" } ?? ""))
            secrets.append(contentsOf: page.secrets.compactMap(\.value))
            cursor = page.nextCursor
            if let cursor, !cursors.insert(cursor).inserted { throw AgentClientError.invalidResponse }
        } while cursor != nil
        return secrets
    }
}
