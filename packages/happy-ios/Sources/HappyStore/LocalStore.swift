import Foundation
import GRDB
import HappyWire

/// The single source of truth for everything the UI shows.
///
/// The sync engine writes server data into it; screens only ever read from
/// it (or observe it). Nothing in the UI waits on the network to render, and
/// nothing is thrown away on launch: the next sync only asks the server for
/// what changed since the cursors stored here.
///
/// All merge rules are idempotent and order-independent, so the same
/// update may arrive twice (socket + delta fetch) or out of order without
/// corrupting state:
///   - versioned fields (metadata, agent state, daemon state, settings) only
///     move forward in `version`;
///   - row scalars only move forward in `updatedAt`;
///   - `seq` and `syncedMessageSeq` only grow;
///   - messages are keyed by server id and `(sessionId, seq)`.
public final class LocalStore: Sendable {
    public let writer: any DatabaseWriter

    /// Opens (creating if needed) the store at `url`, in WAL mode so the UI
    /// can read while sync writes.
    public static func open(at url: URL) throws -> LocalStore {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        configuration.label = "HappyStore"
        return try LocalStore(writer: DatabasePool(path: url.path, configuration: configuration))
    }

    /// A throwaway store for tests and previews.
    public static func inMemory() throws -> LocalStore {
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        return try LocalStore(writer: DatabaseQueue(configuration: configuration))
    }

    public init(writer: any DatabaseWriter) throws {
        self.writer = writer
        try Schema.migrator.migrate(writer)
        // Live state from a previous run is stale: the server re-sends
        // `thinking` every few seconds while it holds, and an archive that
        // was in flight has since been answered.
        try writer.write { db in
            try db.execute(sql: "UPDATE session SET thinking = 0, thinkingAt = 0, archiving = 0 WHERE thinking = 1 OR archiving = 1")
        }
    }

    // MARK: Sessions

    public func sessions() throws -> [SessionRecord] {
        try writer.read { db in
            try SessionRecord.order(Column("updatedAt").desc).fetchAll(db)
        }
    }

    public func session(id: String) throws -> SessionRecord? {
        try writer.read { db in try SessionRecord.fetchOne(db, key: id) }
    }

    /// Merges sessions from a list fetch or a `new-session` update.
    public func upsertSessions(_ incoming: [SessionRecord]) throws {
        try writer.write { db in
            for record in incoming {
                try Self.upsert(record, db)
            }
        }
    }

    /// Applies an `update-session` event. Each field is applied only if its
    /// version is newer than what is stored.
    public func applySessionUpdate(
        id: String,
        metadata: VersionedPayload?,
        agentState: VersionedPayload?,
        projectId: String??
    ) throws -> Bool {
        try writer.write { db in
            guard var record = try SessionRecord.fetchOne(db, key: id) else { return false }
            let old = record
            if let metadata, metadata.version > record.metadataVersion, let cipher = metadata.cipher {
                record.metadataVersion = metadata.version
                record.metadataCipher = cipher
                record.metadata = metadata.value
            }
            if let agentState, agentState.version > record.agentStateVersion {
                record.agentStateVersion = agentState.version
                record.agentStateCipher = agentState.cipher
                record.agentState = agentState.value
            }
            if let projectId {
                record.projectId = projectId
            }
            Self.settle(old: old, &record)
            try record.update(db)
            return true
        }
    }

    /// Applies an `activity` ephemeral: presence, and whether the agent is
    /// working on a turn.
    public func applySessionActivity(id: String, active: Bool, activeAt: Int64, thinking: Bool = false) throws {
        try writer.write { db in
            guard var record = try SessionRecord.fetchOne(db, key: id), activeAt >= record.activeAt else { return }
            let old = record
            record.active = active
            record.activeAt = activeAt
            record.thinking = thinking
            record.thinkingAt = activeAt
            Self.settle(old: old, &record)
            try record.update(db)
        }
    }

