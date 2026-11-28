#if canImport(UIKit)
import HappyCore
import HappyStore
import UIKit

/// A call's tools and context over a Happy account's sessions, Happy CLI's
/// and Happy Agent's over the relay alike: home's sessions for the
/// directory (`CallTarget.legacyDirectory`), each session's chat from the
/// account's store for what it says (`CallTargetState.legacy`), the
/// composer's chips for its model and effort (`ComposerModes`,
/// `sessionSetAgentModes`), and the relay's own send (`OutboxSender`,
/// source `voice`), which leaves the composer's draft alone. New work is
/// compose's: a bot or a task Happy Agent makes on the computer compose
/// would use (`LegacyNewWork`, `SessionStarter`), its first message the
/// call's.
///
/// New work has no session ID until the computer makes it, so the call
/// knows it by one of its own (`voice-new:…`) from the start, and the
/// session it becomes goes by that ID in the call's directory for the rest
/// of the call.
@MainActor
final class LegacyCallTargets: LiveCallTargets {
    nonisolated var account: CallAccount { .happyCLI }

    /// What the call's tools reach past this phone's memory: the
    /// composer's chips and each chat as the store keeps them, the model
    /// switch, the outbox and compose's start. The account's own, or a
    /// test's.
    struct Relay {
        var picks: @Sendable (_ sessionId: String) async -> ComposerPicks
        var chats: @Sendable (_ sessionId: String) -> AsyncStream<LegacyChatSnapshot>
        var switchModes: @Sendable (_ sessionId: String, _ patch: SessionAgentModesPatch) async throws -> Void
        /// Kept in the outbox, the session judged where it is kept (`refusal`).
        var enqueue: @Sendable (_ text: String, _ sessionId: String) async -> CallSendOutcome
        /// New work started as compose starts it, under its own spawn
        /// requests (never compose's), its first message kept through
        /// `gate`: the session it made.
        var start: @MainActor (_ launch: NewSessionLaunch, _ requests: SpawnRequests, _ gate: VoiceStartGate) async -> Result<String, LegacyNewWork.Refusal>

        static func live(_ session: AccountSession) -> Relay {
            let store = session.store, feed = session.chatFeed, actions = session.actions, realtime = session.realtime, sender = session.sender
            return Relay(
                picks: { sessionId in
                    await Task.detached { ComposerPicks(values: (try? store.composerState(sessionId: sessionId))?.values) }.value
                },
                chats: { feed.snapshots(sessionId: $0) },
                switchModes: { sessionId, patch in
                    try await Task.detached { try await actions.sessionSetAgentModes(sessionId: sessionId, patch: patch, transport: realtime) }.value
                },
                // Off the main thread, and not cancelled once begun: kept on the phone, it went.
                enqueue: { text, sessionId in
                    await Task.detached { () -> CallSendOutcome in
                        do {
                            _ = try await sender.send(OutgoingMessage(text: text, source: .voice), sessionId: sessionId,
                                                      admitting: { record in
                                                          guard let record else { return "No such conversation." }
                                                          return LegacyCallTargets.refusal(record)
                                                      })
                            return .queued
                        } catch let refused as SessionRefusedSend {
                            return .refused(refused.reason)
                        } catch {
                            return .refused("It couldn't be kept on this phone.")
                        }
                    }.value
                },
                start: { launch, requests, gate in
                    let first = VoiceStartSender(gate: gate, base: sender) { message, sessionId, admitting in
                        try await sender.send(message, sessionId: sessionId, admitting: admitting)
                    }
                    let starter = SessionStarter.make(for: session, spawnRequests: requests, sender: first)
                    let told = StartRefusals()
                    starter.presenter = told
                    if let id = await starter.start(launch, isCurrentTarget: { true }) { return .success(id) }
                    return .failure(LegacyNewWork.Refusal(reason: told.message ?? SessionStarter.Message.startFailed))
                }
            )
        }
    }

