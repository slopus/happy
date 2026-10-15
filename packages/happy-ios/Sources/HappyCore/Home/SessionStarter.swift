import Foundation
import HappyWire

/// One fully resolved request to start a session: what the composer's
/// draft says once the computer, harness, modes and place are settled
/// (useStartSessionFromDraft.ts up to `beginRun`).
public struct NewSessionLaunch: Sendable {
    /// The daemon that receives the spawn: Happy Agent's or Happy CLI's.
    public var machineId: String
    public var agent: NewSessionDraft.Agent
    /// The Happy Agent machine's metadata, which the spawn is checked
    /// against. Nil for Happy CLI.
    public var rigMetadata: JSONValue?
    /// The resolved directory, absolute on that computer.
    public var absolutePath: String
    /// `__none__`, `__new__`, or an existing worktree's path.
    public var worktreeSelection: String
    /// Happy CLI's machine that creates a new git worktree, when one is
    /// asked for and Happy Agent's catalog isn't doing it.
    public var worktreeCreationMachineId: String?
    /// The catalog destination, for Happy Agent.
    public var target: HappyAgentSpawnTarget?
    public var permissionMode: String
    public var modelMode: String
    public var effortLevel: String?
    /// The first message; empty sends none.
    public var prompt: String
    public var attachments: [OutgoingAttachment]
    public var signature: SpawnRequests.Signature
    /// The bot being made, and the face it is to wear.
    public var bot: Bot?

    public struct Bot: Equatable, Sendable {
        public var name: String
        public var faceSeed: String

        public init(name: String, faceSeed: String) {
            self.name = name
            self.faceSeed = faceSeed
        }
    }

    public init(
        machineId: String,
        agent: NewSessionDraft.Agent,
        rigMetadata: JSONValue?,
        absolutePath: String,
        worktreeSelection: String,
        worktreeCreationMachineId: String?,
        target: HappyAgentSpawnTarget?,
        permissionMode: String,
        modelMode: String,
        effortLevel: String?,
        prompt: String,
        attachments: [OutgoingAttachment],
        signature: SpawnRequests.Signature,
        bot: Bot? = nil
    ) {
        self.machineId = machineId
        self.agent = agent
        self.rigMetadata = rigMetadata
        self.absolutePath = absolutePath
        self.worktreeSelection = worktreeSelection
        self.worktreeCreationMachineId = worktreeCreationMachineId
        self.target = target
        self.permissionMode = permissionMode
        self.modelMode = modelMode
        self.effortLevel = effortLevel
        self.prompt = prompt
        self.attachments = attachments
        self.signature = signature
        self.bot = bot
    }

    var isRig: Bool { rigMetadata != nil }
}

/// What a start needs to tell or ask the person.
@MainActor
public protocol SessionStarterPresenter: AnyObject {
    /// happy-app's `Modal.alert(t('common.error'), message)`.
    func showStartError(_ message: String)
    /// "Create Directory?": the directory doesn't exist yet.
    func confirmDirectoryCreation(_ directory: String) async -> Bool
    /// "Picture not set": the bot was made but its face didn't take. True
    /// to try the face again.
    func offerBotFaceRetry(_ message: String) async -> Bool
    /// `imageUpload.notSupported`: the new session's agent takes none of
    /// the pictures, so they were not sent.
    func showAttachmentsNotSupported()
}

/// Starts a session and reports each step (useStartSessionFromDraft.ts
/// from `beginRun` on): create the worktree, ask the machine for the
/// session, wait for it to sync, pin its modes, send the first message.
///
/// Stop is felt at once. A request already on its way cannot be recalled
/// and the machine may never answer, so every wait races the attempt's
/// cancellation; whatever the machine hands back afterwards is put down
/// unattended.
@MainActor
public final class SessionStarter {
    public struct Environment {
        public var ops: any HomeOps
        public var sessionOps: any HomeSessionOps
        public var sender: any ChatSending
        public var metadataTransport: any MetadataUpdateTransport
        /// sync.ts `refreshSessions`.
        public var refreshSessions: @Sendable () async -> Void
        /// utils/botFacePaint.ts `paintBotFace`: a seed's face as PNG
        /// bytes, painted off the main thread.
        public var paintBotFace: @Sendable (String) async throws -> Data
        /// `OutboxSender.attachmentPlan`: which pictures the session's agent
        /// takes. It reads the store, so it runs off the main thread.
        public var attachmentPlan: @Sendable (OutgoingMessage, String) async throws -> AttachmentSendPlan
        public var spawnRequests: SpawnRequests
        public var sleep: @Sendable (Int) async -> Void

