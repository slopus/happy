import Foundation

// Request/response bodies of the HTTP API the app uses
// (packages/happy-server/sources/app/api/routes).

// MARK: Sessions

/// A session row from `GET /v2/sessions` (and the `new-session` update).
public struct APISession: Codable, Hashable, Sendable {
    public var id: String
    /// Highest message seq allocated in this session.
    public var seq: Int
    public var createdAt: Int64
    /// Bumped by every write to the row, including each new message. This is
    /// the delta-sync cursor for `changedSince`.
    public var updatedAt: Int64
    public var active: Bool
    public var activeAt: Int64
    public var metadata: String
    public var metadataVersion: Int
    public var agentState: String?
    public var agentStateVersion: Int
    public var dataEncryptionKey: String?
    public var projectId: String?
    public var avatar: AvatarDescriptor?
    public var avatarVersion: Int?

    public init(
        id: String, seq: Int, createdAt: Int64, updatedAt: Int64, active: Bool, activeAt: Int64,
        metadata: String, metadataVersion: Int, agentState: String?, agentStateVersion: Int,
        dataEncryptionKey: String?, projectId: String?, avatar: AvatarDescriptor? = nil, avatarVersion: Int? = nil
    ) {
        self.id = id
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.active = active
        self.activeAt = activeAt
        self.metadata = metadata
        self.metadataVersion = metadataVersion
        self.agentState = agentState
        self.agentStateVersion = agentStateVersion
        self.dataEncryptionKey = dataEncryptionKey
        self.projectId = projectId
        self.avatar = avatar
        self.avatarVersion = avatarVersion
    }

    private enum CodingKeys: String, CodingKey {
        case id, seq, createdAt, updatedAt, active, activeAt, metadata, metadataVersion
        case agentState, agentStateVersion, dataEncryptionKey, projectId, avatar, avatarVersion
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        seq = try c.decode(Int.self, forKey: .seq)
        createdAt = try c.decode(Int64.self, forKey: .createdAt)
        updatedAt = try c.decode(Int64.self, forKey: .updatedAt)
        active = try c.decode(Bool.self, forKey: .active)
        activeAt = try c.decode(Int64.self, forKey: .activeAt)
        metadata = try c.decode(String.self, forKey: .metadata)
        metadataVersion = try c.decode(Int.self, forKey: .metadataVersion)
        agentState = try c.decodeIfPresent(String.self, forKey: .agentState)
        agentStateVersion = try c.decode(Int.self, forKey: .agentStateVersion)
        dataEncryptionKey = try c.decodeIfPresent(String.self, forKey: .dataEncryptionKey)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        // Bad artwork must never prevent the session list from syncing.
        avatar = try? c.decodeIfPresent(AvatarDescriptor.self, forKey: .avatar)
        avatarVersion = (try? c.decodeIfPresent(Int.self, forKey: .avatarVersion)).flatMap { $0 >= 0 ? $0 : nil }
    }
}

/// `GET /v2/sessions?cursor=&limit=&changedSince=`
public struct SessionsPage: Codable, Sendable {
    public var sessions: [APISession]
    public var nextCursor: String?
    public var hasNext: Bool

    public init(sessions: [APISession], nextCursor: String?, hasNext: Bool) {
        self.sessions = sessions
        self.nextCursor = nextCursor
        self.hasNext = hasNext
    }
}

// MARK: Messages

/// `GET /v3/sessions/:id/messages?after_seq=&limit=` (ascending) or
/// `?before_seq=` (descending).
public struct MessagesPage: Codable, Sendable {
    public var messages: [SessionMessage]
    public var hasMore: Bool

    public init(messages: [SessionMessage], hasMore: Bool) {
        self.messages = messages
        self.hasMore = hasMore
    }
}

/// `POST /v3/sessions/:id/messages`. `localId` makes the send idempotent:
/// the server returns the existing row for a repeated localId.
public struct SendMessagesRequest: Codable, Sendable {
    public struct Message: Codable, Sendable, Hashable {
        public var content: String
        public var localId: String

        public init(content: String, localId: String) {
            self.content = content
            self.localId = localId
        }
    }

    public var messages: [Message]

    public init(messages: [Message]) {
        self.messages = messages
    }
}

public struct SendMessagesResponse: Codable, Sendable {
    public struct Message: Codable, Sendable, Hashable {
        public var id: String
        public var seq: Int
        public var localId: String?
        public var createdAt: Int64
        public var updatedAt: Int64
    }

    public var messages: [Message]
}

// MARK: Machines