    private let session: AccountSession
    private let context: AppContext
    private let relay: Relay
    private weak var shell: ShellViewController?
    /// Home as last read: sessions by ID, the directory they make, the
    /// computers and the account's settings.
    private var snapshot: LegacyHomeSnapshot?
    private(set) var records: [String: SessionRecord] = [:]
    private var entries: [CallTarget] = []
    private var loaded = false
    private var reading: Task<Void, Never>?
    private var watchers: [UUID: ([CallTarget]) -> Void] = [:]
    /// The followed sessions' chats, as their feeds last gave them, by the call's ID.
    private var chats: [String: LegacyChatSnapshot] = [:]
    private var feeds: [String: Task<Void, Never>] = [:]
    /// Each session's composer chips as last read, by session ID.
    private var modes: [String: ComposerModes] = [:]
    /// When this phone last read a session from the server during the call.
    private var checked: [String: Double] = [:]
    /// Sends by the call's message ID, under way or queued: the same ID
    /// again, a retry after "uncertain", shares that send and never goes a
    /// second time. A refused one is let go, so a retry tries again.
    private var sends: [String: Task<CallSendOutcome, Never>] = [:]
    /// New work the call started, by the call's ID for it.
    private var started: [String: Started] = [:]
    final class Started {
        let kind: CallTarget.Kind
        let name: String
        let machineId: String
        let models: [CallModel]
        let mode: CallMode?
        /// The start, once its first message went to it: the session it made.
        var making: Task<Result<String, LegacyNewWork.Refusal>, Never>?
        /// Its own spawn requests under the account's, so no other start
        /// takes its session and opening that session adopts it.
        var requests: SpawnRequests?
        /// Its first message against the call's End.
        let gate = VoiceStartGate()
        var sessionId: String?

        init(kind: CallTarget.Kind, name: String, machineId: String, models: [CallModel], mode: CallMode?) {
            self.kind = kind
            self.name = name
            self.machineId = machineId
            self.models = models
            self.mode = mode
        }

        var title: String { name.isEmpty ? (kind == .bot ? "New Bot" : "New Task") : name }
    }
    var onChange: ((CallTargetState) -> Void)?
    private var closed = false

    init(session: AccountSession, context: AppContext, shell: ShellViewController?, relay: Relay? = nil) {
        self.session = session
        self.context = context
        self.relay = relay ?? .live(session)
        self.shell = shell
        let feed = session.homeFeed
        reading = Task.detached { [weak self] in
            for await snapshot in feed.snapshots() {
                // Made off the main thread; only what changed is applied on it.
                let entries = CallTarget.legacyDirectory(snapshot.sessions, projects: snapshot.projects)
                guard let self else { return }
                await self.apply(snapshot, entries: entries)
            }
        }
    }

    func close() {
        closed = true
        reading?.cancel()
        reading = nil
        for feed in feeds.values { feed.cancel() }
        feeds.removeAll()
        for work in started.values { if let requests = work.requests { work.gate.end(closing: requests) } }
        chats.removeAll()
        watchers.removeAll()
        onChange = nil
    }

