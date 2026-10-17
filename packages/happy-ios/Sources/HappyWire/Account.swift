import Foundation

// Account-level payloads beyond settings: the profile, connected services,
// push tokens, projects and usage (packages/happy-server/sources/app/api/routes,
// validated as packages/happy-app/sources/sync/profile.ts, apiPush.ts,
// apiProjects.ts and apiUsage.ts do).

// MARK: Profile

/// An uploaded image, as the server stores it.
public struct ImageRef: Codable, Hashable, Sendable {
    public var width: Double
    public var height: Double
    public var thumbhash: String
    public var path: String
    public var url: String

    public init(width: Double, height: Double, thumbhash: String, path: String, url: String) {
        self.width = width
        self.height = height
        self.thumbhash = thumbhash
        self.path = path
        self.url = url
    }
}

/// The GitHub user the account is connected to. The server forwards GitHub's
/// own user object, so everything but `id` and `login` is optional here:
/// GitHub sends `null` for a missing name or bio.
public struct GitHubProfile: Codable, Hashable, Sendable {
    public var id: Int64
    public var login: String
    public var name: String?
    public var avatarURL: String?
    public var email: String?
    public var bio: String?

    public init(id: Int64, login: String, name: String? = nil, avatarURL: String? = nil, email: String? = nil, bio: String? = nil) {
        self.id = id
        self.login = login
        self.name = name
        self.avatarURL = avatarURL
        self.email = email
        self.bio = bio
    }

    private enum CodingKeys: String, CodingKey {
        case id, login, name, email, bio
        case avatarURL = "avatar_url"
    }
}

/// `GET /v1/account/profile`.
public struct AccountProfile: Codable, Hashable, Sendable {
    public var id: String
    /// Server time of the snapshot; live `update-account` patches carry their
    /// own, so an older fetch never overwrites a newer patch.
    public var timestamp: Int64
    public var firstName: String?
    public var lastName: String?
    public var avatar: ImageRef?
    public var github: GitHubProfile?
    /// Vendors with a stored token, e.g. `anthropic`.
    public var connectedServices: [String]

    public init(
        id: String, timestamp: Int64, firstName: String? = nil, lastName: String? = nil,
        avatar: ImageRef? = nil, github: GitHubProfile? = nil, connectedServices: [String] = []
    ) {
        self.id = id
        self.timestamp = timestamp
        self.firstName = firstName
        self.lastName = lastName
        self.avatar = avatar
        self.github = github
        self.connectedServices = connectedServices
    }

    private enum CodingKeys: String, CodingKey {
        case id, timestamp, firstName, lastName, avatar, github, connectedServices
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        timestamp = try container.decode(Int64.self, forKey: .timestamp)
        firstName = try container.decodeIfPresent(String.self, forKey: .firstName)
        lastName = try container.decodeIfPresent(String.self, forKey: .lastName)
        // A malformed image or GitHub object must not cost the whole profile.
        avatar = try? container.decodeIfPresent(ImageRef.self, forKey: .avatar)
        github = try? container.decodeIfPresent(GitHubProfile.self, forKey: .github)
        connectedServices = try container.decodeIfPresent([String].self, forKey: .connectedServices) ?? []
    }

    /// profile.ts `getDisplayName`: the account's own name, else GitHub's.
    public var displayName: String? {
        let parts = [firstName, lastName].compactMap { $0 }.filter { !$0.isEmpty }
        if !parts.isEmpty { return parts.joined(separator: " ") }
        if let name = github?.name, !name.isEmpty { return name }
        if let login = github?.login, !login.isEmpty { return login }
        return nil
    }

    /// profile.ts `getAvatarUrl`.
    public var avatarURL: String? {
        if let url = avatar?.url, !url.isEmpty { return url }
        if let url = github?.avatarURL, !url.isEmpty { return url }
        return nil
    }

    /// profile.ts `getBio`.
    public var bio: String? {
        guard let bio = github?.bio, !bio.isEmpty else { return nil }
        return bio
    }
}

/// `GET /v1/connect/github/params`.
public struct GitHubOAuthParams: Codable, Sendable {
    public var url: String
}

// MARK: Push tokens

/// An element of `GET /v1/push-tokens`.
public struct PushToken: Codable, Hashable, Sendable {
    public var id: String
    public var token: String
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(id: String, token: String, createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.token = token
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct PushTokensResponse: Codable, Sendable {
    public var tokens: [PushToken]
}

// MARK: Projects

/// An element of `GET /v1/projects?ids=`. Metadata is ciphertext under the
/// project's own data key, or under the account secret when there is none.
public struct APIProject: Codable, Hashable, Sendable {
    public var id: String
    public var externalId: String
    public var metadata: String
    public var metadataVersion: Int
    public var dataEncryptionKey: String?
    public var createdAt: Int64
    public var updatedAt: Int64
    public var avatar: AvatarDescriptor?

    public init(
        id: String, externalId: String, metadata: String, metadataVersion: Int,
        dataEncryptionKey: String?, createdAt: Int64, updatedAt: Int64, avatar: AvatarDescriptor? = nil
    ) {
        self.id = id
        self.externalId = externalId
        self.metadata = metadata
        self.metadataVersion = metadataVersion
        self.dataEncryptionKey = dataEncryptionKey
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.avatar = avatar
    }
}

public struct ProjectsResponse: Decodable, Sendable {
    public var projects: [APIProject]

    private enum CodingKeys: String, CodingKey {
        case projects
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // apiProjects.ts drops malformed records rather than the batch.
        let items = try container.decodeIfPresent([Lenient<APIProject>].self, forKey: .projects) ?? []
        projects = items.compactMap(\.value)
    }
}

/// Decodes to nil instead of failing the surrounding array.
struct Lenient<Value: Decodable>: Decodable {
    var value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

// MARK: Usage

/// `POST /v1/usage/query`. Times are Unix seconds.
public struct UsageQuery: Codable, Sendable, Equatable {
    public enum GroupBy: String, Codable, Sendable {
        case hour
        case day
    }

    public var sessionId: String?
    public var startTime: Int64
    public var endTime: Int64
    public var groupBy: GroupBy

    public init(sessionId: String? = nil, startTime: Int64, endTime: Int64, groupBy: GroupBy) {
        self.sessionId = sessionId
        self.startTime = startTime
        self.endTime = endTime
        self.groupBy = groupBy
    }
}

public struct UsageDataPoint: Codable, Hashable, Sendable {
    public var timestamp: Int64
    public var tokens: [String: Double]
    public var cost: [String: Double]
    public var reportCount: Int

    public init(timestamp: Int64, tokens: [String: Double], cost: [String: Double], reportCount: Int) {
        self.timestamp = timestamp
        self.tokens = tokens
        self.cost = cost
        self.reportCount = reportCount
    }
}

public struct UsageResponse: Codable, Sendable {
    public var usage: [UsageDataPoint]

    public init(usage: [UsageDataPoint]) {
        self.usage = usage
    }
}

// MARK: RPC

/// The acknowledgement of a socket `rpc-call`. `result` is ciphertext under
/// the target record's key.
public struct RPCCallResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var result: String?
    public var error: String?

    public init(ok: Bool, result: String? = nil, error: String? = nil) {
        self.ok = ok
        self.result = result
        self.error = error
    }
}
