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
    let lifecycle = StoreLifecycle()
    let homeObservation: SharedValueObservation<HomeSnapshot>
    let settingsObservation: SharedValueObservation<SettingsSnapshot>
    let machinesObservation: SharedValueObservation<MachinesSnapshot>
    let draftSessionsObservation: SharedValueObservation<Set<String>>
    let homeHub: SnapshotHub<HomeSnapshot>
    let machinesHub: SnapshotHub<MachinesSnapshot>
    let troubleshootingHub: SnapshotHub<TroubleshootingSnapshot>
    let draftSessionsHub: SnapshotHub<Set<String>>
    let presenceOverlay: PresenceOverlay

    /// Opens (creating if needed) the store at `url`, in WAL mode so the UI
    /// can read while sync writes.
    public static func open(at url: URL) throws -> LocalStore {
        ThreadRules.assertOffMain()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        configuration.label = "HappyStore"
        configuration.busyMode = .timeout(5)
        return try LocalStore(writer: DatabasePool(path: url.path, configuration: configuration))
    }

    /// A throwaway store for tests and previews.
    public static func inMemory() throws -> LocalStore {
        ThreadRules.assertOffMain()
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        return try LocalStore(writer: DatabaseQueue(configuration: configuration))
    }

    public init(writer: any DatabaseWriter) throws {
        ThreadRules.assertOffMain()
        self.writer = writer
        let delivery = DispatchQueue(label: "HappyStore.observations", qos: .userInitiated)
        // Ciphertexts, versions, message cursors and updatedAt do not render
        // on home. Ordinary incoming messages only change those fields.
        // Scope invalidation to the columns its consumers actually use.
        let homeSessionRegion = SQLRequest<Row>(sql: """
            SELECT id, createdAt, lastMessageSentAt, active, activeAt, projectId,
                   metadata, agentState, decryptable, thinking, unread, archiving, avatar, dataKeyCipher
            FROM session
            """)
        // Async consumers must use SharedObservationBridge: GRDB invokes
        // shared callbacks while holding its client lock.
        homeObservation = ValueObservation.tracking(
            region: homeSessionRegion, MachineRecord.all(), ProjectRecord.all(),
            AccountSettingsRecord.all(), PendingSettingsRecord.all(), AccountProfileRecord.all(),
            SyncStateRecord.select(Column("key")).filter([SyncCursor.machinesLastSync.rawValue, SyncCursor.sessionsChangedSince.rawValue].contains(Column("key"))),
            fetch: { db in try Self.fetchHomeSnapshot(db) }
        ).removeDuplicates().shared(in: writer, scheduling: .async(onQueue: delivery))
        // Async consumers must use SharedObservationBridge.
        settingsObservation = ValueObservation.trackingConstantRegion { db in
            try Self.fetchSettingsSnapshot(db)
        }.removeDuplicates().shared(in: writer, scheduling: .async(onQueue: delivery))
        // Async consumers must use SharedObservationBridge.
        machinesObservation = ValueObservation.trackingConstantRegion { db in
            try Self.fetchMachinesSnapshot(db)
        }.removeDuplicates().shared(in: writer, scheduling: .async(onQueue: delivery))
        // Existing draft saves update only text and updatedAt. Tracking the
        // primary key observes membership changes without reading on each edit.
        let draftRegion = SQLRequest<Row>(sql: "SELECT sessionId FROM draft")
        draftSessionsObservation = ValueObservation.tracking(region: draftRegion,
            fetch: { db in try Self.fetchDraftSessionIds(db) }
        ).removeDuplicates().shared(in: writer, scheduling: .async(onQueue: delivery))
        draftSessionsHub = SnapshotHub(observation: draftSessionsObservation, project: { $0 })
        let overlay = PresenceOverlay()
        presenceOverlay = overlay
        homeHub = SnapshotHub(observation: homeObservation, project: { overlay.home($0) })
        machinesHub = SnapshotHub(observation: machinesObservation, project: { overlay.machineSnapshot($0) })
        let troubleRegion = SQLRequest<Row>(sql: "SELECT id, updatedAt, active, createdAt, lastMessageSentAt, metadata FROM session")
        let troubleMachines = SQLRequest<Row>(sql: "SELECT id, createdAt, active, activeAt, metadata FROM machine")
        // Async consumers must use SharedObservationBridge.
        let troubleshootingObservation = ValueObservation.tracking(region: troubleRegion, troubleMachines,
            fetch: { db in try Self.fetchTroubleshootingSnapshot(db) }
        ).removeDuplicates().shared(in: writer, scheduling: .async(onQueue: delivery))
        troubleshootingHub = SnapshotHub(observation: troubleshootingObservation, project: { overlay.troubleshooting($0) })
        try Schema.migrator.migrate(writer)
        // Live state from a previous run is stale: the server re-sends
        // `thinking` every few seconds while it holds, and an archive that
        // was in flight has since been answered.
        try performWrite { db in
            try db.execute(sql: "UPDATE session SET thinking = 0, thinkingAt = 0, archiving = 0 WHERE thinking = 1 OR archiving = 1")
            try db.execute(sql: "UPDATE outbox SET state = 'queued' WHERE state = 'sending'")
        }
    }

    // MARK: Sessions

    func performWrite<Value>(_ body: (Database) throws -> Value) throws -> Value {
        ThreadRules.assertOffMain()
        try lifecycle.checkOpen()
        return try writer.write(body)
    }

    func performRead<Value>(_ body: (Database) throws -> Value) throws -> Value {
        ThreadRules.assertOffMain()
        try lifecycle.checkOpen()
        return try writer.read(body)
    }

    public func sessions() throws -> [SessionRecord] {
        try performRead { db in
            try SessionRecord.order(Column("updatedAt").desc).fetchAll(db)
        }
    }

    public func session(id: String) throws -> SessionRecord? {
        try performRead { db in try SessionRecord.fetchOne(db, key: id) }
    }

    public func sessions(ids: [String]) throws -> [SessionRecord] {
        guard !ids.isEmpty else { return [] }
        return try performRead { db in try SessionRecord.filter(ids.contains(Column("id"))).fetchAll(db) }
    }

    /// A tiny checkpoint captured before an HTTP listing. Old servers have
    /// no deletion revision, so an in-flight fetch must not undo live art.
    public func avatarUpdateSequences() throws -> [String: Int] {
        try performRead { db in
            try Dictionary(uniqueKeysWithValues: Row.fetchAll(db, sql: "SELECT id, avatarUpdateSeq FROM session WHERE avatarUpdateSeq IS NOT NULL")
                .map { ($0["id"] as String, $0["avatarUpdateSeq"] as Int) })
        }
    }

    /// Merges sessions from a list fetch or a `new-session` update.
    public func upsertSessions(_ incoming: [SessionRecord], reconcileComposer: SessionComposerReconciliation? = nil) throws {
        try applySessionListBatch(incoming, reconcileComposer: reconcileComposer)
    }

    /// Rows, readiness and the final cursors agree in one observable commit.
    /// A failed or timed-out page flush passes no checkpoint.
    public func applySessionListBatch(_ incoming: [SessionRecord], checkpoint: SessionListCheckpoint? = nil,
                                      reconcileComposer: SessionComposerReconciliation? = nil) throws {
        guard !incoming.isEmpty || checkpoint != nil else { return }
        let removed = try performWrite { db in
            var removed = Set<String>()
            for record in incoming {
                let result = try Self.upsert(record, db)
                if let reconcileComposer {
                    try Self.reconcileComposer(result.merged, previous: result.previous, db: db, transform: reconcileComposer)
                }
            }
            if let checkpoint {
                if let ids = checkpoint.fullIDs {
                    for row in try Row.fetchAll(db, sql: "SELECT id, updatedAt FROM session") {
                        let id: String = row["id"]
                        let updatedAt: Int64 = row["updatedAt"]
                        if !ids.contains(id), updatedAt <= checkpoint.changedSince,
                           try SessionRecord.deleteOne(db, key: id) { removed.insert(id) }
                    }
                    if let completedAt = checkpoint.completedAt { try Self.saveCursor(.sessionsLastFullSync, completedAt, db) }
                }
                try Self.saveCursor(.sessionsChangedSince, checkpoint.changedSince, db)
            }
            return removed
        }
        presenceOverlay.removeSessions(removed)
    }

    private static func reconcileComposer(_ session: SessionRecord, previous: SessionRecord?, db: Database, transform: SessionComposerReconciliation) throws {
        let composer = try ComposerStateRecord.fetchOne(db, key: session.id) ?? ComposerStateRecord(sessionId: session.id)
        let draft = try DraftRecord.fetchOne(db, key: session.id)
        let next = transform(session, previous, composer, draft)
        if next.composer != composer { try next.composer.save(db) }
        if next.draft != draft {
            if let draft = next.draft { try draft.save(db) }
            else { _ = try DraftRecord.deleteOne(db, key: session.id) }
        }
    }

    /// Applies an `update-session` event. Each field is applied only if its
    /// version is newer than what is stored.
    public func applySessionUpdate(
        id: String,
        metadata: VersionedPayload?,
        agentState: VersionedPayload?,
        projectId: String??,
        avatar: AvatarDescriptor?? = nil, avatarVersion: Int? = nil, avatarUpdateSeq: Int? = nil,
        reconcileComposer: SessionComposerReconciliation? = nil
    ) throws -> Bool {
        try performWrite { db in
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
            if let avatar {
                let revision = avatarVersion ?? avatar?.version
                let newer: Bool
                if let avatarVersion, let previous = record.avatarVersion { newer = avatarVersion > previous }
                else { newer = (avatarUpdateSeq ?? 0) > (record.avatarUpdateSeq ?? -1) }
                if newer {
                    record.avatar = avatar
                    if let revision { record.avatarVersion = max(revision, record.avatarVersion ?? -1) }
                    record.avatarUpdateSeq = avatarUpdateSeq
                }
            }
            Self.settle(old: old, &record)
            if record != old { _ = try record.updateChanges(db, from: old) }
            if let reconcileComposer { try Self.reconcileComposer(record, previous: old, db: db, transform: reconcileComposer) }
            return true
        }
    }

    /// Applies an `activity` ephemeral: presence, and whether the agent is
    /// working on a turn.
    public func applySessionActivity(id: String, active: Bool, activeAt: Int64, thinking: Bool = false) throws {
        try performWrite { db in
            guard var record = try SessionRecord.fetchOne(db, key: id), activeAt >= record.activeAt else { return }
            let old = record
            record.active = active
            record.activeAt = activeAt
            record.thinking = thinking
            record.thinkingAt = activeAt
            Self.settle(old: old, &record)
            if record != old { _ = try record.updateChanges(db, from: old) }
        }
    }

    /// The person has seen the session's latest turn.
    public func markSessionRead(id: String) throws {
        try performWrite { db in
            try db.execute(sql: "UPDATE session SET unread = 0 WHERE id = ? AND unread = 1", arguments: [id])
        }
    }

    /// Takes a session out of the live list while its archive is in flight,
    /// or puts it back when the archive failed.
    public func setSessionArchiving(id: String, _ archiving: Bool) throws {
        try performWrite { db in
            try db.execute(sql: "UPDATE session SET archiving = ? WHERE id = ? AND archiving != ?", arguments: [archiving, id, archiving])
        }
    }

    public func deleteSession(id: String) throws {
        _ = try performWrite { db in
            try SessionRecord.deleteOne(db, key: id)
        }
        presenceOverlay.removeSessions([id])
    }

    /// Deletes local sessions the server no longer lists. Only called with
    /// the complete id set from a full reconciliation pass. Sessions updated
    /// after `cutoff` (server time) are kept: they may have arrived over the
    /// socket while the pass was paging.
    @discardableResult
    public func retainSessions(ids: Set<String>, updatedAtOrBefore cutoff: Int64) throws -> Int {
        let removed = try performWrite { db in
            let local = try Row.fetchAll(db, sql: "SELECT id, updatedAt FROM session")
            var removed = Set<String>()
            for row in local {
                let id: String = row["id"]
                let updatedAt: Int64 = row["updatedAt"]
                guard !ids.contains(id), updatedAt <= cutoff else { continue }
                if try SessionRecord.deleteOne(db, key: id) { removed.insert(id) }
            }
            return removed
        }
        presenceOverlay.removeSessions(removed)
        return removed.count
    }

    /// Sessions whose message log is behind the server, most recent first.
    public func sessionsNeedingMessageSync(limit: Int = 50) throws -> [SessionRecord] {
        try performRead { db in
            try SessionRecord
                .filter(sql: "decryptable = 1 AND seq > syncedMessageSeq")
                .order(Column("updatedAt").desc)
                .limit(limit)
                .fetchAll(db)
        }
    }

    // MARK: Messages

    public func messages(sessionId: String, limit: Int = 100, beforeSeq: Int? = nil) throws -> [MessageRecord] {
        try performRead { db in
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
        try applyMessagePages([MessagePageWrite(sessionId: sessionId, messages: messages, syncedThrough: syncedThrough)])
    }

    /// One observable commit across pages and sessions. A deleted session is
    /// skipped, exactly like the single-page path, without inserting orphans.
    public func applyMessagePages(_ pages: [MessagePageWrite]) throws {
        guard !pages.isEmpty else { return }
        try performWrite { db in
            for page in pages {
                guard var session = try SessionRecord.fetchOne(db, key: page.sessionId) else { continue }
                let old = session
                for message in page.messages {
                    try Self.insertMessage(message, db)
                }
                let last = max(page.messages.map(\.seq).max() ?? 0, page.syncedThrough ?? 0)
                if last > session.syncedMessageSeq {
                    session.syncedMessageSeq = last
                    session.seq = max(session.seq, last)
                    _ = try session.updateChanges(db, from: old)
                }
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
        try performWrite { db in
            guard var session = try SessionRecord.fetchOne(db, key: message.sessionId) else {
                return .unknownSession
            }
            let old = session
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
            if session != old { _ = try session.updateChanges(db, from: old) }
            return result
        }
    }

    // MARK: Machines

    public func machines() throws -> [MachineRecord] {
        try performRead { db in
            try MachineRecord.order(Column("activeAt").desc).fetchAll(db)
        }
    }

    /// Replaces the machine list with a full `GET /v1/machines` response,
    /// keeping newer versioned state already stored from live updates.
    public func replaceMachines(_ incoming: [MachineRecord]) throws {
        let removed = try performWrite { db in
            let ids = Set(incoming.map(\.id))
            var removed = Set<String>()
            for id in try String.fetchAll(db, sql: "SELECT id FROM machine") where !ids.contains(id) {
                if try MachineRecord.deleteOne(db, key: id) { removed.insert(id) }
            }
            for record in incoming {
                try Self.upsert(record, db)
            }
            return removed
        }
        presenceOverlay.removeMachines(removed)
    }

    public func machine(id: String) throws -> MachineRecord? {
        try performRead { db in try MachineRecord.fetchOne(db, key: id) }
    }

    public func upsertMachine(_ record: MachineRecord) throws {
        try performWrite { db in try Self.upsert(record, db) }
    }

    public func applyMachineUpdate(
        id: String,
        metadata: VersionedPayload?,
        daemonState: VersionedPayload?,
        active: Bool?,
        activeAt: Int64?
    ) throws -> Bool {
        try performWrite { db in
            guard var record = try MachineRecord.fetchOne(db, key: id) else { return false }
            let old = record
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
            if record != old { _ = try record.updateChanges(db, from: old) }
            return true
        }
    }

    public func deleteMachine(id: String) throws {
        _ = try performWrite { db in try MachineRecord.deleteOne(db, key: id) }
        presenceOverlay.removeMachines([id])
    }

    public func machinesSnapshot() throws -> MachinesSnapshot {
        try performRead { db in try Self.fetchMachinesSnapshot(db) }
    }

    /// Calls `onChange` with the machines now and after every change to them
    /// or to the machine sync cursor. Home decides what to show from this.
    @MainActor
    public func observeMachines(onChange: @escaping @MainActor (MachinesSnapshot) -> Void) -> StoreObservation {
        Self.deliverOnMain(machineSnapshots(), onChange: onChange)
    }

    static func fetchMachinesSnapshot(_ db: Database) throws -> MachinesSnapshot {
        MachinesSnapshot(
            synced: try SyncStateRecord.exists(db, key: SyncCursor.machinesLastSync.rawValue),
            // Newest first, as happy-app's useAllMachines sorts them.
            machines: try MachineRecord.order(Column("createdAt").desc, Column("id")).fetchAll(db)
        )
    }

    // MARK: Projects

    public func projects() throws -> [ProjectRecord] {
        try performRead { db in try ProjectRecord.fetchAll(db) }
    }

    /// Project ids the stored sessions point at, which is the set to fetch.
    public func referencedProjectIds() throws -> [String] {
        try performRead { db in
            try String.fetchAll(db, sql: """
                SELECT DISTINCT linkedId FROM (
                    SELECT COALESCE(NULLIF(TRIM(projectId), ''),
                        CASE WHEN json_type(metadata, '$.project.id') = 'text'
                            THEN NULLIF(TRIM(json_extract(metadata, '$.project.id')), '') END) AS linkedId
                    FROM session
                ) WHERE linkedId IS NOT NULL ORDER BY linkedId
                """)
        }
    }

    /// Replaces the projects with a fetch of every referenced one. A project
    /// the fetch did not return is no longer referenced or no longer exists.
    public func replaceProjects(_ incoming: [ProjectRecord]) throws {
        try performWrite { db in
            let ids = Set(incoming.map(\.id))
            for id in try String.fetchAll(db, sql: "SELECT id FROM project") where !ids.contains(id) {
                try ProjectRecord.deleteOne(db, key: id)
            }
            for record in incoming {
                if let existing = try ProjectRecord.fetchOne(db, key: record.id) {
                    guard existing.metadataVersion <= record.metadataVersion, existing.updatedAt <= record.updatedAt else { continue }
                    if record != existing { _ = try record.updateChanges(db, from: existing) }
                } else {
                    try record.insert(db)
                }
            }
        }
    }

    public func deleteProject(id: String) throws {
        try performWrite { db in
            _ = try ProjectRecord.deleteOne(db, key: id)
            // The server unlinks the sessions in the same write.
            try db.execute(sql: "UPDATE session SET projectId = NULL WHERE projectId = ?", arguments: [id])
        }
    }

    // MARK: Account profile

    public func profile() throws -> AccountProfile? {
        try performRead { db in try AccountProfileRecord.fetchOne(db, key: 1)?.profile }
    }

    /// Stores a profile snapshot unless a newer one (or a newer live patch)
    /// is already stored.
    @discardableResult
    public func applyProfile(_ profile: AccountProfile) throws -> Bool {
        try performWrite { db in
            let incoming = AccountProfileRecord(profile: profile)
            if let existing = try AccountProfileRecord.fetchOne(db, key: 1) {
                guard existing.timestamp <= profile.timestamp else { return false }
                if incoming != existing { _ = try incoming.updateChanges(db, from: existing) }
            } else {
                try incoming.insert(db)
            }
            return true
        }
    }

    /// Applies an `update-account` patch on top of the stored profile, the
    /// way sync.ts does: fields the update carries win, the rest stay.
    public func patchProfile(_ update: UpdateAccountUpdate, at timestamp: Int64) throws {
        guard update.patchesProfile else { return }
        try performWrite { db in
            let old = try AccountProfileRecord.fetchOne(db, key: 1)
            var profile = old?.profile
                ?? AccountProfile(id: update.id, timestamp: 0)
            if let firstName = update.firstName { profile.firstName = firstName }
            if let lastName = update.lastName { profile.lastName = lastName }
            if let avatar = update.avatar { profile.avatar = avatar }
            if let github = update.github { profile.github = github }
            profile.timestamp = max(profile.timestamp, timestamp)
            let record = AccountProfileRecord(profile: profile)
            if let old {
                if record != old { _ = try record.updateChanges(db, from: old) }
            } else {
                try record.insert(db)
            }
        }
    }

    // MARK: Snapshots

    /// Everything home draws: machines, sessions, the projects they belong
    /// to and the settings that shape the list.
    public func homeSnapshot() throws -> HomeSnapshot {
        try performRead { db in try Self.fetchHomeSnapshot(db) }
    }

    @MainActor
    public func observeHome(onChange: @escaping @MainActor (HomeSnapshot) -> Void) -> StoreObservation {
        Self.deliverOnMain(homeSnapshots(), onChange: onChange)
    }

    static func fetchHomeSnapshot(_ db: Database) throws -> HomeSnapshot {
        HomeSnapshot(
            machines: try fetchMachinesSnapshot(db),
            sessions: try SessionRecord.order(Column("updatedAt").desc).fetchAll(db),
            projects: try ProjectRecord.fetchAll(db),
            settings: try fetchSettingsSnapshot(db),
            sessionsSynced: try SyncStateRecord.exists(db, key: SyncCursor.sessionsChangedSince.rawValue)
        )
    }

    /// The account settings (synced and pending) and the profile.
    public func settingsSnapshot() throws -> SettingsSnapshot {
        try performRead { db in try Self.fetchSettingsSnapshot(db) }
    }

    @MainActor
    public func observeSettings(onChange: @escaping @MainActor (SettingsSnapshot) -> Void) -> StoreObservation {
        Self.deliverOnMain(settingsSnapshots(), onChange: onChange)
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
        try performRead { db in try AccountSettingsRecord.fetchOne(db, key: 1) }
    }

    /// Keeps whichever settings have the higher version.
    @discardableResult
    public func applyAccountSettings(_ incoming: AccountSettingsRecord) throws -> Bool {
        try performWrite { db in
            if let existing = try AccountSettingsRecord.fetchOne(db, key: 1), existing.version >= incoming.version {
                return false
            }
            try incoming.save(db)
            return true
        }
    }

    /// Settings changed here that the server has not accepted yet.
    public func pendingSettings() throws -> [String: JSONValue] {
        try performRead { db in try Self.fetchPendingSettings(db) }
    }

    /// Records a local settings change. It is shown at once (layered over
    /// the synced settings) and kept until the server accepts it.
    public func addPendingSettings(_ delta: [String: JSONValue]) throws {
        guard !delta.isEmpty else { return }
        try performWrite { db in
            var pending = try Self.fetchPendingSettings(db)
            let old = pending
            pending.merge(delta) { _, new in new }
            if pending != old { try PendingSettingsRecord(delta: .object(pending)).save(db) }
        }
    }

    /// The server accepted `sent`. Keys changed again since are kept for the
    /// next push.
    public func settlePendingSettings(sent: [String: JSONValue]) throws {
        try performWrite { db in
            var pending = try Self.fetchPendingSettings(db)
            let old = pending
            for (key, value) in sent where pending[key] == value {
                pending.removeValue(forKey: key)
            }
            guard pending != old else { return }
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
        try performWrite { db in
            if let old = try AccountSettingsRecord.fetchOne(db, key: 1) {
                if record != old { _ = try record.updateChanges(db, from: old) }
            } else {
                try record.insert(db)
            }
        }
    }

    static func fetchPendingSettings(_ db: Database) throws -> [String: JSONValue] {
        try PendingSettingsRecord.fetchOne(db, key: 1)?.delta.objectValue ?? [:]
    }

    // MARK: Outbox

    public func enqueue(_ record: OutboxRecord) throws {
        try performWrite { db in try record.insert(db, onConflict: .ignore) }
    }

    public func pendingOutbox(limit: Int = 100) throws -> [OutboxRecord] {
        try performRead { db in
            try OutboxRecord.fetchAll(db, sql: "SELECT * FROM outbox ORDER BY rowid LIMIT ?", arguments: [limit])
        }
    }

    public func markOutboxFailed(localId: String, error: String) throws {
        try performWrite { db in
            guard var record = try OutboxRecord.fetchOne(db, key: localId) else { return }
            record.attempts += 1
            record.lastError = error
            record.state = .failed
            try record.update(db)
        }
    }

    public func removeFromOutbox(localId: String) throws {
        _ = try performWrite { db in try OutboxRecord.deleteOne(db, key: localId) }
    }

    /// One transaction accepts the files and text; observers never see a half send.
    public func enqueueBatch(_ items: [OutboxRecord], attachments: [AttachmentRecord]) throws {
        try performWrite { db in
            for attachment in attachments {
                try attachment.insert(db)
            }
            for item in items {
                try item.insert(db)
            }
        }
    }

    public func outbox(localId: String) throws -> OutboxRecord? {
        try performRead { db in try OutboxRecord.fetchOne(db, key: localId) }
    }

    public func updateOutbox(_ item: OutboxRecord) throws {
        try performWrite { db in
            // An echo or discard during a network call must never resurrect it.
            if try OutboxRecord.fetchOne(db, key: item.localId) != nil {
                try item.update(db)
            }
        }
    }

    public func recoverSendingOutbox() throws {
        try performWrite { db in
            try db.execute(sql: "UPDATE outbox SET state = 'queued' WHERE state = 'sending'")
        }
    }

    public func retryOutbox(localId: String) throws {
        try performWrite { db in
            guard var item = try OutboxRecord.fetchOne(db, key: localId) else {
                return
            }
            item.state = .queued
            item.attempts = 0
            item.nextAttemptAt = 0
            item.lastError = nil
            try item.update(db)
        }
    }

    /// Discard the selected item and its dependency chain, including its files.
    public func discardOutbox(localId: String) throws -> [AttachmentRecord] {
        try performWrite { db in
            let items = try OutboxRecord.fetchAll(db)
            var ids: Set<String> = [localId]
            var changed = true
            while changed {
                changed = false
                for item in items where !ids.contains(item.localId) {
                    if let dependency = item.dependsOn, ids.contains(dependency) {
                        ids.insert(item.localId)
                        changed = true
                    }
                }
            }
            // A text owns the file chain immediately before it.
            var predecessor = items.first { $0.localId == localId }?.dependsOn
            while let id = predecessor, let item = items.first(where: { $0.localId == id && $0.kind == .file }) {
                ids.insert(id)
                predecessor = item.dependsOn
            }
            let attachments = try AttachmentRecord.fetchAll(db).filter { ids.contains($0.outboxLocalId ?? "") }
            for attachment in attachments {
                _ = try AttachmentRecord.deleteOne(db, key: attachment.localId)
            }
            for id in ids {
                _ = try OutboxRecord.deleteOne(db, key: id)
            }
            return attachments
        }
    }

    public func attachment(outboxLocalId: String) throws -> AttachmentRecord? {
        try performRead { db in try AttachmentRecord.filter(Column("outboxLocalId") == outboxLocalId).fetchOne(db) }
    }

    public func saveAttachment(_ attachment: AttachmentRecord) throws {
        try performWrite { db in try attachment.save(db) }
    }

    public func composerState(sessionId: String) throws -> ComposerStateRecord {
        try performRead { db in try ComposerStateRecord.fetchOne(db, key: sessionId) ?? ComposerStateRecord(sessionId: sessionId) }
    }

    public func saveComposerState(_ state: ComposerStateRecord) throws {
        try performWrite { db in try state.save(db) }
    }

    /// Atomically saves a Rig edit's text, picks and monotonic draft stamp.
    public func saveRigComposer(_ composer: ComposerStateRecord, text: String?, at time: Int64) throws {
        try performWrite { db in
            try composer.save(db)
            if let text, !text.isEmpty {
                try DraftRecord(sessionId: composer.sessionId, text: text, updatedAt: time).save(db)
            } else {
                _ = try DraftRecord.deleteOne(db, key: composer.sessionId)
            }
        }
    }

    // MARK: Drafts

    public func draft(sessionId: String) throws -> DraftRecord? {
        try performRead { db in try DraftRecord.fetchOne(db, key: sessionId) }
    }

    /// Saves the composer's text; empty text deletes the draft.
    public func saveDraft(sessionId: String, text: String, at time: Int64) throws {
        try performWrite { db in
            if text.isEmpty {
                _ = try DraftRecord.deleteOne(db, key: sessionId)
            } else {
                try DraftRecord(sessionId: sessionId, text: text, updatedAt: time).save(db)
            }
        }
    }

    // MARK: Sync cursors

    public func cursor(_ cursor: SyncCursor) throws -> Int64? {
        try performRead { db in try SyncStateRecord.fetchOne(db, key: cursor.rawValue)?.value }
    }

    public func setCursor(_ cursor: SyncCursor, _ value: Int64) throws {
        try performWrite { db in try Self.saveCursor(cursor, value, db) }
    }

    private static func saveCursor(_ cursor: SyncCursor, _ value: Int64, _ db: Database) throws {
        let record = SyncStateRecord(key: cursor.rawValue, value: value)
        if let old = try SyncStateRecord.fetchOne(db, key: cursor.rawValue) {
            if record != old { _ = try record.updateChanges(db, from: old) }
        } else {
            try record.insert(db)
        }
    }

    // MARK: Lifecycle

    /// Logout: everything local belongs to the account that is leaving.
    public func eraseAll() throws {
        try performWrite { db in
            for table in [
                "message", "outbox", "chatHistory", "session", "machine", "project", "accountSettings", "pendingSettings",
                "accountProfile", "syncState", "attachment", "draft", "composerState",
            ] {
                try db.execute(sql: "DELETE FROM \(table)")
            }
        }
    }

    // MARK: Merge rules

    static func insertMessage(_ message: MessageRecord, _ db: Database) throws {
        try message.insert(db, onConflict: .ignore)
        if let localId = message.localId {
            // The server has it now: the pending send is done.
            try OutboxRecord.deleteOne(db, key: localId)
        }
    }

    @discardableResult
    static func upsert(_ incoming: SessionRecord, _ db: Database) throws -> (previous: SessionRecord?, merged: SessionRecord) {
        guard var record = try SessionRecord.fetchOne(db, key: incoming.id) else {
            var fresh = incoming
            fresh.syncedMessageSeq = 0
            fresh.thinking = false
            fresh.unread = false
            fresh.archiving = false
            fresh.avatarVersion = incoming.avatarVersion ?? incoming.avatar?.version
            try fresh.insert(db)
            return (nil, fresh)
        }
        let old = record
        if incoming.updatedAt >= record.updatedAt {
            record.updatedAt = incoming.updatedAt
            record.createdAt = incoming.createdAt
            record.active = incoming.active
            record.activeAt = incoming.activeAt
            record.projectId = incoming.projectId
        }
        // Revisions survive deletion, so a delayed fetch cannot resurrect art.
        let sameAvatarCheckpoint = incoming.avatarUpdateSeq == record.avatarUpdateSeq
        if let revision = incoming.avatarVersion,
           revision > (record.avatarVersion ?? -1)
            || (revision == record.avatarVersion && sameAvatarCheckpoint && incoming.updatedAt >= old.updatedAt) {
            record.avatar = incoming.avatar
            record.avatarVersion = revision
        } else if incoming.avatarVersion == nil, sameAvatarCheckpoint, incoming.updatedAt >= old.updatedAt {
            if let descriptor = incoming.avatar {
                if descriptor.version >= (record.avatarVersion ?? -1) {
                    record.avatar = descriptor
                    record.avatarVersion = descriptor.version
                }
            } else {
                record.avatar = nil
            }
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
        if record != old { _ = try record.updateChanges(db, from: old) }
        return (old, record)
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
        let old = record
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
        if record != old { _ = try record.updateChanges(db, from: old) }
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
    /// A successful list fetch has completed, including an empty first list.
    public var sessionsSynced: Bool
    /// Updated only when disconnected last-seen text crosses its display
    /// granularity. Consumers use this clock when deriving status text.
    public var presenceNow: Int64?

    public init(machines: MachinesSnapshot, sessions: [SessionRecord], projects: [ProjectRecord] = [], settings: SettingsSnapshot = SettingsSnapshot(), sessionsSynced: Bool = false) {
        self.machines = machines
        self.sessions = sessions
        self.projects = projects
        self.settings = settings
        self.sessionsSynced = sessionsSynced
        self.presenceNow = nil
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