        /// `Task.sleep` for a number of milliseconds, the default `sleep`:
        /// compiled once, here, as `InvalidateSync.taskSleep` explains.
        public static let taskSleep: @Sendable (Int) async -> Void = { ms in try? await Task.sleep(for: .milliseconds(ms)) }

        @MainActor
        public init(
            ops: any HomeOps,
            sessionOps: any HomeSessionOps,
            sender: any ChatSending,
            metadataTransport: any MetadataUpdateTransport,
            refreshSessions: @escaping @Sendable () async -> Void,
            paintBotFace: @escaping @Sendable (String) async throws -> Data,
            attachmentPlan: @escaping @Sendable (OutgoingMessage, String) async throws -> AttachmentSendPlan,
            spawnRequests: SpawnRequests,
            sleep: @escaping @Sendable (Int) async -> Void = Environment.taskSleep
        ) {
            self.ops = ops
            self.sessionOps = sessionOps
            self.sender = sender
            self.metadataTransport = metadataTransport
            self.refreshSessions = refreshSessions
            self.paintBotFace = paintBotFace
            self.attachmentPlan = attachmentPlan
            self.spawnRequests = spawnRequests
            self.sleep = sleep
        }
    }

    /// Happy Agent may answer `pending` while it creates the session; it is
    /// asked again this many times.
    static let maxPendingResults = 3

    public enum Message {
        public static let worktreeFailed = "Failed to create worktree"
        public static let stillSyncing = "The session was created, but it is still syncing. It should appear shortly."
        public static let startFailed = "Failed to start session"

        /// A bot whose face couldn't be uploaded.
        public static func faceNotUploaded(_ botName: String) -> String {
            "\(botName) is ready, but its picture couldn’t be uploaded. You can try again without creating another bot."
        }

        /// A bot whose face couldn't be painted or put on.
        public static func faceNotSet(_ botName: String) -> String {
            "\(botName) is ready, but its picture couldn't be set. Try again."
        }
    }

    /// Where putting a face on a bot stopped (`BotFaceLeg`). Each leg is
    /// named, since the three do different things and a bare message
    /// doesn't say which was running.
    public struct BotFaceFailure: Error, Equatable, Sendable {
        public enum Leg: String, Sendable {
            case painting = "painting the face"
            case uploading = "uploading the face"
            case wearing = "asking the bot to wear it"
        }

        public var leg: Leg
        public var message: String

        public init(leg: Leg, message: String) {
            self.leg = leg
            self.message = message
        }
    }

    private let environment: Environment
    public weak var presenter: (any SessionStarterPresenter)?
    /// Called whenever `phase` changes.
    public var onPhaseChange: ((NewSessionStartPhase?) -> Void)?

    /// The step running, or nil when nothing is being started.
    public private(set) var phase: NewSessionStartPhase? {
        didSet { if phase != oldValue { onPhaseChange?(phase) } }
    }

    public var isStarting: Bool { phase != nil }

    private var activeRun: Run?

    public init(environment: Environment) {
        self.environment = environment
    }

    /// Stops the attempt in progress and hands the composer back now. A
    /// first message already accepted can't be taken back, so nothing
    /// stops after that.
    public func cancel() {
        guard let run = activeRun, !run.accepted else { return }
        run.cancel()
        // Spent now: a new Start can be pressed before the cancelled flow
        // unwinds, and must not be deduped onto the session being killed.
        environment.spawnRequests.complete()
        activeRun = nil
        phase = nil
    }

