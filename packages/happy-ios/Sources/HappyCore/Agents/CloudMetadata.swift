import Foundation

/// Someone a restricted zone admits (Zones v2): a person by their user ID,
/// or everyone in a team.
public struct ZonePrincipal: Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable { case user, team }
    public let kind: Kind
    public let id: String

    public init(kind: Kind, id: String) {
        self.kind = kind
        self.id = id
    }

    enum CodingKeys: String, CodingKey { case kind, id }

    /// `{ "kind": "user" | "team", "id" }`, or a bare string, a user ID. A
    /// kind this build doesn't know throws, so a list leaves it out.
    public init(from decoder: Decoder) throws {
        if let id = try? decoder.singleValueContainer().decode(String.self) {
            self.init(kind: .user, id: id)
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let kind = Kind(rawValue: try container.decode(String.self, forKey: .kind)) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown principal kind")
        }
        self.init(kind: kind, id: try container.decode(String.self, forKey: .id))
    }
}

/// A zone as `GET /v0/zones` lists it (happy-cluster docs/zones.md), read
/// only: open to every member, or `restricted` to the people and teams in
/// `members`; its `internet` and `compute` replace the server defaults for
/// the agents in it (nil where the server doesn't say). Read tolerantly: a
/// server from before Zones v2 says `critical` for restricted, lists
/// members as bare user IDs (a list restricting the zone to them), has a
/// default zone (`isDefault`, not read), and no settings.
public struct CloudZone: Decodable, Equatable, Sendable {
    public enum Internet: String, Sendable { case on, off }
    public enum Compute: String, Sendable { case any, listed, none }

    public let id: String
    public let name: String
    public let description: String
    public let color: String
    public let restricted: Bool
    public let members: [ZonePrincipal]
    public let internet: Internet?
    public let compute: Compute?

    public init(id: String, name: String, description: String = "", color: String = "gray", restricted: Bool = false,
                members: [ZonePrincipal] = [], internet: Internet? = nil, compute: Compute? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.color = color
        self.restricted = restricted
        self.members = members
        self.internet = internet
        self.compute = compute
    }

    enum CodingKeys: String, CodingKey { case id, name, description, color, restricted, critical, members, settings }
    private struct Settings: Decodable {
        var internet: String?
        var compute: String?
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String? { (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil }
        func flag(_ key: CodingKeys) -> Bool? { (try? container.decodeIfPresent(Bool.self, forKey: key)) ?? nil }
        let listed = (try? container.decodeIfPresent([Lossy<ZonePrincipal>].self, forKey: .members)) ?? nil
        let settings = (try? container.decodeIfPresent(Settings.self, forKey: .settings)) ?? nil
        self.init(
            id: try container.decode(String.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            description: string(.description) ?? "",
            color: string(.color) ?? "gray",
            // Zones v2 made a critical zone restricted, and any other zone with a members list restricted to it.
            restricted: flag(.restricted) ?? (flag(.critical) == true || listed != nil),
            members: listed?.compactMap(\.value) ?? [],
            internet: settings?.internet.flatMap(Internet.init(rawValue:)),
            compute: settings?.compute.flatMap(Compute.init(rawValue:))
        )
    }
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
