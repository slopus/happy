import Foundation
import GRDB
import HappyWire

// Rows of the on-device store. Each synced record keeps two copies of its
// encrypted fields: the ciphertext exactly as the server sent it, and the
// decrypted JSON. The ciphertext lets the app re-derive the plaintext after
// a model change without refetching; the JSON is what the UI reads.

/// A session as last seen from the server, plus local sync bookkeeping.
public struct SessionRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "session"

    public var id: String
    /// Highest message seq the server has allocated in this session.
    public var seq: Int
    public var createdAt: Int64
    public var updatedAt: Int64
    public var active: Bool
    public var activeAt: Int64
    public var projectId: String?
    public var avatar: AvatarDescriptor?
    public var avatarVersion: Int?
    public var avatarUpdateSeq: Int?

    public var metadataVersion: Int
    public var metadataCipher: String
    public var metadata: JSONValue?

    public var agentStateVersion: Int
    public var agentStateCipher: String?
    public var agentState: JSONValue?

    /// The wrapped data encryption key (`0x00 || box`), base64. Kept so the
    /// key can be reopened from the account secret on the next launch; the
    /// raw key is never written to disk.
    public var dataKeyCipher: String?
    /// False when this session cannot be opened with the current protocol
    /// (no data key, or a key not wrapped to this account).
    public var decryptable: Bool

    /// Every message with `seq <= syncedMessageSeq` is stored locally. The
    /// next delta fetch asks for `after_seq = syncedMessageSeq`.
    public var syncedMessageSeq: Int
    /// This device's last accepted send, persisted for activity ordering.
    /// Wire updates never overwrite it; retries do not advance it.
    public var lastMessageSentAt: Int64?

    /// The agent is working on a turn. Only `activity` ephemerals carry it,
    /// so it is local, cleared on launch and whenever the session goes
    /// inactive (a dead session never sends the ephemeral that clears it).
    public var thinking: Bool
    public var thinkingAt: Int64
    /// The agent finished a turn (or a permission was answered) that nobody
    /// has looked at yet. Set by the merge rules, cleared by reading.
    public var unread: Bool
    /// Archived on this device and waiting for the server to agree. Keeps
    /// the row out of the live list in the meantime.
    public var archiving: Bool

    public init(
        id: String, seq: Int, createdAt: Int64, updatedAt: Int64, active: Bool, activeAt: Int64,
        projectId: String?, metadataVersion: Int, metadataCipher: String, metadata: JSONValue?,
        agentStateVersion: Int, agentStateCipher: String?, agentState: JSONValue?,
        dataKeyCipher: String?, decryptable: Bool, syncedMessageSeq: Int = 0,
        thinking: Bool = false, thinkingAt: Int64 = 0, unread: Bool = false, archiving: Bool = false,
        lastMessageSentAt: Int64? = nil, avatar: AvatarDescriptor? = nil, avatarVersion: Int? = nil, avatarUpdateSeq: Int? = nil
    ) {
        self.id = id
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.active = active
        self.activeAt = activeAt
        self.projectId = projectId
        self.avatar = avatar
        self.avatarVersion = avatarVersion
        self.avatarUpdateSeq = avatarUpdateSeq
        self.metadataVersion = metadataVersion
        self.metadataCipher = metadataCipher
        self.metadata = metadata
        self.agentStateVersion = agentStateVersion
        self.agentStateCipher = agentStateCipher
        self.agentState = agentState
        self.dataKeyCipher = dataKeyCipher
        self.decryptable = decryptable
        self.syncedMessageSeq = syncedMessageSeq
        self.lastMessageSentAt = lastMessageSentAt
        self.thinking = thinking
        self.thinkingAt = thinkingAt
        self.unread = unread
        self.archiving = archiving
    }

    /// True when the server has messages this device has not fetched yet.
    public var hasUnsyncedMessages: Bool {
        decryptable && seq > syncedMessageSeq
    }
}

public struct MachineRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "machine"

    public var id: String
    public var seq: Int
    public var createdAt: Int64
    public var updatedAt: Int64
    public var active: Bool
    public var activeAt: Int64

    public var metadataVersion: Int
    public var metadataCipher: String
    public var metadata: JSONValue?

    public var daemonStateVersion: Int
    public var daemonStateCipher: String?
    public var daemonState: JSONValue?

    public var dataKeyCipher: String?
    public var decryptable: Bool

    public init(
        id: String, seq: Int, createdAt: Int64, updatedAt: Int64, active: Bool, activeAt: Int64,
        metadataVersion: Int, metadataCipher: String, metadata: JSONValue?,
        daemonStateVersion: Int, daemonStateCipher: String?, daemonState: JSONValue?,
        dataKeyCipher: String?, decryptable: Bool
    ) {
        self.id = id
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.active = active
        self.activeAt = activeAt
        self.metadataVersion = metadataVersion
        self.metadataCipher = metadataCipher
        self.metadata = metadata
        self.daemonStateVersion = daemonStateVersion
        self.daemonStateCipher = daemonStateCipher
        self.daemonState = daemonState
        self.dataKeyCipher = dataKeyCipher
        self.decryptable = decryptable
    }
}

public struct MessageRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "message"

    /// Server message id.
    public var id: String
    public var sessionId: String
    public var seq: Int
    public var localId: String?
    public var createdAt: Int64
    public var updatedAt: Int64
    public var contentCipher: String
    /// Decrypted payload, or nil if it could not be opened.
    public var content: JSONValue?

    public init(
        id: String, sessionId: String, seq: Int, localId: String?, createdAt: Int64, updatedAt: Int64,
        contentCipher: String, content: JSONValue?
    ) {
        self.id = id
        self.sessionId = sessionId
        self.seq = seq
        self.localId = localId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.contentCipher = contentCipher
        self.content = content
    }
}