    /// Runs one start. Returns the new session's id once it is open with
    /// its first message accepted, or nil when it failed (and said so) or
    /// was stopped. `isCurrentTarget` is false once the composer no longer
    /// asks for this session.
    public func start(_ launch: NewSessionLaunch, isCurrentTarget: @escaping () -> Bool) async -> String? {
        guard activeRun == nil else { return nil }
        let requests = environment.spawnRequests
        let run = Run()
        guard let attempt = requests.registerAttempt({ run.cancel() }) else { return nil }
        defer { requests.removeAttempt(attempt) }
        let clientRequestId = requests.requestId(for: launch.signature)
        activeRun = run
        phase = launch.worktreeSelection == NewSessionDraft.newWorktreeKey ? .worktree : .spawning
        defer {
            // Only while this attempt is still the current one: a newer
            // Start may own the composer by now.
            if activeRun === run {
                activeRun = nil
                phase = nil
            }
        }
        let showPhase = { [weak self] (next: NewSessionStartPhase) in
            guard let self, self.activeRun === run else { return }
            self.phase = next
        }
        let isCurrent = { run.ownsCreatedSession && isCurrentTarget() }

        do {
            let existing = requests.spawnedSessionId(clientRequestId)
            var directory = launch.absolutePath
            if existing == nil, launch.worktreeSelection == NewSessionDraft.newWorktreeKey, launch.target == nil,
               let creator = launch.worktreeCreationMachineId {
                let ops = environment.ops
                let path = launch.absolutePath
                guard let created = await run.race({ await Worktrees.create(ops: ops, machineId: creator, basePath: path) }) else {
                    // The worktree is left wherever git got to; the next
                    // start offers it.
                    return nil
                }
                switch created {
                case .success(let worktree):
                    directory = worktree.path
                case .failure(let failure):
                    presenter?.showStartError(failure.errorDescription ?? Message.worktreeFailed)
                    return nil
                }
                showPhase(.spawning)
            } else if launch.worktreeSelection != NewSessionDraft.noWorktreeKey,
                      launch.worktreeSelection != NewSessionDraft.newWorktreeKey {
                directory = launch.worktreeSelection
            }

            let spawnDirectory = directory
            let spawning = Task { @MainActor () -> String? in
                if let existing { return existing }
                return await self.spawn(launch, directory: spawnDirectory, clientRequestId: clientRequestId, run: run)
            }
            guard let spawned = await run.race({ await spawning.value }) else {
                // The key went with the cancel; put down whatever the
                // machine hands back.
                Task { @MainActor in
                    if let late = await spawning.value { await self.stopAbandoned(late, launch: launch, run: run) }
                }
                return nil
            }
            guard let sessionId = spawned else { return nil }
            // Clean-up holds the starter until it is done: a session nobody
            // waits for is put down even after the composer has gone.
            requests.remember(clientRequestId, sessionId: sessionId, abandon: {
                run.cancel()
                Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
            }, release: {
                run.ownsCreatedSession = false
            })
            showPhase(.opening)

            let sessionOps = environment.sessionOps
            guard let ready = await run.race({ () -> Result<Void, any Error> in
                do {
                    try await sessionOps.ensureSessionReady(sessionId: sessionId)
                    return .success(())
                } catch {
                    return .failure(error)
                }
            }) else {
                Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                return nil
            }
            try ready.get()

            // A session adopted elsewhere is no longer this attempt's.
            if run.canceled || !isCurrent() {
                requests.complete(clientRequestId)
                Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                return nil
            }

            if !launch.isRig {
                // Pinned to this session, so a later change of defaults
                // doesn't rewrite what it was started with.
                let patch = SessionAgentModesPatch(
                    permissionMode: .string(launch.permissionMode),
                    modelMode: .string(launch.modelMode),
                    effortLevel: launch.effortLevel.map(JSONValue.string) ?? .null
                )
                let transport = environment.metadataTransport
                Task { try? await sessionOps.sessionSetAgentModes(sessionId: sessionId, patch: patch, transport: transport) }
            }

            if let bot = launch.bot {
                // The face travels as a session attachment, then the bot is
                // asked to wear it. A face that can't be painted or
                // delivered is no reason to lose the bot just made: it
                // opens without one, and says so.
                showPhase(.avatar)
                let paint = environment.paintBotFace
                guard let worn = await run.race({
                    await Self.wearBotFace(sessionId: sessionId, seed: bot.faceSeed, paint: paint, sessionOps: sessionOps)
                }) else {
                    Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                    return nil
                }
                if let failure = worn {
                    offerBotFaceRetry(sessionId: sessionId, bot: bot, failure: failure)
                }
            }

            if !launch.prompt.isEmpty || !launch.attachments.isEmpty {
                guard isCurrent() else {
                    requests.complete(clientRequestId)
                    Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                    return nil
                }
                let sender = environment.sender
                let message = OutgoingMessage(text: launch.prompt, attachments: launch.attachments, source: .newSession)
                // sync.ts `sendMessage`: pictures the agent can't take are
                // named first; with nothing else to send, nothing goes. A
                // plan that can't be read leaves the send to decide.
                if !launch.attachments.isEmpty {
                    let attachmentPlan = environment.attachmentPlan
                    guard let planned = await run.race({ try? await attachmentPlan(message, sessionId) }) else {
                        Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                        return nil
                    }
                    // The composer may have moved on while the plan was read.
                    guard isCurrent() else {
                        requests.complete(clientRequestId)
                        Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                        return nil
                    }
                    if let plan = planned, plan.shouldShowUnsupportedAlert {
                        presenter?.showAttachmentsNotSupported()
                        if !plan.shouldSendText || (launch.prompt.isEmpty && plan.accepted.isEmpty) {
                            return nil
                        }
                    }
                }
                guard let sent = await run.race({ () -> Result<String, any Error> in
                    do {
                        return .success(try await sender.send(message, sessionId: sessionId))
                    } catch {
                        return .failure(error)
                    }
                }) else {
                    Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                    return nil
                }
                switch sent {
                case .success:
                    run.accepted = true
                case .failure(let error):
                    presenter?.showStartError(Self.describe(error))
                    if !isCurrent() {
                        requests.complete(clientRequestId)
                        Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                    }
                    return nil
                }
            }
            requests.complete(clientRequestId)
            return sessionId
        } catch {
            // A failure the person already walked away from is not news.
            if !run.canceled {
                presenter?.showStartError(Self.describe(error))
            }
            return nil
        }
    }