    /// The person has seen the session's latest turn.
    public func markSessionRead(id: String) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE session SET unread = 0 WHERE id = ? AND unread = 1", arguments: [id])
        }
    }

    /// Takes a session out of the live list while its archive is in flight,
    /// or puts it back when the archive failed.
    public func setSessionArchiving(id: String, _ archiving: Bool) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE session SET archiving = ? WHERE id = ?", arguments: [archiving, id])
        }
    }

    public func deleteSession(id: String) throws {
        _ = try writer.write { db in
            try SessionRecord.deleteOne(db, key: id)
        }
    }

    /// Deletes local sessions the server no longer lists. Only called with
    /// the complete id set from a full reconciliation pass. Sessions updated
    /// after `cutoff` (server time) are kept: they may have arrived over the
    /// socket while the pass was paging.
    @discardableResult
    public func retainSessions(ids: Set<String>, updatedAtOrBefore cutoff: Int64) throws -> Int {
        try writer.write { db in
            let local = try Row.fetchAll(db, sql: "SELECT id, updatedAt FROM session")
            var removed = 0
            for row in local {
                let id: String = row["id"]
                let updatedAt: Int64 = row["updatedAt"]
                guard !ids.contains(id), updatedAt <= cutoff else { continue }
                if try SessionRecord.deleteOne(db, key: id) { removed += 1 }
            }
            return removed
        }
    }

    /// Sessions whose message log is behind the server, most recent first.
    public func sessionsNeedingMessageSync(limit: Int = 50) throws -> [SessionRecord] {
        try writer.read { db in
            try SessionRecord
                .filter(sql: "decryptable = 1 AND seq > syncedMessageSeq")
                .order(Column("updatedAt").desc)
                .limit(limit)
                .fetchAll(db)
        }
    }

    // MARK: Messages

    public func messages(sessionId: String, limit: Int = 100, beforeSeq: Int? = nil) throws -> [MessageRecord] {
        try writer.read { db in
            var request = MessageRecord.filter(Column("sessionId") == sessionId)
            if let beforeSeq {
                request = request.filter(Column("seq") < beforeSeq)
            }
            return try request.order(Column("seq").desc).limit(limit).fetchAll(db).reversed()
        }
    }

    /// Stores a page from `GET /v3/sessions/:id/messages?after_seq=`. The
    /// server returns every message after the cursor in order, so once the
    /// page is stored the cursor moves to the page's last seq even if seqs
    /// have gaps (a failed write on the server can burn a seq).
    ///
    /// `syncedThrough` is passed with the last page of a fetch: the server
    /// had nothing more up to that seq, so the cursor can move there even
    /// if the final seqs were burned and no message carries them.
    public func applyMessagePage(sessionId: String, messages: [MessageRecord], syncedThrough: Int? = nil) throws {
        try writer.write { db in
            guard var session = try SessionRecord.fetchOne(db, key: sessionId) else { return }
            for message in messages {
                try Self.insertMessage(message, db)
            }
            let last = max(messages.map(\.seq).max() ?? 0, syncedThrough ?? 0)
            if last > session.syncedMessageSeq {
                session.syncedMessageSeq = last
                session.seq = max(session.seq, last)
                try session.update(db)
            }
        }
    }

    public enum LiveMessageResult: Equatable, Sendable {
        /// Stored and contiguous with the local log.
        case applied
        /// Stored, but there is a gap before it: run a delta fetch.
        case gap
        /// The session is not known locally: refresh the session list.
        case unknownSession
    }

    /// Stores a message pushed over the socket. Only a message directly
    /// after the cursor advances it; anything else leaves the cursor so the
    /// delta fetch fills the gap (the same fast path happy-app uses).
    public func applyLiveMessage(_ message: MessageRecord) throws -> LiveMessageResult {
        try writer.write { db in
            guard var session = try SessionRecord.fetchOne(db, key: message.sessionId) else {
                return .unknownSession
            }
            try Self.insertMessage(message, db)
            session.seq = max(session.seq, message.seq)
            // The server bumps the session row in the same write that
            // allocates the message seq.
            session.updatedAt = max(session.updatedAt, message.createdAt)
            let result: LiveMessageResult
            if message.seq == session.syncedMessageSeq + 1 {
                session.syncedMessageSeq = message.seq
                result = .applied
            } else if message.seq <= session.syncedMessageSeq {
                result = .applied
            } else {
                result = .gap
            }
            try session.update(db)
            return result
        }
    }

    // MARK: Machines

    public func machines() throws -> [MachineRecord] {
        try writer.read { db in
            try MachineRecord.order(Column("activeAt").desc).fetchAll(db)
        }
    }

    /// Replaces the machine list with a full `GET /v1/machines` response,
    /// keeping newer versioned state already stored from live updates.
    public func replaceMachines(_ incoming: [MachineRecord]) throws {
        try writer.write { db in
            let ids = Set(incoming.map(\.id))
            for id in try String.fetchAll(db, sql: "SELECT id FROM machine") where !ids.contains(id) {
                try MachineRecord.deleteOne(db, key: id)
            }
            for record in incoming {
                try Self.upsert(record, db)
            }
        }
    }

    public func machine(id: String) throws -> MachineRecord? {
        try writer.read { db in try MachineRecord.fetchOne(db, key: id) }
    }

    public func upsertMachine(_ record: MachineRecord) throws {
        try writer.write { db in try Self.upsert(record, db) }
    }

    public func applyMachineUpdate(
        id: String,
        metadata: VersionedPayload?,
        daemonState: VersionedPayload?,
        active: Bool?,
        activeAt: Int64?
    ) throws -> Bool {
        try writer.write { db in
            guard var record = try MachineRecord.fetchOne(db, key: id) else { return false }
            if let metadata, metadata.version > record.metadataVersion, let cipher = metadata.cipher {
                record.metadataVersion = metadata.version
                record.metadataCipher = cipher
                record.metadata = metadata.value
            }
            if let daemonState, daemonState.version > record.daemonStateVersion {
                record.daemonStateVersion = daemonState.version
                record.daemonStateCipher = daemonState.cipher
                record.daemonState = daemonState.value
            }
            if let activeAt, activeAt >= record.activeAt {
                record.activeAt = activeAt
                if let active { record.active = active }
            }
            try record.update(db)
            return true
        }
    }

    public func deleteMachine(id: String) throws {
        _ = try writer.write { db in try MachineRecord.deleteOne(db, key: id) }
    }

    public func machinesSnapshot() throws -> MachinesSnapshot {
        try writer.read { db in try Self.fetchMachinesSnapshot(db) }
    }

    /// Calls `onChange` with the machines now and after every change to them
    /// or to the machine sync cursor. Home decides what to show from this.
    @MainActor
    public func observeMachines(onChange: @escaping @MainActor (MachinesSnapshot) -> Void) -> StoreObservation {
        StoreObservation(observe({ db in try Self.fetchMachinesSnapshot(db) }, onChange: onChange))
    }

    static func fetchMachinesSnapshot(_ db: Database) throws -> MachinesSnapshot {
        MachinesSnapshot(
            synced: try SyncStateRecord.fetchOne(db, key: SyncCursor.machinesLastSync.rawValue) != nil,
            // Newest first, as happy-app's useAllMachines sorts them.
            machines: try MachineRecord.order(Column("createdAt").desc, Column("id")).fetchAll(db)
        )
    }

    // MARK: Projects

    public func projects() throws -> [ProjectRecord] {
        try writer.read { db in try ProjectRecord.fetchAll(db) }
    }

    /// Project ids the stored sessions point at, which is the set to fetch.
    public func referencedProjectIds() throws -> [String] {
        try writer.read { db in
            try String.fetchAll(db, sql: "SELECT DISTINCT projectId FROM session WHERE projectId IS NOT NULL AND projectId != '' ORDER BY projectId")
        }
    }

    /// Replaces the projects with a fetch of every referenced one. A project
    /// the fetch did not return is no longer referenced or no longer exists.
    public func replaceProjects(_ incoming: [ProjectRecord]) throws {
        try writer.write { db in
            let ids = Set(incoming.map(\.id))
            for id in try String.fetchAll(db, sql: "SELECT id FROM project") where !ids.contains(id) {
                try ProjectRecord.deleteOne(db, key: id)
            }
            for record in incoming {
                if let existing = try ProjectRecord.fetchOne(db, key: record.id),
                   existing.metadataVersion > record.metadataVersion {
                    continue
                }
                try record.save(db)
            }
        }
    }

    public func deleteProject(id: String) throws {
        try writer.write { db in
            _ = try ProjectRecord.deleteOne(db, key: id)
            // The server unlinks the sessions in the same write.
            try db.execute(sql: "UPDATE session SET projectId = NULL WHERE projectId = ?", arguments: [id])
        }
    }

    // MARK: Account profile

    public func profile() throws -> AccountProfile? {
        try writer.read { db in try AccountProfileRecord.fetchOne(db, key: 1)?.profile }
    }

    /// Stores a profile snapshot unless a newer one (or a newer live patch)
    /// is already stored.
    @discardableResult
    public func applyProfile(_ profile: AccountProfile) throws -> Bool {
        try writer.write { db in
            if let existing = try AccountProfileRecord.fetchOne(db, key: 1), existing.timestamp > profile.timestamp {
                return false
            }
            try AccountProfileRecord(profile: profile).save(db)
            return true
        }
    }

    /// Applies an `update-account` patch on top of the stored profile, the
    /// way sync.ts does: fields the update carries win, the rest stay.
    public func patchProfile(_ update: UpdateAccountUpdate, at timestamp: Int64) throws {
        guard update.patchesProfile else { return }
        try writer.write { db in
            var profile = try AccountProfileRecord.fetchOne(db, key: 1)?.profile
                ?? AccountProfile(id: update.id, timestamp: 0)
            if let firstName = update.firstName { profile.firstName = firstName }
            if let lastName = update.lastName { profile.lastName = lastName }
            if let avatar = update.avatar { profile.avatar = avatar }
            if let github = update.github { profile.github = github }
            profile.timestamp = max(profile.timestamp, timestamp)
            try AccountProfileRecord(profile: profile).save(db)
        }
    }

    // MARK: Snapshots

    /// Everything home draws: machines, sessions, the projects they belong
    /// to and the settings that shape the list.
    public func homeSnapshot() throws -> HomeSnapshot {
        try writer.read { db in try Self.fetchHomeSnapshot(db) }
    }

    @MainActor
    public func observeHome(onChange: @escaping @MainActor (HomeSnapshot) -> Void) -> StoreObservation {
        StoreObservation(observe({ db in try Self.fetchHomeSnapshot(db) }, onChange: onChange))
    }

    static func fetchHomeSnapshot(_ db: Database) throws -> HomeSnapshot {
        HomeSnapshot(
            machines: try fetchMachinesSnapshot(db),
            sessions: try SessionRecord.order(Column("updatedAt").desc).fetchAll(db),
            projects: try ProjectRecord.fetchAll(db),
            settings: try fetchSettingsSnapshot(db)
        )
    }

    /// The account settings (synced and pending) and the profile.
    public func settingsSnapshot() throws -> SettingsSnapshot {
        try writer.read { db in try Self.fetchSettingsSnapshot(db) }
    }

    @MainActor
    public func observeSettings(onChange: @escaping @MainActor (SettingsSnapshot) -> Void) -> StoreObservation {
        StoreObservation(observe({ db in try Self.fetchSettingsSnapshot(db) }, onChange: onChange))
    }

    static func fetchSettingsSnapshot(_ db: Database) throws -> SettingsSnapshot {
        SettingsSnapshot(
            synced: try AccountSettingsRecord.fetchOne(db, key: 1),
            pending: try fetchPendingSettings(db),
            profile: try AccountProfileRecord.fetchOne(db, key: 1)?.profile
        )
    }

    // MARK: Account settings

    public func accountSettings() throws -> AccountSettingsRecord? {
        try writer.read { db in try AccountSettingsRecord.fetchOne(db, key: 1) }
    }

    /// Keeps whichever settings have the higher version.
    @discardableResult
    public func applyAccountSettings(_ incoming: AccountSettingsRecord) throws -> Bool {
        try writer.write { db in
            if let existing = try AccountSettingsRecord.fetchOne(db, key: 1), existing.version >= incoming.version {
                return false
            }
            try incoming.save(db)
            return true
        }
    }

    /// Settings changed here that the server has not accepted yet.
    public func pendingSettings() throws -> [String: JSONValue] {
        try writer.read { db in try Self.fetchPendingSettings(db) }
    }

    /// Records a local settings change. It is shown at once (layered over
    /// the synced settings) and kept until the server accepts it.
    public func addPendingSettings(_ delta: [String: JSONValue]) throws {
        guard !delta.isEmpty else { return }
        try writer.write { db in
            var pending = try Self.fetchPendingSettings(db)
            pending.merge(delta) { _, new in new }
            try PendingSettingsRecord(delta: .object(pending)).save(db)
        }
    }

    /// The server accepted `sent`. Keys changed again since are kept for the
    /// next push.
    public func settlePendingSettings(sent: [String: JSONValue]) throws {
        try writer.write { db in
            var pending = try Self.fetchPendingSettings(db)
            for (key, value) in sent where pending[key] == value {
                pending.removeValue(forKey: key)
            }
            if pending.isEmpty {
                _ = try PendingSettingsRecord.deleteOne(db, key: 1)
            } else {
                try PendingSettingsRecord(delta: .object(pending)).save(db)
            }
        }
    }

    /// Replaces the synced settings with the server's current copy after a
    /// version conflict. Unlike `applyAccountSettings` this takes the
    /// server's version even if it is not higher: the server is the judge.
    public func replaceAccountSettings(_ record: AccountSettingsRecord) throws {
        try writer.write { db in try record.save(db) }
    }

    static func fetchPendingSettings(_ db: Database) throws -> [String: JSONValue] {
        try PendingSettingsRecord.fetchOne(db, key: 1)?.delta.objectValue ?? [:]
    }

    // MARK: Outbox

    public func enqueue(_ record: OutboxRecord) throws {
        try writer.write { db in try record.insert(db, onConflict: .ignore) }
    }

    public func pendingOutbox(limit: Int = 100) throws -> [OutboxRecord] {
        try writer.read { db in
            try OutboxRecord.order(Column("createdAt")).limit(limit).fetchAll(db)
        }
    }

    public func markOutboxFailed(localId: String, error: String) throws {
        try writer.write { db in
            guard var record = try OutboxRecord.fetchOne(db, key: localId) else { return }
            record.attempts += 1
            record.lastError = error
            try record.update(db)
        }
    }

    public func removeFromOutbox(localId: String) throws {
        _ = try writer.write { db in try OutboxRecord.deleteOne(db, key: localId) }
    }

    // MARK: Drafts

    public func draft(sessionId: String) throws -> DraftRecord? {
        try writer.read { db in try DraftRecord.fetchOne(db, key: sessionId) }
    }

    /// Saves the composer's text; empty text deletes the draft.
    public func saveDraft(sessionId: String, text: String, at time: Int64) throws {
        try writer.write { db in
            if text.isEmpty {
                _ = try DraftRecord.deleteOne(db, key: sessionId)
            } else {
                try DraftRecord(sessionId: sessionId, text: text, updatedAt: time).save(db)
            }
        }
    }

    // MARK: Sync cursors

    public func cursor(_ cursor: SyncCursor) throws -> Int64? {
        try writer.read { db in try SyncStateRecord.fetchOne(db, key: cursor.rawValue)?.value }
    }

    public func setCursor(_ cursor: SyncCursor, _ value: Int64) throws {
        try writer.write { db in try SyncStateRecord(key: cursor.rawValue, value: value).save(db) }
    }

    // MARK: Lifecycle

    /// Logout: everything local belongs to the account that is leaving.
    public func eraseAll() throws {
        try writer.write { db in
            for table in [
                "message", "outbox", "session", "machine", "project", "accountSettings", "pendingSettings",
                "accountProfile", "syncState", "attachment", "draft",
            ] {
                try db.execute(sql: "DELETE FROM \(table)")
            }
        }
    }

    // MARK: Observation

    /// Calls `onChange` on the main actor with a fresh value now and after
    /// every commit that touches the tables `fetch` reads.
    @MainActor
    public func observe<Value: Sendable>(
        _ fetch: @escaping @Sendable (Database) throws -> Value,
        onError: @escaping @MainActor (Error) -> Void = { _ in },
        onChange: @escaping @MainActor (Value) -> Void
    ) -> AnyDatabaseCancellable {
        ValueObservation
            .tracking(fetch)
            .start(in: writer, scheduling: .mainActor, onError: onError, onChange: onChange)
    }

    // MARK: Merge rules

    private static func insertMessage(_ message: MessageRecord, _ db: Database) throws {
        try message.insert(db, onConflict: .ignore)
        if let localId = message.localId {
            // The server has it now: the pending send is done.
            try OutboxRecord.deleteOne(db, key: localId)
        }
    }

    static func upsert(_ incoming: SessionRecord, _ db: Database) throws {
        guard var record = try SessionRecord.fetchOne(db, key: incoming.id) else {
            var fresh = incoming
            fresh.syncedMessageSeq = 0
            fresh.thinking = false
            fresh.unread = false
            fresh.archiving = false
            try fresh.insert(db)
            return
        }
        let old = record
        if incoming.updatedAt >= record.updatedAt {
            record.updatedAt = incoming.updatedAt
            record.createdAt = incoming.createdAt
            record.active = incoming.active
            record.activeAt = incoming.activeAt
            record.projectId = incoming.projectId
        }
        record.seq = max(record.seq, incoming.seq)
        if incoming.metadataVersion > record.metadataVersion
            || (incoming.metadataVersion == record.metadataVersion && record.metadata == nil) {
            record.metadataVersion = incoming.metadataVersion
            record.metadataCipher = incoming.metadataCipher
            record.metadata = incoming.metadata
        }
        if incoming.agentStateVersion > record.agentStateVersion
            || (incoming.agentStateVersion == record.agentStateVersion && record.agentState == nil) {
            record.agentStateVersion = incoming.agentStateVersion
            record.agentStateCipher = incoming.agentStateCipher
            record.agentState = incoming.agentState
        }
        if !record.decryptable || record.dataKeyCipher == nil {
            record.dataKeyCipher = incoming.dataKeyCipher
            record.decryptable = incoming.decryptable
        }
        settle(old: old, &record)
        try record.update(db)
    }

    /// The local fields that follow from a change to a session, after
    /// storage.ts `applySessions`:
    ///   - an inactive session is not thinking;
    ///   - a session that was busy (thinking, or waiting on a permission)
    ///     and is now idle and online has a turn nobody has seen;
    ///   - an archive in flight is done once the server shows the session
    ///     archived too.
    static func settle(old: SessionRecord, _ record: inout SessionRecord) {
        if !record.active {
            record.thinking = false
        }
        let wasBusy = old.thinking || old.hasPendingPermissionRequests
        let isIdle = !record.thinking && record.active && !record.hasPendingPermissionRequests
        if wasBusy && isIdle {
            record.unread = true
        }
        if record.archiving && record.isArchivedOnServer {
            record.archiving = false
        }
    }

    static func upsert(_ incoming: MachineRecord, _ db: Database) throws {
        guard var record = try MachineRecord.fetchOne(db, key: incoming.id) else {
            try incoming.insert(db)
            return
        }
        if incoming.updatedAt >= record.updatedAt {
            record.updatedAt = incoming.updatedAt
            record.createdAt = incoming.createdAt
        }
        if incoming.activeAt >= record.activeAt {
            record.active = incoming.active
            record.activeAt = incoming.activeAt
        }
        record.seq = max(record.seq, incoming.seq)
        if incoming.metadataVersion > record.metadataVersion
            || (incoming.metadataVersion == record.metadataVersion && record.metadata == nil) {
            record.metadataVersion = incoming.metadataVersion
            record.metadataCipher = incoming.metadataCipher
            record.metadata = incoming.metadata
        }
        if incoming.daemonStateVersion > record.daemonStateVersion
            || (incoming.daemonStateVersion == record.daemonStateVersion && record.daemonState == nil) {
            record.daemonStateVersion = incoming.daemonStateVersion
            record.daemonStateCipher = incoming.daemonStateCipher
            record.daemonState = incoming.daemonState
        }
        if !record.decryptable || record.dataKeyCipher == nil {
            record.dataKeyCipher = incoming.dataKeyCipher
            record.decryptable = incoming.decryptable
        }
        try record.update(db)
    }
}

