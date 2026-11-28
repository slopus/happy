import Foundation

/// A team on a Happy Cloud server (`GET /v0/teams`, happy-cluster
/// docs/teams.md): a named group of the server's people holding
/// permissions. `owners` (everyone with the owner flag) and `members`
/// (everyone) are derived; the rest are the server's own, and may hold
/// other teams, whose people are then in them too.
public struct Team: Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable { case owners, members, custom }

    public static let owners = "owners"
    public static let members = "members"

    public var id: String
    public var kind: Kind
    public var name: String
    /// The teams directly inside it.
    public var teams: [String]

    public init(id: String, kind: Kind = .custom, name: String, teams: [String] = []) {
        self.id = id
        self.kind = kind
        self.name = name
        self.teams = teams
    }

    enum CodingKeys: String, CodingKey { case id, kind, name, teams }

    /// A kind it doesn't know is the server's own; a name it can't read is
    /// the ID.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = (try? container.decodeIfPresent(String.self, forKey: .kind)).flatMap { $0.flatMap(Kind.init(rawValue:)) }
            ?? (id == Self.owners ? .owners : id == Self.members ? .members : .custom)
        name = (try? container.decodeIfPresent(String.self, forKey: .name)).flatMap { $0 } ?? id
        teams = ((try? container.decodeIfPresent([Lossy<String>].self, forKey: .teams)) ?? nil)?.compactMap(\.value) ?? []
    }
}

/// Someone on a Happy Cloud server as `GET /v0/members` lists them: the
/// custom teams they are directly in and their owner flag. A server from
/// before teams says only `role` (`owner`, `admin`, `member`, `viewer`
/// or a role it made), read as the same two: an owner, and a role of the
/// server's own as the team it became.
public struct ServerMember: Decodable, Equatable, Sendable {
    public var accountId: String
    public var userId: String?
    public var name: String?
    public var teams: [String]
    public var owner: Bool

    public init(accountId: String, userId: String? = nil, name: String? = nil, teams: [String] = [], owner: Bool = false) {
        self.accountId = accountId
        self.userId = userId
        self.name = name
        self.teams = teams
        self.owner = owner
    }

    enum CodingKeys: String, CodingKey { case accountId, userId, name, teams, owner, role }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try container.decode(String.self, forKey: .accountId)
        userId = (try? container.decodeIfPresent(String.self, forKey: .userId)) ?? nil
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? nil
        let role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? nil
        owner = ((try? container.decodeIfPresent(Bool.self, forKey: .owner)) ?? nil) ?? (role == "owner")
        teams = ((try? container.decodeIfPresent([Lossy<String>].self, forKey: .teams)) ?? nil)?.compactMap(\.value)
            ?? role.map { ["owner", "member", "viewer"].contains($0) ? [] : [$0] } ?? []
    }
}

/// What someone is on a server, for showing: an owner or not, and the
/// custom teams they are in, by name.
public struct TeamStanding: Equatable, Sendable {
    public var owner: Bool
    /// Every custom team they are in, directly or because a team they are
    /// in (`owners` and `members` among them) is inside it, in the
    /// server's order (by name). One the list doesn't have, made or
    /// deleted since, comes last by its ID.
    public var teams: [String]

    public init(owner: Bool, teams: [String] = []) {
        self.owner = owner
        self.teams = teams
    }

    /// `member`'s standing among `teams`, flattened as the server does
    /// (`hc_core::team::effective`): only custom teams hold teams, and a
    /// cycle ends.
    public init(_ member: ServerMember, teams: [Team]) {
        var inside: Set<String> = Set(member.teams).union([Team.members])
        if member.owner { inside.insert(Team.owners) }
        var grew = true
        while grew {
            grew = false
            for team in teams where team.kind == .custom && !inside.contains(team.id) && team.teams.contains(where: inside.contains) {
                inside.insert(team.id)
                grew = true
            }
        }
        let known = teams.filter { $0.kind == .custom && inside.contains($0.id) }
        let ids = Set(teams.map(\.id))
        let unknown = member.teams.filter { !ids.contains($0) && $0 != Team.owners && $0 != Team.members }
        self.init(owner: member.owner, teams: known.map(\.name) + unknown)
    }
}

extension AgentClient {
    /// The server's teams: `owners`, `members`, then its own by name. A
    /// server from before teams has its roles instead (`GET /v0/roles`,
    /// deprecated), read as the teams they became; drop that once every
    /// server has teams. A team it can't read is left out.
    public func teams() async throws -> [Team] {
        struct Response: Decodable { let teams: [Lossy<Team>] }
        do {
            return try await decode(Response.self, "GET", "/v0/teams").teams.compactMap(\.value)
        } catch AgentClientError.status(404, _, _), AgentClientError.status(405, _, _) {
            struct Role: Decodable { let id: String; let name: String }
            struct Roles: Decodable { let roles: [Lossy<Role>] }
            return try await decode(Roles.self, "GET", "/v0/roles").roles.compactMap(\.value).map { role in
                Team(id: role.id, kind: role.id == "owner" ? .owners : role.id == "member" ? .members : .custom, name: role.name)
            }
        }
    }

    /// Everyone on the server (`GET /v0/members`, any member); someone it
    /// can't read is left out.
    public func members() async throws -> [ServerMember] {
        struct Response: Decodable { let members: [Lossy<ServerMember>] }
        return try await decode(Response.self, "GET", "/v0/members").members.compactMap(\.value)
    }
}
