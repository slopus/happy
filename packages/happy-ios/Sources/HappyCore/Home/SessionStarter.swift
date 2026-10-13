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
        signature: SpawnRequests.Signature
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
        public var spawnRequests: SpawnRequests
        public var sleep: @Sendable (Int) async -> Void

        @MainActor
        public init(
            ops: any HomeOps,
            sessionOps: any HomeSessionOps,
            sender: any ChatSending,
            metadataTransport: any MetadataUpdateTransport,
            refreshSessions: @escaping @Sendable () async -> Void,
            spawnRequests: SpawnRequests = .shared,
            sleep: @escaping @Sendable (Int) async -> Void = { ms in try? await Task.sleep(for: .milliseconds(ms)) }
        ) {
            self.ops = ops
            self.sessionOps = sessionOps
            self.sender = sender
            self.metadataTransport = metadataTransport
            self.refreshSessions = refreshSessions
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
        let clientRequestId = requests.requestId(for: launch.signature)
        let run = Run()
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

            if !launch.prompt.isEmpty || !launch.attachments.isEmpty {
                guard isCurrent() else {
                    requests.complete(clientRequestId)
                    Task { @MainActor in await self.stopAbandoned(sessionId, launch: launch, run: run) }
                    return nil
                }
                let sender = environment.sender
                let message = OutgoingMessage(text: launch.prompt, attachments: launch.attachments, source: .newSession)
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

    static func describe(_ error: any Error) -> String {
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