/// A local write that has not reached the server yet. Sends are replayed
/// until acknowledged; the server deduplicates by `localId`, so a replay
/// after an unseen success is harmless.
public struct OutboxRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "outbox"

    public enum Kind: String, Codable, Sendable {
        /// A `role: 'user'` text record.
        case message
        /// A session-protocol `file` event; its attachment is uploaded first.
        case file
    }

    public enum State: String, Codable, Sendable {
        case queued
        case sending
        case failed
    }

    public var localId: String
    public var kind: Kind
    public var sessionId: String
    /// The plaintext record, encrypted at send time with the session key.
    public var payload: JSONValue
    public var createdAt: Int64
    public var attempts: Int
    public var lastError: String?
    public var state: State
    /// Not retried before this time (ms); 0 means now.
    public var nextAttemptAt: Int64
    /// The localId that has to be delivered first.
    public var dependsOn: String?

    public init(localId: String, kind: Kind, sessionId: String, payload: JSONValue, createdAt: Int64, attempts: Int = 0, lastError: String? = nil, state: State = .queued, nextAttemptAt: Int64 = 0, dependsOn: String? = nil) {
        self.localId = localId
        self.kind = kind
        self.sessionId = sessionId
        self.payload = payload
        self.createdAt = createdAt
        self.attempts = attempts
        self.lastError = lastError
        self.state = state
        self.nextAttemptAt = nextAttemptAt
        self.dependsOn = dependsOn
    }
}

/// A file picked to send, kept on disk until its blob is uploaded.
public struct AttachmentRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "attachment"

    public var localId: String
    public var sessionId: String
    public var outboxLocalId: String?
    /// Relative to the account's files directory.
    public var path: String
    public var name: String
    public var mimeType: String
    public var size: Int
    public var width: Int?
    public var height: Int?
    public var thumbhash: String?
    /// The server's blob ref once uploaded.
    public var ref: String?
    public var createdAt: Int64

    public init(localId: String, sessionId: String, outboxLocalId: String? = nil, path: String, name: String, mimeType: String, size: Int, width: Int? = nil, height: Int? = nil, thumbhash: String? = nil, ref: String? = nil, createdAt: Int64) {
        self.localId = localId
        self.sessionId = sessionId
        self.outboxLocalId = outboxLocalId
        self.path = path
        self.name = name
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
        self.thumbhash = thumbhash
        self.ref = ref
        self.createdAt = createdAt
    }
}

/// Unsent composer text for a session.
public struct DraftRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "draft"

    public var sessionId: String
    public var text: String
    public var updatedAt: Int64

    public init(sessionId: String, text: String, updatedAt: Int64) {
        self.sessionId = sessionId
        self.text = text
        self.updatedAt = updatedAt
    }
}

/// Account settings: one row, versioned by the server.
public struct AccountSettingsRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "accountSettings"

    public var id: Int = 1
    public var version: Int
    public var cipher: String?
    public var settings: JSONValue?

    public init(version: Int, cipher: String?, settings: JSONValue?) {
        self.version = version
        self.cipher = cipher
        self.settings = settings
    }
}

/// A project referenced by a session (Happy Agent sessions belong to one).
public struct ProjectRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "project"

    public var id: String
    public var externalId: String
    public var createdAt: Int64
    public var updatedAt: Int64
    public var metadataVersion: Int
    public var metadataCipher: String
    /// `{ name, kind? }` once decrypted.
    public var metadata: JSONValue?
    public var dataKeyCipher: String?
    public var avatar: AvatarDescriptor?

    public init(
        id: String, externalId: String, createdAt: Int64, updatedAt: Int64,
        metadataVersion: Int, metadataCipher: String, metadata: JSONValue?, dataKeyCipher: String?, avatar: AvatarDescriptor? = nil
    ) {
        self.id = id
        self.externalId = externalId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.metadataVersion = metadataVersion
        self.metadataCipher = metadataCipher
        self.metadata = metadata
        self.dataKeyCipher = dataKeyCipher
        self.avatar = avatar
    }

    public var name: String? {
        guard let name = metadata?["name"]?.stringValue, !name.isEmpty else { return nil }
        return name
    }
}

/// The account profile: one row, the last snapshot or patch applied.
public struct AccountProfileRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "accountProfile"

    public var id: Int = 1
    public var timestamp: Int64
    public var profile: AccountProfile

    public init(profile: AccountProfile) {
        self.timestamp = profile.timestamp
        self.profile = profile
    }
}

/// Settings changed on this device that the server has not accepted yet.
struct PendingSettingsRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "pendingSettings"

    var id: Int = 1
    var delta: JSONValue
}

/// Named sync cursors and timestamps.
public struct SyncStateRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "syncState"

    public var key: String
    public var value: Int64

    public init(key: String, value: Int64) {
        self.key = key
        self.value = value
    }
}

public enum SyncCursor: String, Sendable, CaseIterable {
    /// Highest session `updatedAt` applied from `GET /v2/sessions`.
    case sessionsChangedSince = "sessions.changedSince"
    /// When the session list was last fully reconciled (to catch deletions
    /// that happened while offline).
    case sessionsLastFullSync = "sessions.lastFullSync"
    /// When machines were last fetched.
    case machinesLastSync = "machines.lastSync"
}
