import Foundation
import HappyCrypto
import HappyStore
import HappyWire

/// Keeps the on-device store in step with the server using deltas only.
///
///     server ──HTTP delta pulls──▶ SyncEngine ──merge──▶ LocalStore ──observe──▶ UI
///     server ──socket updates────▶ SyncEngine ──merge──▶ LocalStore
///     UI ──enqueue──▶ LocalStore.outbox ──flush──▶ SyncEngine ──HTTP──▶ server
///
/// - Sessions: `GET /v2/sessions?changedSince=<cursor>`; the cursor is the
///   highest `updatedAt` seen, with a small overlap. A full listing runs at
///   most once a day to drop sessions deleted while the device was offline.
/// - Messages: `GET /v3/sessions/:id/messages?after_seq=<syncedMessageSeq>`,
///   only for sessions whose server `seq` is ahead of the local log.
/// - Machines: the list is small and has no delta endpoint; it is fetched
///   whole and merged by version.
/// - Settings: local changes are stored as pending first, pushed with the
///   version they were based on, and re-based on the server's copy when
///   another device got there first (sync.ts `syncSettings`).
/// - Profile and projects: small, fetched whole. Projects are only the ones
///   stored sessions point at.
/// - Live updates are merged directly. Anything that does not line up (a
///   seq gap, an unknown session) schedules the matching delta pull instead
///   of being trusted. Live updates never move a cursor.
public actor SyncEngine {
    public enum Job: Hashable, Sendable {
        case sessions
        case machines
        case settings
        case profile
        case projects
        case pendingMessages
        case messages(sessionId: String)
        case outbox
    }

    public enum SyncError: Error, Equatable {
        /// Settings kept colliding with other devices' writes.
        case settingsConflict
    }

    public struct Options: Sendable {
        public var sessionsPageSize = 100
        public var messagesPageSize = 100
        /// Re-reads this much before the cursor, to cover rows committed out
        /// of `updatedAt` order. Merges are idempotent, so overlap is cheap.
        public var changedSinceOverlapMs: Int64 = 5_000
        public var fullSessionReconcileIntervalMs: Int64 = 24 * 60 * 60 * 1000
        public var messageSessionsPerPass = 50
        /// Downloaded pages are committed together, bounded by this record
        /// count (plus at most one server page). No transaction spans an await.
        public var messageWriteBatchSize = 1000
        public var sessionWriteBatchSize = 1000
        /// Approximate ciphertext bytes. A single oversized row is committed
        /// immediately rather than retained in the pending buffer.
        public var writeBatchMaximumBytes = 4 * 1024 * 1024
        public var writeBatchMaximumDelay: Duration = .milliseconds(400)
        /// Injectable deadline sleeper for deterministic operation-count tests.
        public var writeBatchSleep: InvalidateSync.Sleep = InvalidateSync.taskSleep
        /// Version conflicts tolerated per settings push before backing off.
        public var settingsPushAttempts = 3
        public var backoff: Backoff = .standard
        public var sendAttempts = 5
        public var sendRetryInitialMs: Int64 = 1_000
        public var sendRetryMaximumMs: Int64 = 60_000
        /// UIKit composition supplies a reference-counted background-task lease.
        /// true acquires before an operation; false releases after it finishes.
        public var deliveryActivity: @Sendable (Bool) async -> Void = { _ in }

        public init() {}
    }

    private let api: HappyAPI
    private let store: LocalStore
    private let keyRing: KeyRing
    /// This account's in-flight mode pushes, sampled by the store transaction.
    nonisolated let modePushes = SessionModePushCounters()
    /// This account's durable Rig drafts and serialized metadata writer.
    public nonisolated let rigComposer: RigComposerSync
    public nonisolated let presence: SessionPresence
    private let decoder: RecordDecoder
    private let accountCipher: AccountCipher
    private let options: Options
    private let random: RandomSource
    private let now: @Sendable () -> Int64
    private let sleep: InvalidateSync.Sleep
    private var jobs: [Job: InvalidateSync] = [:]
    private var stopped = false
    private var backgrounded = false
    private var filesDirectory: URL?
    private var retryTask: Task<Void, Never>?

    public init(
        api: HappyAPI,
        store: LocalStore,
        keys: AccountKeys,
        options: Options = Options(),
        random: RandomSource = SystemRandom(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        sleep: @escaping InvalidateSync.Sleep = InvalidateSync.taskSleep
    ) {
        self.api = api
        self.store = store
        let keyRing = KeyRing(keys: keys)
        self.keyRing = keyRing
        self.rigComposer = RigComposerSync(store: store, keyRing: keyRing, now: now, sleep: sleep)
        self.presence = SessionPresence(store: store, now: now)
        self.decoder = RecordDecoder(keyRing: keyRing)
        self.accountCipher = AccountCipher(secret: keys.secret)
        self.options = options
        self.random = random
        self.now = now
        self.sleep = sleep
    }

    // MARK: Lifecycle

    /// Launch and every socket (re)connect: pull everything that changed.
    public func syncAll() async {
        ThreadRules.assertOffMain()
        guard !stopped else { return }
        await presence.start()
        for job in [Job.sessions, .machines, .settings, .profile, .outbox] {
            await invalidate(job)
        }
    }

    public func stop() async {
        stopped = true
        await rigComposer.stop()
        retryTask?.cancel()
        retryTask = nil
        for job in jobs.values {
            await job.stop()
        }
        jobs = [:]
        try? await presence.stop()
    }

    public func invalidate(_ job: Job) async {
        await self.job(job)?.invalidate()
    }

    /// Runs `job` now (or joins the run in flight) and waits for it to succeed.
    public func run(_ job: Job) async {
        ThreadRules.assertOffMain()
        await self.job(job)?.invalidateAndAwait()
    }

    /// Returns once no job is running, including follow-ups that running
    /// jobs scheduled. For tests and for "pull to refresh" style waits.
    public func waitForIdle() async {
        while true {
            var busy = false
            for job in jobs.values where await job.isRunning {
                busy = true
            }
            if !busy { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    private func job(_ job: Job) -> InvalidateSync? {
        guard !stopped else { return nil }
        if let existing = jobs[job] { return existing }
        let sync = InvalidateSync(backoff: options.backoff, sleep: sleep) { [weak self] in
            try await self?.perform(job)
        }
        jobs[job] = sync
        return sync
    }

    private func perform(_ job: Job) async throws {
        switch job {
        case .sessions:
            try await pullSessions()
            await invalidate(.pendingMessages)
            await invalidate(.projects)
        case .machines:
            try await pullMachines()
        case .settings:
            try await pushSettings()
            try await pullSettings()
        case .profile:
            try await pullProfile()
        case .projects:
            try await pullProjects()
        case .pendingMessages:
            try await pullPendingMessages()
        case .messages(let sessionId):
            try await pullMessages(sessionId: sessionId)
        case .outbox:
            try await flushOutbox()
        }
    }

    // MARK: Pulls

    func pullSessions() async throws {
        ThreadRules.assertOffMain()
        let since = try store.cursor(.sessionsChangedSince)
        let lastFull = try store.cursor(.sessionsLastFullSync)
        let startedAt = now()
        let full = since == nil || lastFull == nil || startedAt - (lastFull ?? 0) >= options.fullSessionReconcileIntervalMs
        let avatarSequences = try store.avatarUpdateSequences()
        // The server wants a positive value; 1 means "everything", which is
        // still correct, just not a delta.
        let changedSince = full ? nil : max(1, (since ?? 0) - options.changedSinceOverlapMs)

        var pageCursor: String?
        var seen = Set<String>()
        var maxUpdatedAt = since ?? 0
        let store = self.store
        let reconcileComposer = modePushes.reconciliation
        let batch = SyncWriteBatch<SessionRecord, SessionListCheckpoint>(
            maximumRecords: options.sessionWriteBatchSize, maximumBytes: options.writeBatchMaximumBytes,
            maximumDelay: options.writeBatchMaximumDelay, sleep: options.writeBatchSleep,
            cost: { row in (1, row.metadataCipher.utf8.count + (row.agentStateCipher?.utf8.count ?? 0) + (row.dataKeyCipher?.utf8.count ?? 0)) },
            commit: { records, checkpoint in try store.applySessionListBatch(records, checkpoint: checkpoint, reconcileComposer: reconcileComposer) })
        do {
            repeat {
                let page = try await api.sessions(changedSince: changedSince, cursor: pageCursor, limit: options.sessionsPageSize)
                let previous = Dictionary(uniqueKeysWithValues: try store.sessions(ids: page.sessions.map(\.id)).map { ($0.id, $0) })
                let records = page.sessions.map { decoder.session($0, previous: previous[$0.id], avatarUpdateSeq: avatarSequences[$0.id]) }
                await presence.prepareSessions(records, previous: previous)
                try await batch.append(records)
                for session in page.sessions {
                    seen.insert(session.id)
                    maxUpdatedAt = max(maxUpdatedAt, session.updatedAt)
                }
                pageCursor = page.hasNext ? page.nextCursor : nil
            } while pageCursor != nil
        } catch {
            try await batch.finish()
            throw error
        }
        try await batch.finish(SessionListCheckpoint(changedSince: maxUpdatedAt,
                                                     fullIDs: full ? seen : nil, completedAt: full ? startedAt : nil))
        if full { await presence.reconcileStoredRows() }
    }

    func pullMachines() async throws {
        ThreadRules.assertOffMain()
        let rows = try await api.machines()
        let previous = Dictionary(uniqueKeysWithValues: try store.machines().map { ($0.id, $0) })
        let records = rows.map { decoder.machine($0, previous: previous[$0.id]) }
        await presence.prepareMachines(records)
        try store.replaceMachines(records)
        await presence.reconcileStoredRows()
        try store.setCursor(.machinesLastSync, now())
    }

    func pullSettings() async throws {
        ThreadRules.assertOffMain()
        let response = try await api.accountSettings()
        try store.applyAccountSettings(AccountSettingsRecord(
            version: response.settingsVersion,
            cipher: response.settings,
            settings: response.settings.flatMap(accountCipher.decrypt(base64:))
        ))
    }

    func pullProfile() async throws {
        ThreadRules.assertOffMain()
        try store.applyProfile(try await api.profile())
    }

    func pullProjects() async throws {
        ThreadRules.assertOffMain()
        let rows = try await api.projects(ids: try store.referencedProjectIds())
        try store.replaceProjects(rows.map(project))
    }

    /// A project's metadata is sealed with its own data key or, for older
    /// projects without one, with the account secret.
    private func project(_ row: APIProject) -> ProjectRecord {
        let metadata = row.dataEncryptionKey.map { keyRing.cipher(wrappedKey: $0)?.decrypt(base64: row.metadata) }
            ?? accountCipher.decrypt(base64: row.metadata)
        return ProjectRecord(
            id: row.id,
            externalId: row.externalId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            metadataVersion: row.metadataVersion,
            metadataCipher: row.metadata,
            metadata: metadata,
            dataKeyCipher: row.dataEncryptionKey, avatar: row.avatar
        )
    }

    func pullPendingMessages() async throws {
        ThreadRules.assertOffMain()
        let sessions = try store.sessionsNeedingMessageSync(limit: options.messageSessionsPerPass)
        try await pullMessageBatch(sessions)
        if sessions.count == options.messageSessionsPerPass {
            await invalidate(.pendingMessages)
        }
    }

    func pullMessages(sessionId: String) async throws {
        ThreadRules.assertOffMain()
        guard let session = try store.session(id: sessionId) else { return }
        try await pullMessageBatch([session])
    }

    private func pullMessageBatch(_ sessions: [SessionRecord]) async throws {
        let store = self.store
        let batch = SyncWriteBatch<MessageBatchItem, NoSyncCheckpoint>(
            maximumRecords: options.messageWriteBatchSize, maximumBytes: options.writeBatchMaximumBytes,
            maximumDelay: options.writeBatchMaximumDelay, sleep: options.writeBatchSleep,
            cost: { item in
                switch item {
                case .record(let message): return (1, message.contentCipher.utf8.count)
                case .cursor: return (0, 0)
                }
            },
            commit: { items, _ in try store.applyMessagePages(Self.messageWrites(items)) })
        do {
            for session in sessions {
                guard session.decryptable, let cipher = keyRing.cipher(wrappedKey: session.dataKeyCipher) else { continue }
                var afterSeq = session.syncedMessageSeq
                while true {
                    let page = try await api.messages(sessionId: session.id, afterSeq: afterSeq, limit: options.messagesPageSize)
                    let records = page.messages.map { decoder.message($0, sessionId: session.id, cipher: cipher) }
                    let lastSeq = page.messages.map(\.seq).max()
                    var items = records.map(MessageBatchItem.record)
                    if !page.hasMore { items.append(.cursor(sessionId: session.id, through: max(lastSeq ?? 0, session.seq))) }
                    try await batch.append(items)
                    guard page.hasMore, let lastSeq, lastSeq > afterSeq else { break }
                    afterSeq = lastSeq
                }
            }
        } catch {
            // Keep completed downloads and their page cursors on request
            // failure/cancellation, just as the old per-page writes did.
            try await batch.finish()
            throw error
        }
        try await batch.finish()
    }

    /// Group records back into page writes at commit time. Cursor markers
    /// cost no records/bytes and follow only their successfully fetched page.
    /// Splitting a page at a memory boundary cannot advance its final cursor.
    private static func messageWrites(_ items: [MessageBatchItem]) -> [MessagePageWrite] {
        var result: [MessagePageWrite] = []
        for item in items {
            switch item {
            case .record(let message):
                if result.last?.sessionId != message.sessionId {
                    result.append(MessagePageWrite(sessionId: message.sessionId, messages: []))
                }
                result[result.count - 1].messages.append(message)
            case .cursor(let sessionId, let through):
                if result.last?.sessionId != sessionId { result.append(MessagePageWrite(sessionId: sessionId, messages: [])) }
                let index = result.count - 1
                let previous = result[index].syncedThrough ?? 0
                result[index].syncedThrough = max(previous, through)
            }
        }
        return result
    }

    // MARK: Settings

    /// Changes account settings. The change shows at once and is pushed in
    /// the background; it survives a relaunch until the server accepts it.
    public func updateSettings(_ delta: [String: JSONValue]) async throws {
        ThreadRules.assertOffMain()
        try store.addPendingSettings(delta)
        await invalidate(.settings)
    }

    /// Pushes pending settings on top of the server's copy. A version
    /// conflict re-bases them on the copy the server returns and tries
    /// again; local changes win key by key.
    func pushSettings() async throws {
        ThreadRules.assertOffMain()
        var conflicts = 0
        while true {
            let pending = try store.pendingSettings()
            guard !pending.isEmpty else { return }
            guard conflicts < options.settingsPushAttempts else { throw SyncError.settingsConflict }

            let synced = try store.accountSettings()
            var values = synced?.settings?.objectValue ?? [:]
            values.merge(pending) { _, local in local }
            let payload = AccountSettings(values).syncPayload
            let cipher = try accountCipher.encrypt(payload, random: random)
            let response = try await api.updateAccountSettings(UpdateAccountSettingsRequest(
                settings: cipher,
                expectedVersion: synced?.version ?? 0
            ))
            switch response {
            case .success(let version):
                try store.applyAccountSettings(AccountSettingsRecord(version: version, cipher: cipher, settings: payload))
                // Only what was sent is settled; a change made during the
                // round trip goes out on the next pass.
                try store.settlePendingSettings(sent: pending)
                return
            case .versionMismatch(let currentVersion, let currentSettings):
                try store.replaceAccountSettings(AccountSettingsRecord(
                    version: currentVersion,
                    cipher: currentSettings,
                    settings: currentSettings.flatMap(accountCipher.decrypt(base64:))
                ))
                conflicts += 1
            }
        }
    }

    // MARK: Session state

    /// The data key of a stored session, for calls that encrypt to it.
    public func cipher(forSession id: String) throws -> RecordCipher? {
        ThreadRules.assertOffMain()
        guard let session = try store.session(id: id) else { return nil }
        return keyRing.cipher(wrappedKey: session.dataKeyCipher)
    }

    /// The stored machine's own wrapped data key seals machine-scoped RPC.
    public func cipher(forMachine id: String) throws -> RecordCipher? {
        ThreadRules.assertOffMain()
        guard let machine = try store.machine(id: id) else { return nil }
        return keyRing.cipher(wrappedKey: machine.dataKeyCipher)
    }

    /// The session data key for encrypted resume fallback to its owning machine.
    /// Missing or legacy keys return nil; the account master secret never leaves.
    public func sessionDataKey(forSession id: String) throws -> Data? {
        ThreadRules.assertOffMain()
        guard let session = try store.session(id: id) else { return nil }
        return keyRing.dataKey(wrappedKey: session.dataKeyCipher)
    }

    /// Ports sync.ts ensureSessionReady. Each sessions-sync wait is capped at
    /// four seconds; three rounds back off by 300 then 600 milliseconds.
    public func ensureSessionReady(sessionId: String) async throws {
        guard let sessions = job(.sessions) else { throw SessionReadinessError.notReady }
        try await SessionReadiness.ensure(
            isReady: { [weak self] in try await self?.sessionReady(sessionId) ?? false },
            refresh: { await sessions.invalidateAndAwait() },
            sleep: sleep
        )
    }

    private func sessionReady(_ id: String) throws -> Bool {
        guard !stopped, let session = try store.session(id: id), session.metadata?.objectValue != nil else { return false }
        return keyRing.cipher(wrappedKey: session.dataKeyCipher) != nil && keyRing.blobKey(wrappedKey: session.dataKeyCipher) != nil
    }

    /// Ports sync.ts uploadSessionBlob using the outbox's same blob encryption.
    /// Upload requests count sealed bytes; the result reports plaintext bytes.
    public func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) {
        ThreadRules.assertOffMain()
        guard !stopped, !backgrounded else { throw CancellationError() }
        try Task.checkCancellation()
        let blob = try encryptedSessionBlob(sessionId: sessionId, bytes: bytes)
        await options.deliveryActivity(true)
        do {
            let upload = try await api.requestAttachmentUpload(sessionId: sessionId, filename: name, size: blob.count)
            try Task.checkCancellation()
            guard !stopped else { throw CancellationError() }
            try await api.uploadEncryptedBlob(blob, upload: upload)
            try Task.checkCancellation()
            guard !stopped else { throw CancellationError() }
            await options.deliveryActivity(false)
            return (upload.ref, bytes.count)
        } catch {
            await options.deliveryActivity(false)
            throw error
        }
    }

    private func encryptedSessionBlob(sessionId: String, bytes: Data) throws -> Data {
        guard let session = try store.session(id: sessionId), let key = keyRing.blobKey(wrappedKey: session.dataKeyCipher) else { throw SessionActionError.notDecryptable }
        return try BlobCipher.seal(bytes, key: key, random: random)
    }

    // MARK: Outbox

    /// Supplies the account's files directory before launch/reconnect delivery.
    public func configureSending(filesDirectory: URL) {
        self.filesDirectory = filesDirectory
    }

    /// Pauses new deliveries in the background and resumes them on foreground.
    /// An item already holding deliveryActivity's lease is allowed to finish.
    public func setBackgrounded(_ value: Bool) async {
        backgrounded = value
        if value {
            try? await presence.flush()
            retryTask?.cancel()
            retryTask = nil
        } else {
            await invalidate(.outbox)
        }
    }

    /// Checks the account/session at acceptance, then commits without suspension.
    /// Unsupported permission modes throw before any file is copied or enqueued.
    /// Rejected attachments are dropped; a rejected batch without text is refused.
    public func accept(_ message: OutgoingMessage, sessionId: String, filesDirectory: URL) async throws -> String {
        ThreadRules.assertOffMain()
        guard !stopped, !Task.isCancelled else {
            throw SendingError.inactiveAccount
        }
        guard let session = try store.session(id: sessionId) else {
            throw SendingError.unknownSession
        }
        let composer = try store.composerState(sessionId: sessionId).values
        let settings = try AccountSettings(store.settingsSnapshot()).syncPayload
        let payload = try UserMessageEncoder.encode(
            message, session: session, composer: composer, settings: settings,
            hasPendingUserMessage: try hasPendingUserMessage(sessionId: sessionId), sentFrom: Self.sentFrom
        )
        let attachmentPlan = OutboxSender.attachmentPlan(message, session: session)
        if attachmentPlan.shouldShowUnsupportedAlert,
           attachmentPlan.accepted.isEmpty,
           message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw SendingError.unsupportedAttachments
        }
        self.filesDirectory = filesDirectory
        let localId = UUID().uuidString
        let timestamp = now()
        var attachments: [AttachmentRecord] = []
        var items: [OutboxRecord] = []
        var copied: [URL] = []
        do {
            try FileManager.default.createDirectory(at: filesDirectory, withIntermediateDirectories: true)
            var dependency: String?
            for attachment in attachmentPlan.accepted {
                let id = UUID().uuidString
                let destination = filesDirectory.appendingPathComponent(id)
                try FileManager.default.copyItem(at: attachment.fileURL, to: destination)
                copied.append(destination)
                let actualSize = try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber
                let record = AttachmentRecord(
                    localId: id,
                    sessionId: sessionId,
                    outboxLocalId: id,
                    path: id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    size: actualSize?.intValue ?? attachment.size,
                    width: attachment.width,
                    height: attachment.height,
                    thumbhash: attachment.thumbhash,
                    createdAt: timestamp
                )
                attachments.append(record)
                let file = Self.filePayload(id: id, time: timestamp, attachment: attachments.last!, ref: "")
                items.append(OutboxRecord(
                    localId: id, kind: .file, sessionId: sessionId, payload: file,
                    createdAt: timestamp, dependsOn: dependency
                ))
                dependency = id
            }
            items.append(OutboxRecord(
                localId: localId, kind: .message, sessionId: sessionId, payload: payload,
                createdAt: timestamp, dependsOn: dependency
            ))
            try store.enqueueAcceptedSend(items, attachments: attachments)
        } catch {
            for file in copied {
                try? FileManager.default.removeItem(at: file)
            }
            throw error
        }
        await invalidate(.outbox)
        return localId
    }

    /// sync.ts's `hasPendingUserMessage`: text still in the outbox, or
    /// delivered and not yet accepted by the daemon (the reducer's
    /// `pending`), worked out from the chat's records in the store.
    private func hasPendingUserMessage(sessionId: String) throws -> Bool {
        let queued = try store.pendingOutbox(limit: Int.max).contains {
            $0.sessionId == sessionId && $0.kind == .message && $0.state != .failed
        }
        return try queued || UnacceptedUserMessages.contains(store.acceptanceRecords(sessionId: sessionId))
    }

    private static var sentFrom: String {
        #if os(macOS) || targetEnvironment(macCatalyst)
        return "mac"
        #elseif os(iOS)
        if ProcessInfo.processInfo.isiOSAppOnMac {
            return "mac"
        }
        return "ios"
        #else
        return "ios"
        #endif
    }

    public func retrySend(localId: String) async throws {
        guard !stopped else {
            throw SendingError.inactiveAccount
        }
        try store.retryOutbox(localId: localId)
        await invalidate(.outbox)
    }

    public func discardSend(localId: String, filesDirectory: URL) throws {
        ThreadRules.assertOffMain()
        for attachment in try store.discardOutbox(localId: localId) {
            try? FileManager.default.removeItem(at: filesDirectory.appendingPathComponent(attachment.path))
        }
    }

    public func downloadAttachment(sessionId: String, ref: String) async throws -> Data {
        ThreadRules.assertOffMain()
        guard !stopped, let session = try store.session(id: sessionId),
              let key = keyRing.blobKey(wrappedKey: session.dataKeyCipher) else {
            throw SendingError.unknownSession
        }
        let blob = try await api.downloadEncryptedAttachment(sessionId: sessionId, ref: ref)
        guard !stopped, let plaintext = BlobCipher.open(blob, key: key) else {
            throw CryptoError.invalidInput("attachment cannot be decrypted")
        }
        return plaintext
    }

    static func filePayload(id: String, time: Int64, attachment: AttachmentRecord, ref: String) -> JSONValue {
        var event: [String: JSONValue] = [
            "t": .string("file"),
            "ref": .string(ref),
            "name": .string(attachment.name),
            "size": .number(Double(attachment.size)),
        ]
        if let width = attachment.width, let height = attachment.height, width > 0, height > 0 {
            var image: [String: JSONValue] = ["width": .number(Double(width)), "height": .number(Double(height))]
            if let hash = attachment.thumbhash, !hash.isEmpty {
                image["thumbhash"] = .string(hash)
            }
            event["image"] = .object(image)
        }
        return .object([
            "role": .string("session"),
            "content": .object([
                "type": .string("session"),
                "data": .object([
                    "id": .string(id),
                    "time": .number(Double(time)),
                    "role": .string("user"),
                    "ev": .object(event),
                ]),
            ]),
        ])
    }

    func flushOutbox() async throws {
        ThreadRules.assertOffMain()
        guard !stopped, !backgrounded else {
            return
        }
        retryTask?.cancel()
        retryTask = nil
        var blocked = Set<String>()
        for var item in try store.pendingOutbox(limit: Int.max) {
            guard !stopped, !backgrounded, !Task.isCancelled else {
                break
            }
            // A failed upload is skipped like happy-app; a failed POST retains order.
            if item.state == .failed {
                let uploaded = try store.attachment(outboxLocalId: item.localId)?.ref != nil
                if item.kind == .message || uploaded {
                    blocked.insert(item.sessionId)
                }
                continue
            }
            guard !blocked.contains(item.sessionId) else {
                continue
            }
            if item.nextAttemptAt > now() {
                blocked.insert(item.sessionId)
                continue
            }
            if let dependency = item.dependsOn, let earlier = try store.outbox(localId: dependency) {
                let skipped = try store.attachment(outboxLocalId: earlier.localId)?.ref == nil
                if !(earlier.kind == .file && earlier.state == .failed && skipped) {
                    blocked.insert(item.sessionId)
                    continue
                }
            }
            guard let session = try store.session(id: item.sessionId),
                  session.decryptable,
                  let cipher = keyRing.cipher(wrappedKey: session.dataKeyCipher)
            else {
                try store.markOutboxFailed(localId: item.localId, error: "session cannot be encrypted to")
                blocked.insert(item.sessionId)
                continue
            }
            item.state = .sending
            item.attempts += 1
            try store.updateOutbox(item)
            await options.deliveryActivity(true)
            do {
                try checkDelivery(item, session: session)
                if item.kind == .file {
                    guard var attachment = try store.attachment(outboxLocalId: item.localId),
                          let directory = filesDirectory else {
                        throw SendingError.missingAttachment
                    }
                    if attachment.ref == nil {
                        let bytes = try Data(contentsOf: directory.appendingPathComponent(attachment.path))
                        let blob = try encryptedSessionBlob(sessionId: item.sessionId, bytes: bytes)
                        let upload = try await api.requestAttachmentUpload(sessionId: item.sessionId, filename: attachment.name, size: blob.count)
                        try checkDelivery(item, session: session)
                        try await api.uploadEncryptedBlob(blob, upload: upload)
                        attachment.ref = upload.ref
                        if try store.outbox(localId: item.localId) != nil {
                            try store.saveAttachment(attachment)
                        }
                    }
                    item.payload = Self.filePayload(id: item.localId, time: item.createdAt, attachment: attachment, ref: attachment.ref!)
                    try store.updateOutbox(item)
                }
                try checkDelivery(item, session: session)
                let content = try cipher.encrypt(bytes: UserMessageEncoder.wireBytes(item.payload), random: random)
                let response = try await api.sendMessages(
                    sessionId: item.sessionId,
                    SendMessagesRequest(messages: [.init(content: content, localId: item.localId)])
                )
                guard response.messages.contains(where: { $0.localId == item.localId }) else {
                    throw SendingError.missingAcknowledgement
                }
                for sent in response.messages where sent.localId == item.localId {
                    let record = MessageRecord(
                        id: sent.id,
                        sessionId: item.sessionId,
                        seq: sent.seq,
                        localId: sent.localId,
                        createdAt: sent.createdAt,
                        updatedAt: sent.updatedAt,
                        contentCipher: content,
                        content: item.payload
                    )
                    if try store.applyLiveMessage(record) == .gap {
                        await invalidate(.messages(sessionId: item.sessionId))
                    }
                }
                try store.removeFromOutbox(localId: item.localId)
            } catch {
                item.lastError = String(describing: error)
                if error is CancellationError {
                    item.state = .queued
                    item.nextAttemptAt = 0
                } else {
                    item.state = item.attempts >= options.sendAttempts || Self.permanentSendError(error) ? .failed : .queued
                    let delay = min(options.sendRetryMaximumMs, options.sendRetryInitialMs * Int64(pow(2, Double(min(item.attempts - 1, 16)))))
                    item.nextAttemptAt = now() + delay
                }
                do {
                    try store.updateOutbox(item)
                    let noRef = try store.attachment(outboxLocalId: item.localId)?.ref == nil
                    let skippedUpload = item.kind == .file && item.state == .failed && noRef
                    if !skippedUpload {
                        blocked.insert(item.sessionId)
                    }
                } catch {
                    await options.deliveryActivity(false)
                    throw error
                }
            }
            await options.deliveryActivity(false)
        }
        if !stopped, !backgrounded {
            let pending = try store.pendingOutbox(limit: Int.max)
            // Only the head eligible item in each session drives the retry timer.
            var seen = Set<String>()
            let times = pending.compactMap { item -> Int64? in
                if item.state == .failed && item.kind == .file
                    && (try? store.attachment(outboxLocalId: item.localId)?.ref) == nil {
                    return nil
                }
                guard seen.insert(item.sessionId).inserted, item.state == .queued else {
                    return nil
                }
                return max(now() + 1, item.nextAttemptAt)
            }
            if let time = times.min() {
                let delay = Duration.milliseconds(max(1, time - now()))
                let sleep = self.sleep
                retryTask = Task { [weak self] in
                    do {
                        try await sleep(delay)
                        try Task.checkCancellation()
                        await self?.invalidate(.outbox)
                    } catch {}
                }
            }
        }
    }

    private static func permanentSendError(_ error: Error) -> Bool {
        if case APIError.http(let status, _) = error {
            return (400..<500).contains(status) && ![408, 409, 429].contains(status)
        }
        return (error as? SendingError) == .missingAttachment || (error as? SendingError) == .unknownSession
    }

    private func checkDelivery(_ item: OutboxRecord, session: SessionRecord) throws {
        guard !stopped, !Task.isCancelled, try store.outbox(localId: item.localId) != nil else {
            throw CancellationError()
        }
        guard let current = try store.session(id: item.sessionId), current.decryptable,
              current.dataKeyCipher == session.dataKeyCipher else {
            throw SendingError.unknownSession
        }
    }

    // MARK: Live updates

    public func handle(_ update: UpdateContainer) async {
        ThreadRules.assertOffMain()
        guard !stopped else { return }
        let followUp: Job?
        do {
            followUp = try await apply(update.body, at: update.createdAt, seq: update.seq)
        } catch {
            // A merge that failed locally is recovered by the delta pulls.
            await syncAll()
            return
        }
        if let followUp {
            await invalidate(followUp)
        }
    }

    /// Merges one update; returns the pull to run when it did not line up.
    private func apply(_ body: UpdateBody, at timestamp: Int64, seq: Int) async throws -> Job? {
        switch body {
        case .newMessage(let sessionId, let message):
            guard let session = try store.session(id: sessionId) else { return .sessions }
            let cipher = keyRing.cipher(wrappedKey: session.dataKeyCipher)
            switch try store.applyLiveMessage(decoder.message(message, sessionId: sessionId, cipher: cipher)) {
            case .applied: return nil
            case .gap: return .messages(sessionId: sessionId)
            case .unknownSession: return .sessions
            }

        case .newSession(let body):
            guard let row = body.asSession else { return .sessions }
            let record = decoder.session(row)
            let previous = try store.session(id: row.id).map { [row.id: $0] } ?? [:]
            await presence.prepareSessions([record], previous: previous)
            try store.upsertSessions([record], reconcileComposer: modePushes.reconciliation)
            return row.projectId == nil ? nil : .projects

        case .updateSession(let body):
            guard let session = try store.session(id: body.id) else { return .sessions }
            let cipher = keyRing.cipher(wrappedKey: session.dataKeyCipher)
            _ = try store.applySessionUpdate(
                id: body.id,
                metadata: decoder.versioned(body.metadata, cipher: cipher, after: session.metadataVersion),
                agentState: decoder.versioned(body.agentState, cipher: cipher, after: session.agentStateVersion),
                projectId: body.projectId,
                avatar: body.avatar, avatarVersion: body.avatarVersion, avatarUpdateSeq: seq,
                reconcileComposer: modePushes.reconciliation
            )
            return body.projectId == nil ? nil : .projects

        case .deleteSession(let sessionId):
            try await presence.deleteSession(sessionId)
            return nil

        case .newMachine(let body):
            let record = decoder.machine(body.asMachine)
            await presence.prepareMachines([record])
            try store.upsertMachine(record)
            return nil

        case .updateMachine(let body):
            guard let machine = try store.machine(id: body.machineId) else { return .machines }
            let cipher = keyRing.cipher(wrappedKey: machine.dataKeyCipher)
            if let activeAt = body.activeAt, activeAt >= machine.activeAt {
                var presenceRow = machine
                presenceRow.activeAt = activeAt
                if let active = body.active { presenceRow.active = active }
                await presence.prepareMachines([presenceRow])
            }
            _ = try store.applyMachineUpdate(
                id: body.machineId,
                metadata: decoder.versioned(body.metadata, cipher: cipher, after: machine.metadataVersion),
                daemonState: decoder.versioned(body.daemonState, cipher: cipher, after: machine.daemonStateVersion),
                active: body.active,
                activeAt: body.activeAt
            )
            return nil

        case .deleteMachine(let machineId):
            try await presence.deleteMachine(machineId)
            return nil

        case .updateAccount(let body):
            if let settings = body.settings {
                try store.applyAccountSettings(AccountSettingsRecord(
                    version: settings.version,
                    cipher: settings.value,
                    settings: settings.value.flatMap(accountCipher.decrypt(base64:))
                ))
            }
            try store.patchProfile(body, at: timestamp)
            return nil

        case .newProject, .updateProject:
            return .projects

        case .deleteProject(let projectId):
            try store.deleteProject(id: projectId)
            return nil

        case .kvBatchUpdate, .unsupported:
            return nil
        }
    }

    public func handle(_ event: EphemeralEvent) async {
        ThreadRules.assertOffMain()
        guard !stopped else { return }
        switch event {
        case .activity(let sessionId, let active, let activeAt, let thinking):
            await presence.activity(id: sessionId, active: active, activeAt: activeAt, thinking: thinking)
        case .machineActivity(let machineId, let active, let activeAt):
            await presence.machineActivity(id: machineId, active: active, activeAt: activeAt)
        case .machineStatus, .sessionEvent, .unsupported:
            break
        }
    }
}