    private func apply(_ snapshot: LegacyHomeSnapshot, entries: [CallTarget]) {
        guard !closed else { return }
        let before = records
        let listed = self.entries
        self.snapshot = snapshot
        records = Dictionary(snapshot.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        self.entries = entries
        loaded = true
        let now = directoryNow
        if now != listed.map(callTarget) { for watcher in watchers.values { watcher(now) } }
        // A followed session's state is its record's too: thinking, a permission, gone.
        for id in feeds.keys where records[real(id)] != before[real(id)] {
            if let state = followedState(id) { onChange?(state) }
        }
    }

    // MARK: IDs

    /// The session the call's ID names: new work's, once made, else itself.
    private func real(_ id: String) -> String {
        started[id]?.sessionId ?? id
    }

    /// The call's ID for a session: new work's own, for the session it became.
    private func callId(_ sessionId: String) -> String {
        started.first { $0.value.sessionId == sessionId }?.key ?? sessionId
    }

    private func callTarget(_ target: CallTarget) -> CallTarget {
        var target = target
        target.agentId = callId(target.agentId)
        return target
    }

    private var directoryNow: [CallTarget] { entries.map(callTarget) }

    private func target(_ id: String) -> CallTarget? {
        let sessionId = real(id)
        return entries.first { $0.agentId == sessionId }.map(callTarget)
    }

    /// The account's link is live and caught up: what its store holds is the server's.
    private var live: Bool {
        let link = LegacyLink.link(for: session)
        return link.status == .connected && !link.catchingUp
    }

    // MARK: Reading

    func directory() async -> [CallTarget] {
        // Home's first read is on its way at the start of a call.
        for _ in 0..<40 where !loaded && !closed { try? await Task.sleep(for: .milliseconds(25)) }
        return directoryNow
    }

    func state(of agentId: String) async -> CallTargetState? {
        if target(agentId) == nil { return unmadeState(agentId) }
        let sessionId = real(agentId)
        await readModes(sessionId)
        if let state = followedState(agentId) { return state }
        guard var chat = await self.chat(sessionId) else { return nil }
        // Never read on this phone: its first page, as opening it would read it, a few seconds at most.
        if !chat.isLoaded {
            await pull(sessionId, within: .seconds(3))
            chat = await self.chat(sessionId) ?? chat
        }
        guard let record = records[sessionId], let target = target(agentId) else { return nil }
        return .legacy(chat, session: record, target: target, modes: modes[sessionId], current: live, checkedAt: checked[sessionId])
    }

    /// As opening it would: its messages pulled from the server, waiting
    /// up to `limit`; the pull goes on after that, as the screen's would.
    func refreshed(_ agentId: String, within limit: Duration) async -> CallTargetState? {
        if target(agentId) == nil { return unmadeState(agentId) }
        let sessionId = real(agentId)
        await pull(sessionId, within: limit)
        guard !closed, let target = target(agentId) else { return nil }
        let store = session.store
        let record = await Task.detached { try? store.session(id: sessionId) }.value ?? records[sessionId]
        guard let record, let chat = await self.chat(sessionId) else { return nil }
        return .legacy(chat, session: record, target: target, modes: modes[sessionId], current: live, checkedAt: checked[sessionId])
    }

    /// New work not made yet: nothing to read, and it takes its first message.
    private func unmadeState(_ id: String) -> CallTargetState? {
        guard let work = started[id] else { return nil }
        var state = CallTargetState(target: CallTarget(agentId: id, title: work.title, kind: work.kind, status: .idle), fresh: true)
        state.models = work.models
        state.mode = work.mode
        return state
    }

    /// The session's messages from the server, `limit` at most.
    private func pull(_ sessionId: String, within limit: Duration) async {
        let sync = session.sync
        let pulled = Task.detached { await sync.run(.messages(sessionId: sessionId)) }
        if await CallContext.within(limit, pulled) != nil { checked[sessionId] = Date().timeIntervalSince1970 * 1000 }
    }

    /// The composer's chips for a session, as its screen would show them.
    private func readModes(_ sessionId: String) async {
        guard let record = records[sessionId] else { return }
        let overrides = snapshot.map { AccountSettings($0.settings).agentDefaultOverrides } ?? [:]
        let picks = await relay.picks(sessionId)
        modes[sessionId] = ComposerModes(metadata: record.metadata, picks: picks, agentDefaultOverrides: overrides)
    }

    /// What the store holds of a session's chat now: its feed's first snapshot.
    private func chat(_ id: String) async -> LegacyChatSnapshot? {
        let chats = relay.chats
        return await Task.detached {
            for await snapshot in chats(id) { return snapshot }
            return nil
        }.value
    }

    private func followedState(_ id: String) -> CallTargetState? {
        let sessionId = real(id)
        guard let chat = chats[id], let record = records[sessionId], let target = target(id) else { return nil }
        return .legacy(chat, session: record, target: target, modes: modes[sessionId], current: live, checkedAt: checked[sessionId])
    }

    // MARK: Screen

    func focused() async -> String? { focusedNow }

    var focusedNow: String? {
        guard let chat = shell?.topViewController as? LegacyChatViewController, !chat.isComposing,
              records[chat.chatId] != nil else { return nil }
        return callId(chat.chatId)
    }

    func open(_ agentId: String) async -> Bool {
        guard !closed, let shell else { return false }
        if let work = started[agentId] {
            // Nothing sent to it: there is nothing to show. Its first message is making it.
            guard let making = work.making else { return false }
            guard case .success? = await CallContext.within(.seconds(3), making) else { return false }
        }
        guard target(agentId) != nil else { return false }
        if focusedNow == agentId { return true }
        // Past the tool's deadline: nothing moves on screen.
        guard !Task.isCancelled else { return false }
        let chat = LegacyChatViewController(context: context, session: session, sessionId: real(agentId))
        await CallScreens.place(chat, in: shell) { $0 is LegacyChatViewController }
        return true
    }

    func back() async -> CallScreenMove { await CallScreens.back(in: closed ? nil : shell) }

    func home() async -> CallScreenMove { await CallScreens.home(in: closed ? nil : shell) }

    // MARK: Sending

    func send(_ agentId: String, text: String, id: String, change: CallModeChange?) async -> CallSendOutcome {
        guard !closed else { return .refused("The call has ended.") }
        // Under an ID already going or gone: that send's answer.
        while let earlier = sends[id] {
            if await earlier.value == .queued { return .queued }
        }
        // Held before anything waits, so a retry can only share it.
        let sending = Task { @MainActor [weak self] () -> CallSendOutcome in
            guard let self else { return .refused("The call has ended.") }
            let outcome = await self.attempt(agentId, text: text, change: change)
            if outcome != .queued { self.sends[id] = nil }
            return outcome
        }
        sends[id] = sending
        // The tool's deadline reaches the send, as if it ran here.
        return await withTaskCancellationHandler { await sending.value } onCancel: { sending.cancel() }
    }

    private func attempt(_ agentId: String, text: String, change: CallModeChange?) async -> CallSendOutcome {
        if let work = started[agentId], work.sessionId == nil { return await start(work, text: text, change: change) }
        let sessionId = real(agentId)
        guard let record = records[sessionId], target(agentId) != nil else { return .refused("No such conversation.") }
        if let refusal = Self.refusal(record) { return .refused(refusal) }
        // Past the tool's deadline, or the call over: it doesn't go.
        guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
        if let change, let patch = patch(change, for: record) {
            // As the composer's pickers switch it: its composer state, then the session's metadata.
            do {
                try await relay.switchModes(sessionId, patch)
            } catch {
                return .refused("The model couldn't be switched; nothing was sent.")
            }
            // The switch was a wait: the call, the deadline and the session as they are now.
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            guard let now = records[sessionId], target(agentId) != nil else { return .refused("No such conversation.") }
            if let refusal = Self.refusal(now) { return .refused(refusal) }
        }
        return await relay.enqueue(text, sessionId)
    }

    /// Why a session can't take a message now, as its record stands. Like
    /// the composer's send, the link needn't be up: the outbox keeps it and
    /// sends it once it is.
    nonisolated static func refusal(_ record: SessionRecord) -> String? {
        guard record.active, record.decryptable, !record.isArchived else { return "That conversation can't take a message now." }
        guard !(record.hasPendingPermissionRequests || record.hasPendingCommunications) else {
            return "It's waiting for the person in the app; answer there first."
        }
        return nil
    }

    /// `change` as the composer's chips make it (`ComposerModes.patch`).
    private func patch(_ change: CallModeChange, for record: SessionRecord) -> SessionAgentModesPatch? {
        guard let modes = modes[record.id] else { return nil }
        var patch = SessionAgentModesPatch()
        if let key = change.modelId, let model = modes.availableModels.first(where: { $0.key == key }) {
            patch = ComposerModes.patch(selectingModel: model, flavor: record.metadata?["flavor"]?.stringValue, metadata: record.metadata,
                                        sessionEffortLevel: modes.effortLevel?.key)
        }
        if let effort = change.effort { patch.effortLevel = .string(effort) }
        return patch.modelMode == nil && patch.effortLevel == nil ? nil : patch
    }

    // MARK: New work

    func newWorkRefusal(_ kind: CallTarget.Kind?) async -> String? {
        if case .failure(let refusal) = machine(for: kind) { return refusal.reason }
        return nil
    }

    private func machine(for kind: CallTarget.Kind?) -> Result<String, LegacyNewWork.Refusal> {
        let picked = NewSessionDraftStore.shared(for: context.account.localSettings).draft.selectedMachineId
        return LegacyNewWork.machine(for: kind, machines: snapshot?.machines.machines ?? [], picked: picked)
    }

    func draft(_ kind: CallTarget.Kind, name: String) async -> CallTarget? {
        guard !closed, case .success(let machineId) = machine(for: kind) else { return nil }
        let offered = LegacyNewWork.modes(machineId: machineId, machines: snapshot?.machines.machines ?? [])
        let work = Started(kind: kind, name: name, machineId: machineId, models: offered.models, mode: offered.mode)
        let id = "voice-new:" + UUID().uuidString.lowercased()
        started[id] = work
        return CallTarget(agentId: id, title: work.title, kind: kind, status: .idle)
    }

    func discard(_ agentId: String) async {
        guard let work = started[agentId], work.making == nil else { return }
        started[agentId] = nil
    }

    func unlisted(_ agentId: String) async -> CallTarget? {
        guard let work = started[agentId], target(agentId) == nil else { return nil }
        return CallTarget(agentId: agentId, title: work.title, kind: work.kind, status: .idle)
    }

    /// New work as compose starts a bot or a task, `text` its first
    /// message, on the model and effort asked for, else its computer's
    /// default. The start goes on past the tool's deadline: a slow one is
    /// "uncertain" to the agent, and done all the same.
    private func start(_ work: Started, text: String, change: CallModeChange?) async -> CallSendOutcome {
        if work.making == nil {
            guard let snapshot else { return .refused(CallContext.HappyCLI.noNewWork) }
            var draft = NewSessionDraftStore.shared(for: context.account.localSettings).draft
            draft.selectedMachineId = work.machineId
            // Compose's pool: side chats aside, the live and latest first.
            let pool = snapshot.sessions.filter { $0.metadata?["isSideChat"]?.boolValue != true }.sorted {
                if $0.active != $1.active { return $0.active }
                if $0.lastActivityAt != $1.lastActivityAt { return $0.lastActivityAt > $1.lastActivityAt }
                return $0.id < $1.id
            }
            let resolved = NewSessionLaunch.resolve(
                draft: draft, pickedAgent: draft.pickedAgentType, botName: work.kind == .bot ? work.name : nil, createsTask: work.kind == .task,
                machines: snapshot.machines.machines, sessions: pool,
                agentDefaultOverrides: AccountSettings(snapshot.settings).agentDefaultOverrides, prompt: text, attachments: [])
            var launch: NewSessionLaunch
            switch resolved {
            case .success(let value): launch = value
            case .failure(let refusal): return .refused(refusal.errorDescription ?? SessionStarter.Message.startFailed)
            }
            if work.kind == .task, !work.name.isEmpty { launch.target = .task(name: work.name) }
            if let model = change?.modelId ?? work.mode?.modelId {
                launch.modelMode = model
                launch.signature.modelKey = model
            }
            let chosen = work.models.first { $0.id == launch.modelMode }
            let effort = change?.effort ?? (change?.modelId != nil ? chosen?.defaultEffort : work.mode?.effort ?? launch.effortLevel)
            if let effort, !effort.isEmpty {
                launch.effortLevel = effort
                launch.signature.effort = effort
            }
            let ready = launch, start = relay.start, gate = work.gate
            let requests = session.spawnRequests.child(.voiceStart(UUID().uuidString))
            work.requests = requests
            // Not the tool's: a deadline that passes leaves it going. The
            // call's end stops it, unless its first message is kept already.
            work.making = Task { @MainActor in await start(ready, requests, gate) }
        }
        guard let making = work.making else { return .refused(SessionStarter.Message.startFailed) }
        switch await making.value {
        case .success(let sessionId):
            work.sessionId = sessionId
            // The session it made goes by the call's ID for it from now.
            for watcher in watchers.values { watcher(directoryNow) }
            return .queued
        case .failure(let refusal):
            return .refused(refusal.reason)
        }
    }

    /// What a start would have shown the person, kept as the call's answer.
    private final class StartRefusals: SessionStarterPresenter {
        var message: String?
        func showStartError(_ message: String) { self.message = message }
        func confirmDirectoryCreation(_ directory: String) async -> Bool { false }
        func showAttachmentsNotSupported() {}
    }

    // MARK: Following

    var following: [String] { Array(feeds.keys) }

    func follow(_ agentId: String, _ following: Bool) async {
        if following {
            guard !closed, feeds[agentId] == nil, target(agentId) != nil else { return }
            let sessionId = real(agentId)
            let chats = relay.chats
            // Held before anything waits: a second follow finds it, and close or unfollow cancels it.
            feeds[agentId] = Task.detached { [weak self] in
                await self?.readModes(sessionId)
                guard !Task.isCancelled else { return }
                for await snapshot in chats(sessionId) {
                    guard let self else { return }
                    await self.received(snapshot, of: agentId)
                }
            }
        } else if let feed = feeds.removeValue(forKey: agentId) {
            feed.cancel()
            chats[agentId] = nil
        }
    }

    private func received(_ chat: LegacyChatSnapshot, of id: String) {
        guard !closed, feeds[id] != nil else { return }
        chats[id] = chat
        // Gone from home: nothing about it goes, under its old name or any.
        if let state = followedState(id) { onChange?(state) }
    }

    func watchDirectory(_ changed: @escaping ([CallTarget]) -> Void) -> Watch {
        let key = UUID()
        watchers[key] = changed
        return Watch { [weak self] in self?.watchers[key] = nil }
    }
}
#endif