    /// Asks the machine for the session, polling a `pending` answer and
    /// asking before it creates a missing directory.
    private func spawn(_ launch: NewSessionLaunch, directory: String, clientRequestId: String, run: Run, approved: Bool = false) async -> String? {
        guard !run.canceled, !environment.spawnRequests.isClosed else { return nil }
        let options: SpawnSessionOptions
        if let metadata = launch.rigMetadata {
            do {
                options = try RigSpawnConfiguration(
                    metadata: metadata,
                    directory: directory,
                    clientRequestId: clientRequestId,
                    approvedNewDirectoryCreation: approved,
                    modelKey: launch.modelMode,
                    permissionMode: launch.permissionMode,
                    effort: launch.effortLevel
                ).options(machineId: launch.machineId, target: launch.target)
            } catch {
                if !run.canceled { presenter?.showStartError(Self.describe(error)) }
                return nil
            }
        } else {
            var cli = SpawnSessionOptions(machineId: launch.machineId, directory: directory, agent: launch.agent.rawValue)
            cli.approvedNewDirectoryCreation = approved
            // Codex's Default is a real ask-first policy, not the absence
            // of an override.
            cli.permissionMode = launch.agent == .codex || launch.permissionMode != "default" ? launch.permissionMode : nil
            cli.modelMode = launch.modelMode != "default" ? launch.modelMode : nil
            cli.effortLevel = launch.effortLevel
            options = cli
        }

        var result = await environment.ops.machineSpawnNewSession(options: options)
        var pendingResults = 0
        while case .pending(_, let retryAfterMs) = result, pendingResults < Self.maxPendingResults {
            pendingResults += 1
            let published = RigSessionCreation(metadata: launch.rigMetadata)?.pendingRetryAfterMs
            await environment.sleep(RigSessionCreation.pendingRetryDelayMs(retryAfterMs, published: published))
            if run.canceled { return nil }
            result = await environment.ops.machineSpawnNewSession(options: options)
        }

        switch result {
        case .success(let sessionId):
            // Returned even when nobody waits any more: a session that
            // exists is the caller's to put down.
            return sessionId
        case _ where run.canceled:
            return nil
        case .error(let message):
            presenter?.showStartError(message)
            return nil
        case .pending:
            presenter?.showStartError(Message.stillSyncing)
            return nil
        case .requestToApproveDirectoryCreation(let missing):
            guard let presenter, await presenter.confirmDirectoryCreation(missing) else { return nil }
            return await spawn(launch, directory: directory, clientRequestId: clientRequestId, run: run, approved: true)
        }
    }

    /// Paints the chosen face and puts it on the bot behind a session that
    /// is already open (`wearBotFace`). Reported rather than thrown: the
    /// bot exists by now, and the caller decides what a missing face means.
    nonisolated static func wearBotFace(
        sessionId: String,
        seed: String,
        paint: @Sendable (String) async throws -> Data,
        sessionOps: any HomeSessionOps
    ) async -> BotFaceFailure? {
        let bytes: Data
        do {
            bytes = try await paint(seed)
        } catch {
            return BotFaceFailure(leg: .painting, message: "\(BotFaceFailure.Leg.painting.rawValue): \(describe(error))")
        }
        let uploaded: (ref: String, size: Int)
        do {
            uploaded = try await sessionOps.uploadSessionBlob(sessionId: sessionId, name: "face.png", bytes: bytes)
        } catch {
            return BotFaceFailure(leg: .uploading, message: "\(BotFaceFailure.Leg.uploading.rawValue): \(describe(error))")
        }
        do {
            try await sessionOps.sessionSetAvatar(
                sessionId: sessionId,
                picture: SessionAvatarPicture(ref: uploaded.ref, size: uploaded.size, mimeType: .png)
            )
        } catch {
            return BotFaceFailure(leg: .wearing, message: "\(BotFaceFailure.Leg.wearing.rawValue): \(describe(error))")
        }
        return nil
    }

