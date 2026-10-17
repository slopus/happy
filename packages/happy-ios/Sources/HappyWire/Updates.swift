import Foundation

// Persistent `update` events from the socket, as built by
// packages/happy-server/sources/app/events/eventRouter.ts and validated by
// packages/happy-app/sources/sync/apiTypes.ts.

/// A versioned encrypted value. The server bumps `version` on every write,
/// which is what lets the local store ignore stale or replayed updates.
public struct VersionedValue: Codable, Hashable, Sendable {
    public var version: Int
    public var value: String?

    public init(version: Int, value: String?) {
        self.version = version
        self.value = value
    }
}

public struct UpdateContainer: Decodable, Sendable {
    public var id: String
    /// Account-wide update sequence.
    public var seq: Int
    public var body: UpdateBody
    public var createdAt: Int64

    public init(id: String, seq: Int, body: UpdateBody, createdAt: Int64) {
        self.id = id
        self.seq = seq
        self.body = body
        self.createdAt = createdAt
    }
}

public struct NewSessionUpdate: Codable, Hashable, Sendable {
    public var id: String
    public var seq: Int?
    public var metadata: String?
    public var metadataVersion: Int?
    public var agentState: String?
    public var agentStateVersion: Int?
    public var dataEncryptionKey: String?
    public var projectId: String?
    public var active: Bool?
    public var activeAt: Int64?
    public var createdAt: Int64
    public var updatedAt: Int64
    public var avatar: AvatarDescriptor?
    public var avatarVersion: Int?

    private enum CodingKeys: String, CodingKey {
        case id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey
        case projectId, active, activeAt, createdAt, updatedAt, avatar, avatarVersion
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        metadata = try c.decodeIfPresent(String.self, forKey: .metadata)
        metadataVersion = try c.decodeIfPresent(Int.self, forKey: .metadataVersion)
        agentState = try c.decodeIfPresent(String.self, forKey: .agentState)
        agentStateVersion = try c.decodeIfPresent(Int.self, forKey: .agentStateVersion)
        dataEncryptionKey = try c.decodeIfPresent(String.self, forKey: .dataEncryptionKey)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        active = try c.decodeIfPresent(Bool.self, forKey: .active)
        activeAt = try c.decodeIfPresent(Int64.self, forKey: .activeAt)
        createdAt = try c.decode(Int64.self, forKey: .createdAt)
        updatedAt = try c.decode(Int64.self, forKey: .updatedAt)
        avatar = try? c.decodeIfPresent(AvatarDescriptor.self, forKey: .avatar)
        avatarVersion = (try? c.decodeIfPresent(Int.self, forKey: .avatarVersion)).flatMap { $0 >= 0 ? $0 : nil }
    }

    /// The server sends the full row; older servers sent only the id, in
    /// which case the session has to be fetched.
    public var asSession: APISession? {
        guard let metadata, let metadataVersion else { return nil }
        return APISession(
            id: id,
            seq: seq ?? 0,
            createdAt: createdAt,
            updatedAt: updatedAt,
            active: active ?? false,
            activeAt: activeAt ?? updatedAt,
            metadata: metadata,
            metadataVersion: metadataVersion,
            agentState: agentState,
            agentStateVersion: agentStateVersion ?? 0,
            dataEncryptionKey: dataEncryptionKey,
            projectId: projectId, avatar: avatar, avatarVersion: avatarVersion
        )
    }
}

public struct UpdateSessionUpdate: Decodable, Hashable, Sendable {
    public var id: String
    public var metadata: VersionedValue?
    public var agentState: VersionedValue?
    /// `nil`: unchanged. `.some(nil)`: unlinked from its project.
    public var projectId: String??
    public var avatar: AvatarDescriptor??
    public var avatarVersion: Int?

    public init(id: String, metadata: VersionedValue? = nil, agentState: VersionedValue? = nil, projectId: String?? = nil, avatar: AvatarDescriptor?? = nil, avatarVersion: Int? = nil) {
        self.id = id
        self.metadata = metadata
        self.agentState = agentState
        self.projectId = projectId
        self.avatar = avatar
        self.avatarVersion = avatarVersion
    }

