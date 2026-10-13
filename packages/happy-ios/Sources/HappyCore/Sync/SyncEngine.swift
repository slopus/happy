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
        sleep: @escaping InvalidateSync.Sleep = { try await Task.sleep(for: $0) }
    ) {
        self.api = api
        self.store = store
        let keyRing = KeyRing(keys: keys)
        self.keyRing = keyRing
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
        for job in [Job.sessions, .machines, .settings, .profile, .outbox] {
            await invalidate(job)
        }
    }

    public func stop() async {
        stopped = true
        retryTask?.cancel()
        retryTask = nil
        for job in jobs.values {
            await job.stop()
        }
        jobs = [:]
    }

    public func invalidate(_ job: Job) async {
        await self.job(job)?.invalidate()
    }

    /// Runs `job` now (or joins the run in flight) and waits for it to succeed.
    public func run(_ job: Job) async {
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
        let since = try store.cursor(.sessionsChangedSince)
        let lastFull = try store.cursor(.sessionsLastFullSync)
        let startedAt = now()
        let full = since == nil || lastFull == nil || startedAt - (lastFull ?? 0) >= options.fullSessionReconcileIntervalMs
        // The server wants a positive value; 1 means "everything", which is
        // still correct, just not a delta.
        let changedSince = full ? nil : max(1, (since ?? 0) - options.changedSinceOverlapMs)

        var pageCursor: String?
        var seen = Set<String>()
        var maxUpdatedAt = since ?? 0
        repeat {
            let page = try await api.sessions(changedSince: changedSince, cursor: pageCursor, limit: options.sessionsPageSize)
            try store.upsertSessions(page.sessions.map(decoder.session))
            for session in page.sessions {
                seen.insert(session.id)
                maxUpdatedAt = max(maxUpdatedAt, session.updatedAt)
            }
            pageCursor = page.hasNext ? page.nextCursor : nil
        } while pageCursor != nil

        if full {
            try store.retainSessions(ids: seen, updatedAtOrBefore: maxUpdatedAt)
            try store.setCursor(.sessionsLastFullSync, startedAt)
        }
        try store.setCursor(.sessionsChangedSince, maxUpdatedAt)
    }

    func pullMachines() async throws {
        let rows = try await api.machines()
        try store.replaceMachines(rows.map(decoder.machine))
        try store.setCursor(.machinesLastSync, now())
    }

    func pullSettings() async throws {
        let response = try await api.accountSettings()
        try store.applyAccountSettings(AccountSettingsRecord(
            version: response.settingsVersion,
            cipher: response.settings,
            settings: response.settings.flatMap(accountCipher.decrypt(base64:))
        ))
    }

    func pullProfile() async throws {
        try store.applyProfile(try await api.profile())
    }

    func pullProjects() async throws {
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
            dataKeyCipher: row.dataEncryptionKey
        )
    }

    func pullPendingMessages() async throws {
        let sessions = try store.sessionsNeedingMessageSync(limit: options.messageSessionsPerPass)
        for session in sessions {
            try await pullMessages(sessionId: session.id)
        }
        if sessions.count == options.messageSessionsPerPass {
            await invalidate(.pendingMessages)
        }
    }

    func pullMessages(sessionId: String) async throws {
        guard let session = try store.session(id: sessionId),
              session.decryptable,
              let cipher = keyRing.cipher(wrappedKey: session.dataKeyCipher)
        else { return }

        var afterSeq = session.syncedMessageSeq
        while true {
            let page = try await api.messages(sessionId: sessionId, afterSeq: afterSeq, limit: options.messagesPageSize)
            let records = page.messages.map { decoder.message($0, sessionId: sessionId, cipher: cipher) }
            let lastSeq = page.messages.map(\.seq).max()
            try store.applyMessagePage(
                sessionId: sessionId,
                messages: records,
                syncedThrough: page.hasMore ? nil : max(lastSeq ?? 0, session.seq)
            )
            guard page.hasMore, let lastSeq, lastSeq > afterSeq else { break }
            afterSeq = lastSeq
        }
    }

    // MARK: Settings

    /// Changes account settings. The change shows at once and is pushed in
    /// the background; it survives a relaunch until the server accepts it.
    public func updateSettings(_ delta: [String: JSONValue]) async throws {
        try store.addPendingSettings(delta)
        await invalidate(.settings)
    }

    /// Pushes pending settings on top of the server's copy. A version
    /// conflict re-bases them on the copy the server returns and tries
    /// again; local changes win key by key.
    func pushSettings() async throws {
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
        guard let session = try store.session(id: id) else { return nil }
        return keyRing.cipher(wrappedKey: session.dataKeyCipher)
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
        guard !stopped, !Task.isCancelled else {
            throw SendingError.inactiveAccount
        }
        guard let session = try store.session(id: sessionId) else {
            throw SendingError.unknownSession
        }
        let pending = try store.pendingOutbox(limit: Int.max).contains {
            $0.sessionId == sessionId && $0.kind == .message && $0.state != .failed
        }
        let composer = try store.composerState(sessionId: sessionId).values
        let settings = try AccountSettings(store.settingsSnapshot()).syncPayload
        let payload = try UserMessageEncoder.encode(
            message, session: session, composer: composer, settings: settings,
            hasPendingUserMessage: pending, sentFrom: Self.sentFrom
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
            try store.enqueueBatch(items, attachments: attachments)
        } catch {
            for file in copied {
                try? FileManager.default.removeItem(at: file)
            }
            throw error
        }
        await invalidate(.outbox)
        return localId
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
        for attachment in try store.discardOutbox(localId: localId) {
            try? FileManager.default.removeItem(at: filesDirectory.appendingPathComponent(attachment.path))
        }
    }

    public func downloadAttachment(sessionId: String, ref: String) async throws -> Data {
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
                          let directory = filesDirectory,
                          let blobKey = keyRing.blobKey(wrappedKey: session.dataKeyCipher) else {
                        throw SendingError.missingAttachment
                    }
                    if attachment.ref == nil {
                        let bytes = try Data(contentsOf: directory.appendingPathComponent(attachment.path))
                        let blob = try BlobCipher.seal(bytes, key: blobKey, random: random)
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
        let followUp: Job?
        do {
            followUp = try apply(update.body, at: update.createdAt)
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
    private func apply(_ body: UpdateBody, at timestamp: Int64) throws -> Job? {
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
            try store.upsertSessions([decoder.session(row)])
            return row.projectId == nil ? nil : .projects

        case .updateSession(let body):
            guard let session = try store.session(id: body.id) else { return .sessions }
            let cipher = keyRing.cipher(wrappedKey: session.dataKeyCipher)
            _ = try store.applySessionUpdate(
                id: body.id,
                metadata: decoder.versioned(body.metadata, cipher: cipher),
                agentState: decoder.versioned(body.agentState, cipher: cipher),
                projectId: body.projectId
            )
            return body.projectId == nil ? nil : .projects

        case .deleteSession(let sessionId):
            try store.deleteSession(id: sessionId)
            return nil

        case .newMachine(let body):
            try store.upsertMachine(decoder.machine(body.asMachine))
            return nil

        case .updateMachine(let body):
            guard let machine = try store.machine(id: body.machineId) else { return .machines }
            let cipher = keyRing.cipher(wrappedKey: machine.dataKeyCipher)
            _ = try store.applyMachineUpdate(
                id: body.machineId,
                metadata: decoder.versioned(body.metadata, cipher: cipher),
                daemonState: decoder.versioned(body.daemonState, cipher: cipher),
                active: body.active,
                activeAt: body.activeAt
            )
            return nil

        case .deleteMachine(let machineId):
            try store.deleteMachine(id: machineId)
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
        switch event {
        case .activity(let sessionId, let active, let activeAt, let thinking):
            try? store.applySessionActivity(id: sessionId, active: active, activeAt: activeAt, thinking: thinking)
        case .machineActivity(let machineId, let active, let activeAt):
            _ = try? store.applyMachineUpdate(id: machineId, metadata: nil, daemonState: nil, active: active, activeAt: activeAt)
        case .machineStatus, .sessionEvent, .unsupported:
            break
        }
    }
}
