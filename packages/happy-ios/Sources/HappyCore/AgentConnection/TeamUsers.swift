import Foundation
import HappyWire

/// A team member as `GET /v0/users` describes them (happy-agent
/// `protocol/users.ts`): their name and their picture's ThumbHash, the
/// bytes being at `/v0/users/<id>/photo`. Kept with the bootstrap, so a
/// relaunch draws the faces the rows wear before the computer answers.
public struct TeamUser: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var photo: AgentWire.Profile.Photo?

    public init(id: String, name: String, photo: AgentWire.Profile.Photo? = nil) {
        self.id = id
        self.name = name
        self.photo = photo
    }

    enum CodingKeys: String, CodingKey { case id, name, photo }

    /// A picture it can't read is none, never a lost member.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = (try? container.decode(String.self, forKey: .name)) ?? ""
        photo = try? container.decodeIfPresent(AgentWire.Profile.Photo.self, forKey: .photo)
    }

    /// Where a member's picture is read.
    public static func photoPath(_ id: String) -> String { "/v0/users/\(AgentClient.escape(id))/photo" }
}

extension AgentClient {
    /// Team members by ID, at most 100 a read; unknown ones are left out.
    public func teamUsers(_ ids: [String]) async throws -> [TeamUser] {
        guard !ids.isEmpty else { return [] }
        struct Response: Decodable { let users: [Lossy<TeamUser>] }
        let answer = try await decode(Response.self, "GET", "/v0/users?ids=" + ids.prefix(100).map(Self.escape).joined(separator: ","))
        return answer.users.compactMap(\.value)
    }
}