/// An element of `GET /v1/machines`.
public struct APIMachine: Codable, Hashable, Sendable {
    public var id: String
    public var metadata: String
    public var metadataVersion: Int
    public var daemonState: String?
    public var daemonStateVersion: Int
    public var dataEncryptionKey: String?
    public var seq: Int
    public var active: Bool
    public var activeAt: Int64
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(
        id: String, metadata: String, metadataVersion: Int, daemonState: String?, daemonStateVersion: Int,
        dataEncryptionKey: String?, seq: Int, active: Bool, activeAt: Int64, createdAt: Int64, updatedAt: Int64
    ) {
        self.id = id
        self.metadata = metadata
        self.metadataVersion = metadataVersion
        self.daemonState = daemonState
        self.daemonStateVersion = daemonStateVersion
        self.dataEncryptionKey = dataEncryptionKey
        self.seq = seq
        self.active = active
        self.activeAt = activeAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, metadata, metadataVersion, daemonState, daemonStateVersion, dataEncryptionKey
        case seq, active, activeAt, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        metadata = try container.decode(String.self, forKey: .metadata)
        metadataVersion = try container.decode(Int.self, forKey: .metadataVersion)
        daemonState = try container.decodeIfPresent(String.self, forKey: .daemonState)
        daemonStateVersion = try container.decodeIfPresent(Int.self, forKey: .daemonStateVersion) ?? 0
        dataEncryptionKey = try container.decodeIfPresent(String.self, forKey: .dataEncryptionKey)
        seq = try container.decode(Int.self, forKey: .seq)
        active = try container.decode(Bool.self, forKey: .active)
        activeAt = try container.decode(Int64.self, forKey: .activeAt)
        createdAt = try container.decode(Int64.self, forKey: .createdAt)
        updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
    }
}

// MARK: Account

/// `GET /v1/account/settings`. Settings are a secretbox bundle sealed with
/// the account secret (they belong to the account, not to a record).
public struct AccountSettingsResponse: Codable, Sendable {
    public var settings: String?
    public var settingsVersion: Int
}

/// `POST /v1/account/settings`
public struct UpdateAccountSettingsRequest: Codable, Sendable {
    public var settings: String?
    public var expectedVersion: Int

    public init(settings: String?, expectedVersion: Int) {
        self.settings = settings
        self.expectedVersion = expectedVersion
    }
}

public enum UpdateAccountSettingsResponse: Decodable, Sendable, Equatable {
    case success(version: Int)
    case versionMismatch(currentVersion: Int, currentSettings: String?)

    private enum Keys: String, CodingKey {
        case success, version, error, currentVersion, currentSettings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if try container.decode(Bool.self, forKey: .success) {
            self = .success(version: try container.decode(Int.self, forKey: .version))
        } else {
            self = .versionMismatch(
                currentVersion: try container.decode(Int.self, forKey: .currentVersion),
                currentSettings: try container.decodeIfPresent(String.self, forKey: .currentSettings)
            )
        }
    }
}

// MARK: Auth

/// `POST /v1/auth`: proves ownership of the account signing key.
public struct AuthRequest: Codable, Sendable {
    public var publicKey: String
    public var challenge: String
    public var signature: String

    public init(publicKey: String, challenge: String, signature: String) {
        self.publicKey = publicKey
        self.challenge = challenge
        self.signature = signature
    }
}

public struct AuthResponse: Codable, Sendable {
    public var success: Bool
    public var token: String
}

/// `POST /v1/auth/account/request`: a new device asking an existing one
/// for the account (QR login). Polled until `authorized`.
public struct AccountAuthRequest: Codable, Sendable {
    public var publicKey: String

    public init(publicKey: String) {
        self.publicKey = publicKey
    }
}

public enum AccountAuthState: Decodable, Sendable, Equatable {
    case requested
    case authorized(token: String, response: String)

    private enum Keys: String, CodingKey {
        case state, token, response
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let state = try container.decode(String.self, forKey: .state)
        switch state {
        case "authorized":
            self = .authorized(
                token: try container.decode(String.self, forKey: .token),
                response: try container.decode(String.self, forKey: .response)
            )
        default:
            self = .requested
        }
    }
}

/// `GET /v1/auth/request/status?publicKey=` for a terminal's request.
public struct TerminalAuthStatus: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case notFound = "not_found"
        case pending
        case authorized
    }

    public var status: Status
    public var supportsV2: Bool

    public init(status: Status, supportsV2: Bool) {
        self.status = status
        self.supportsV2 = supportsV2
    }
}

/// Body of `POST /v1/auth/response` and `POST /v1/auth/account/response`.
public struct AuthApproval: Codable, Sendable {
    public var publicKey: String
    public var response: String

    public init(publicKey: String, response: String) {
        self.publicKey = publicKey
        self.response = response
    }
}

public struct SuccessResponse: Codable, Sendable {
    public var success: Bool
}