    private enum Keys: String, CodingKey {
        case id, metadata, agentState, projectId, avatar, avatarVersion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        id = try container.decode(String.self, forKey: .id)
        metadata = try container.decodeIfPresent(VersionedValue.self, forKey: .metadata)
        agentState = try container.decodeIfPresent(VersionedValue.self, forKey: .agentState)
        if container.contains(.avatar), (try? container.decodeNil(forKey: .avatar)) == true {
            avatar = .some(nil)
        } else if let descriptor = try? container.decode(AvatarDescriptor.self, forKey: .avatar) {
            avatar = .some(descriptor)
        } else {
            avatar = nil // malformed patches leave current artwork unchanged
        }
        avatarVersion = (try? container.decodeIfPresent(Int.self, forKey: .avatarVersion)).flatMap { $0 >= 0 ? $0 : nil }
        if container.contains(.projectId) {
            projectId = .some(try container.decodeIfPresent(String.self, forKey: .projectId))
        } else {
            projectId = nil
        }
    }
}

public struct NewMachineUpdate: Codable, Hashable, Sendable {
    public var machineId: String
    public var seq: Int
    public var metadata: String
    public var metadataVersion: Int
    public var daemonState: String?
    public var daemonStateVersion: Int
    public var dataEncryptionKey: String?
    public var active: Bool
    public var activeAt: Int64
    public var createdAt: Int64
    public var updatedAt: Int64