/// The account's machines as stored, and whether they have been fetched at
/// least once. Until then an empty list means "not known yet", not "none".
public struct MachinesSnapshot: Equatable, Sendable {
    public var synced: Bool
    public var machines: [MachineRecord]

    public init(synced: Bool, machines: [MachineRecord]) {
        self.synced = synced
        self.machines = machines
    }
}

/// What home is built from, read in one transaction so the parts agree.
public struct HomeSnapshot: Equatable, Sendable {
    public var machines: MachinesSnapshot
    public var sessions: [SessionRecord]
    public var projects: [ProjectRecord]
    public var settings: SettingsSnapshot

    public init(machines: MachinesSnapshot, sessions: [SessionRecord], projects: [ProjectRecord] = [], settings: SettingsSnapshot = SettingsSnapshot()) {
        self.machines = machines
        self.sessions = sessions
        self.projects = projects
        self.settings = settings
    }
}

/// The account settings as stored: the server's copy, the local changes it
/// has not accepted yet, and the profile.
public struct SettingsSnapshot: Equatable, Sendable {
    public var synced: AccountSettingsRecord?
    public var pending: [String: JSONValue]
    public var profile: AccountProfile?

    public init(synced: AccountSettingsRecord? = nil, pending: [String: JSONValue] = [:], profile: AccountProfile? = nil) {
        self.synced = synced
        self.pending = pending
        self.profile = profile
    }
}

/// Keeps a store observation running until it is cancelled or released.
public final class StoreObservation {
    private let cancellable: AnyDatabaseCancellable

    init(_ cancellable: AnyDatabaseCancellable) {
        self.cancellable = cancellable
    }

    public func cancel() {
        cancellable.cancel()
    }
}

/// A versioned encrypted field after decryption.
public struct VersionedPayload: Sendable, Hashable {
    public var version: Int
    /// The ciphertext as sent by the server (nil when the server cleared it).
    public var cipher: String?
    /// The decrypted JSON, or nil if it could not be opened.
    public var value: JSONValue?

    public init(version: Int, cipher: String?, value: JSONValue?) {
        self.version = version
        self.cipher = cipher
        self.value = value
    }
}