    /// `offerBotFaceRetry`: says the face didn't take, and tries only the
    /// face again for as long as the person asks. The bot is open by now,
    /// so this outlives the start.
    private func offerBotFaceRetry(sessionId: String, bot: NewSessionLaunch.Bot, failure: BotFaceFailure) {
        Self.offerBotFaceRetry(
            presenter: presenter,
            sessionId: sessionId,
            bot: bot,
            failure: failure,
            paint: environment.paintBotFace,
            sessionOps: environment.sessionOps
        )
    }

    private static func offerBotFaceRetry(
        presenter: (any SessionStarterPresenter)?,
        sessionId: String,
        bot: NewSessionLaunch.Bot,
        failure: BotFaceFailure,
        paint: @escaping @Sendable (String) async throws -> Data,
        sessionOps: any HomeSessionOps
    ) {
        let message = failure.leg == .uploading ? Message.faceNotUploaded(bot.name) : Message.faceNotSet(bot.name)
        Task { @MainActor [weak presenter] in
            guard let presenter, await presenter.offerBotFaceRetry(message) else { return }
            if let next = await wearBotFace(sessionId: sessionId, seed: bot.faceSeed, paint: paint, sessionOps: sessionOps) {
                offerBotFaceRetry(presenter: presenter, sessionId: sessionId, bot: bot, failure: next, paint: paint, sessionOps: sessionOps)
            }
        }
    }

    /// Puts down a session nobody is waiting for any more. Happy Agent's
    /// session is killed through its own RPC, which also retires a bot;
    /// Happy CLI's daemon is asked first, then the session, then the
    /// server's archive, so nothing is left as debris in the list.
    private func stopAbandoned(_ sessionId: String, launch: NewSessionLaunch, run: Run) async {
        guard run.ownsCreatedSession else { return }
        run.ownsCreatedSession = false
        let sessionOps = environment.sessionOps
        if launch.isRig {
            _ = try? await sessionOps.sessionKill(sessionId: sessionId)
        } else {
            let stopped = await environment.ops.machineStopSession(machineId: launch.machineId, sessionId: sessionId)
            if !stopped.success {
                let killed = (try? await sessionOps.sessionKill(sessionId: sessionId))?.success ?? false
                if !killed { try? await sessionOps.archive(sessionId: sessionId) }
            }
        }
        await environment.refreshSessions()
    }

    nonisolated static func describe(_ error: any Error) -> String {
        let message = (error as? LocalizedError)?.errorDescription
        return message?.isEmpty == false ? message! : Message.startFailed
    }

    /// One attempt. Cancelling is per attempt, so one still unwinding can't
    /// touch the state of the attempt that replaced it.
    @MainActor
    final class Run {
        var canceled = false
        /// The first message is in the outbox: there is nothing to stop.
        var accepted = false
        /// Cleared once the session is opened elsewhere or put down.
        var ownsCreatedSession = true
        private var cancelHandlers: [() -> Void] = []

        func cancel() {
            guard !canceled else { return }
            canceled = true
            let handlers = cancelHandlers
            cancelHandlers = []
            for handler in handlers { handler() }
        }

        /// `work`'s result, or nil as soon as the attempt is cancelled;
        /// the work itself runs on regardless.
        func race<T: Sendable>(_ work: @escaping @Sendable () async -> T) async -> T? {
            if canceled { return nil }
            return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
                let once = Once(continuation)
                cancelHandlers.append { once.resume(nil) }
                Task { @MainActor in once.resume(await work()) }
            }
        }
    }

    @MainActor
    final class Once<T: Sendable> {
        private var continuation: CheckedContinuation<T?, Never>?

        init(_ continuation: CheckedContinuation<T?, Never>) {
            self.continuation = continuation
        }

        func resume(_ value: T?) {
            continuation?.resume(returning: value)
            continuation = nil
        }
    }
}