    public var asMachine: APIMachine {
        APIMachine(
            id: machineId,
            metadata: metadata,
            metadataVersion: metadataVersion,
            daemonState: daemonState,
            daemonStateVersion: daemonStateVersion,
            dataEncryptionKey: dataEncryptionKey,
            seq: seq,
            active: active,
            activeAt: activeAt,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

public struct UpdateMachineUpdate: Codable, Hashable, Sendable {
    public var machineId: String
    public var metadata: VersionedValue?
    public var daemonState: VersionedValue?
    public var active: Bool?
    public var activeAt: Int64?

    public init(machineId: String, metadata: VersionedValue? = nil, daemonState: VersionedValue? = nil, active: Bool? = nil, activeAt: Int64? = nil) {
        self.machineId = machineId
        self.metadata = metadata
        self.daemonState = daemonState
        self.active = active
        self.activeAt = activeAt
    }
}

/// `update-account`. Each profile field is a patch: absent leaves it
/// alone, `null` clears it.
public struct UpdateAccountUpdate: Decodable, Hashable, Sendable {
    public var id: String
    public var settings: VersionedValue?
    public var firstName: String??
    public var lastName: String??
    public var avatar: ImageRef??
    public var github: GitHubProfile??

    public init(
        id: String, settings: VersionedValue? = nil, firstName: String?? = nil, lastName: String?? = nil,
        avatar: ImageRef?? = nil, github: GitHubProfile?? = nil
    ) {
        self.id = id
        self.settings = settings
        self.firstName = firstName
        self.lastName = lastName
        self.avatar = avatar
        self.github = github
    }

    private enum Keys: String, CodingKey {
        case id, settings, firstName, lastName, avatar, github
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        id = try container.decode(String.self, forKey: .id)
        settings = try container.decodeIfPresent(VersionedValue.self, forKey: .settings)
        firstName = try Self.patch(container, .firstName)
        lastName = try Self.patch(container, .lastName)
        avatar = container.contains(.avatar) ? .some(try? container.decodeIfPresent(ImageRef.self, forKey: .avatar)) : nil
        github = container.contains(.github) ? .some(try? container.decodeIfPresent(GitHubProfile.self, forKey: .github)) : nil
    }

    private static func patch(_ container: KeyedDecodingContainer<Keys>, _ key: Keys) throws -> String?? {
        container.contains(key) ? .some(try container.decodeIfPresent(String.self, forKey: key)) : nil
    }

    /// True when the update touches the profile, not just settings.
    public var patchesProfile: Bool {
        firstName != nil || lastName != nil || avatar != nil || github != nil
    }
}

public struct KVChange: Codable, Hashable, Sendable {
    public var key: String
    public var value: String?
    public var version: Int
}

public enum UpdateBody: Sendable {
    case newMessage(sessionId: String, message: SessionMessage)
    case newSession(NewSessionUpdate)
    case updateSession(UpdateSessionUpdate)
    case deleteSession(sessionId: String)
    case newMachine(NewMachineUpdate)
    case updateMachine(UpdateMachineUpdate)
    case deleteMachine(machineId: String)
    case updateAccount(UpdateAccountUpdate)
    case kvBatchUpdate([KVChange])
    /// A project was created or changed; the update carries only its id.
    case newProject(projectId: String)
    case updateProject(projectId: String)
    case deleteProject(projectId: String)
    /// Artifacts, feed and friends: not synced by this app yet.
    case unsupported(type: String)
}

extension UpdateBody: Decodable {
    private enum Keys: String, CodingKey {
        case t, sid, message, changes, machineId, projectId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let type = try container.decode(String.self, forKey: .t)
        switch type {
        case "new-message":
            self = .newMessage(
                sessionId: try container.decode(String.self, forKey: .sid),
                message: try container.decode(SessionMessage.self, forKey: .message)
            )
        case "new-session":
            self = .newSession(try NewSessionUpdate(from: decoder))
        case "update-session":
            self = .updateSession(try UpdateSessionUpdate(from: decoder))
        case "delete-session":
            self = .deleteSession(sessionId: try container.decode(String.self, forKey: .sid))
        case "new-machine":
            self = .newMachine(try NewMachineUpdate(from: decoder))
        case "update-machine":
            self = .updateMachine(try UpdateMachineUpdate(from: decoder))
        case "delete-machine":
            self = .deleteMachine(machineId: try container.decode(String.self, forKey: .machineId))
        case "update-account":
            self = .updateAccount(try UpdateAccountUpdate(from: decoder))
        case "kv-batch-update":
            self = .kvBatchUpdate(try container.decode([KVChange].self, forKey: .changes))
        case "new-project":
            self = .newProject(projectId: try container.decode(String.self, forKey: .projectId))
        case "update-project":
            self = .updateProject(projectId: try container.decode(String.self, forKey: .projectId))
        case "delete-project":
            self = .deleteProject(projectId: try container.decode(String.self, forKey: .projectId))
        default:
            self = .unsupported(type: type)
        }
    }
}

/// Transient `ephemeral` events: presence and activity, never persisted.
public enum EphemeralEvent: Decodable, Sendable, Equatable {
    case activity(sessionId: String, active: Bool, activeAt: Int64, thinking: Bool)
    case machineActivity(machineId: String, active: Bool, activeAt: Int64)
    case machineStatus(machineId: String, online: Bool, timestamp: Int64)
    case sessionEvent(sessionId: String, kind: String, title: String, body: String, timestamp: Int64)
    case unsupported(type: String)

    private enum Keys: String, CodingKey {
        case type, id, active, activeAt, thinking, machineId, online, timestamp, sessionId, kind, title, body
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "activity":
            self = .activity(
                sessionId: try container.decode(String.self, forKey: .id),
                active: try container.decode(Bool.self, forKey: .active),
                activeAt: try container.decode(Int64.self, forKey: .activeAt),
                thinking: try container.decodeIfPresent(Bool.self, forKey: .thinking) ?? false
            )
        case "machine-activity":
            self = .machineActivity(
                machineId: try container.decode(String.self, forKey: .id),
                active: try container.decode(Bool.self, forKey: .active),
                activeAt: try container.decode(Int64.self, forKey: .activeAt)
            )
        case "machine-status":
            self = .machineStatus(
                machineId: try container.decode(String.self, forKey: .machineId),
                online: try container.decode(Bool.self, forKey: .online),
                timestamp: try container.decode(Int64.self, forKey: .timestamp)
            )
        case "session-event":
            self = .sessionEvent(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                kind: try container.decode(String.self, forKey: .kind),
                title: try container.decode(String.self, forKey: .title),
                body: try container.decode(String.self, forKey: .body),
                timestamp: try container.decode(Int64.self, forKey: .timestamp)
            )
        default:
            self = .unsupported(type: type)
        }
    }
}
