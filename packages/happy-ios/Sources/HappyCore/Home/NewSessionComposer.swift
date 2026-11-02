import Foundation
import HappyStore
import HappyWire

/// The pickers of a session not started yet, as HomeDock.tsx runs them: the
/// account's draft read against the store, the corrections the dock makes
/// when the two disagree, the git worktrees of the chosen directory, and
/// what each picker's choice writes. Home's dock and the new-session screen
/// each hold one; they share the draft.
@MainActor
public final class NewSessionComposer {
    public let drafts: NewSessionDraftStore
    public private(set) var snapshot: LegacyHomeSnapshot
    public private(set) var choices: NewSessionChoices
    /// `git worktree list` for the directory, while it is asked for.
    public private(set) var gitWorktrees: [Worktrees.Entry] = []
    /// Called after the choices are rebuilt.
    public var onChange: (() -> Void)?

    private let ops: any HomeOps
    private let deriver: NewSessionChoiceDeriver
    private var draftObservation: AccountsObservation?
    private var refreshTask: Task<Void, Never>?
    private var refreshGeneration: UInt64 = 0
    private var snapshotRevision: UInt64 = 0
    private var pendingChoiceChange = false
    private var pendingDraftChange = false
    private var appliedChoiceRevision: UInt64?
    private var appliedRenderedRevision: UInt64?
    private var canonicalSessions: [SessionRecord] = []
    private var refreshing = false
    private var needsRefresh = false
    private var worktreeTarget: WorktreeTarget?
    private var worktreeTask: Task<Void, Never>?

    /// Where git worktrees are listed: a Happy CLI machine and a directory.
    struct WorktreeTarget: Equatable {
        var machineId: String
        var path: String
    }

    public convenience init(drafts: NewSessionDraftStore, snapshot: LegacyHomeSnapshot, ops: any HomeOps) {
        self.init(drafts: drafts, snapshot: snapshot, ops: ops, deriver: NewSessionChoiceDeriver())
    }

    init(drafts: NewSessionDraftStore, snapshot: LegacyHomeSnapshot, ops: any HomeOps, deriver: NewSessionChoiceDeriver) {
        self.drafts = drafts
        self.snapshot = snapshot
        self.ops = ops
        self.deriver = deriver
        // A bounded empty catalog supplies initial labels until the actor
        // derives the account's choices. No account rows are read here.
        choices = NewSessionChoices(.init(draft: drafts.draft, createsBot: drafts.createsBot, createsTask: drafts.createsTask, machines: [], sessions: [],
                                          machinesSynced: snapshot.machines.synced))
        draftObservation = drafts.observe { [weak self] _ in self?.draftChanged() }
        refresh()
    }

    /// The draft the choices were last built from. Names and faces remain
    /// immediate UI changes; they never enter the picker derivation actor.
    private var builtFrom: (draft: NewSessionDraft, createsBot: Bool, createsTask: Bool)?

    private func draftChanged() {
        if let built = builtFrom, built.draft == drafts.draft, built.createsBot == drafts.createsBot, built.createsTask == drafts.createsTask, !refreshing {
            onChange?()
            return
        }
        pendingDraftChange = true
        refresh()
    }

    deinit {
        refreshTask?.cancel()
        worktreeTask?.cancel()
    }

    public func update(snapshot: LegacyHomeSnapshot) {
        self.snapshot = snapshot
        snapshotRevision &+= 1
        refresh()
    }

    /// A drain seam for callers which must inspect settled draft corrections.
    /// Interactive screens receive the same result through onChange.
    func waitForIdle() async {
        while let task = refreshTask {
            let generation = refreshGeneration
            await task.value
            if generation == refreshGeneration { return }
        }
    }

    /// The worktree picker is opening: list again, as `useWorktrees`'
    /// `refresh` does, since git may have moved on.
    public func refreshWorktrees() {
        guard let target = worktreeTarget else { return }
        fetchWorktrees(target)
    }

    // MARK: Picks

    /// A computer picked. One that can't make the bot or task being made
    /// was picked for a session: the kind goes back to Session. One that
    /// can stays picked while its Happy Agent is offline.
    public func selectMachine(_ key: String) {
        drafts.pickedMachineId = key
        let kind = self.kind
        if kind != .session, let target = choices.machines.first(where: { $0.id == key }), !target.makes(kind) {
            drafts.setCreatesBot(false)
            drafts.setCreatesTask(false)
        }
        drafts.setMachineId(key)
    }

    /// What the first send makes, as the draft says.
    public var kind: HomeDockKind {
        HomeDockKind.current(createsBot: drafts.createsBot, createsTask: drafts.createsTask)
    }

    /// A project row. A catalog project is named by identity, and only
    /// Happy Agent can open it, so the harness moves there.
    /// `NewSessionChoices.customPathKey` is not a place: ask for one and
    /// pass it to `selectCustomPath`.
    public func selectProject(_ key: String) {
        guard key != NewSessionChoices.customPathKey else { return }
        if let projectId = SessionPlaces.projectId(from: key) {
            drafts.setProjectId(projectId)
            selectAgent(.rig, picked: true)
            return
        }
        drafts.setPath(key)
    }

    /// "Enter custom path" answered (`resolveCustomProjectPathSelection`):
    /// a blank answer changes nothing.
    public func selectCustomPath(_ path: String?) {
        guard let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return }
        drafts.setPath(trimmed)
    }

    public func selectWorktree(_ key: String) {
        drafts.selectWorktree(key)
    }

    /// The harness picker.
    public func selectAgent(_ key: String) {
        guard let agent = NewSessionDraft.Agent(rawValue: key) else { return }
        selectAgent(agent, picked: true)
    }

    // MARK: The new-session screen's picks

    /// new/index.tsx's harness picker: the harness alone. The modes stay
    /// as picked, read against the new harness's list.
    public func pickAgent(_ key: String) {
        guard let agent = NewSessionDraft.Agent(rawValue: key), choices.agentOptions.contains(where: { $0.key == key }) else { return }
        drafts.pickAgentType(agent)
    }

    /// new/index.tsx `selectProjectPlace`: a catalog project, and Happy
    /// Agent, the only harness that can find it, when this computer runs it.
    public func pickProject(_ projectId: String) {
        drafts.setProjectId(projectId)
        if choices.agentOptions.contains(where: { $0.key == NewSessionDraft.Agent.rig.rawValue }) {
            drafts.pickAgentType(.rig)
        }
    }

    /// The path field, as typed: every keystroke is the place.
    public func typePath(_ path: String) {
        drafts.setPath(path)
    }

    public func selectPermission(_ key: String) {
        drafts.setPermissionMode(key)
    }

    public func selectModel(_ key: String) {
        drafts.setModelMode(key)
    }

    public func selectEffort(_ key: String) {
        drafts.setEffortLevel(key)
    }

    /// What the first send makes. A bot or a task is Happy Agent's
    /// (`NewSessionLaunch.resolve`), made on a computer whose Happy Agent
    /// advertises it, so picking one goes to such a computer
    /// (`NewSessionChoices.preferredMachine`): the one chosen if it can and
    /// answers, else one that answers. The harness moves to Happy Agent, as
    /// a catalog project moves it: the model, permission and effort pickers
    /// then offer Happy Agent's own, and what they pick is what the spawn
    /// asks for. Back to Session, the computer and the harness stay until
    /// others are picked.
    public func selectKind(_ kind: HomeDockKind) {
        // Picking the kind routes it by the rule, past a computer picked
        // before.
        drafts.pickedMachineId = nil
        guard kind != .session else {
            drafts.setCreatesBot(false)
            drafts.setCreatesTask(false)
            return
        }
        guard let target = choices.preferredMachine(for: kind) else {
            // The computers are still arriving: it is a bot or a task now,
            // and goes to a Happy Agent that makes it once one is in
            // (`reconcile`).
            guard !choices.machinesSynced else { return }
            if kind == .bot { drafts.setCreatesBot(true) } else { drafts.setCreatesTask(true) }
            return
        }
        let moves = target.id != choices.currentTarget?.id
        if moves { drafts.setMachineId(target.id) }
        if kind == .bot { drafts.setCreatesBot(true) } else { drafts.setCreatesTask(true) }
        // Already Happy Agent's, the picks stay; the pickers read them
        // against the Happy Agent it goes to.
        guard drafts.draft.agentType != .rig else { return }
        // Read on the computer it goes to: these choices are another's.
        if let defaults = moves ? target.happyAgentDefaults : choices.defaults(for: .rig) {
            drafts.selectAgent(.rig, picked: true, defaults: defaults)
        }
    }

    /// HomeDock.tsx `selectAgent`: the harness and the modes it starts on.
    /// `picked` is the person choosing it; the corrections below only
    /// follow what the computer can run and never set a pick.
    private func selectAgent(_ agent: NewSessionDraft.Agent, picked: Bool) {
        drafts.selectAgent(agent, picked: picked, defaults: choices.defaults(for: agent))
    }

    // MARK: Start

    /// The draft resolved for a start, with the composer's text.
    public func launch(prompt: String, attachments: [OutgoingAttachment]) -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        NewSessionLaunch.resolve(
            draft: drafts.draft,
            pickedAgent: drafts.draft.pickedAgentType,
            machines: snapshot.machines.machines,
            sessions: canonicalSessions,
            agentDefaultOverrides: AccountSettings(snapshot.settings).agentDefaultOverrides,
            prompt: prompt,
            attachments: attachments
        )
    }

    /// The bot the draft names: Happy Agent on the chosen computer, named
    /// and wearing the picked face, with no first message.
    public func launchBot() -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        NewSessionLaunch.resolve(
            draft: drafts.draft,
            pickedAgent: drafts.draft.pickedAgentType,
            bot: (name: drafts.botName, faceSeed: drafts.botFaceSeed),
            machines: snapshot.machines.machines,
            sessions: canonicalSessions,
            agentDefaultOverrides: AccountSettings(snapshot.settings).agentDefaultOverrides,
            prompt: "",
            attachments: []
        )
    }

    /// Whether the composer still asks for the session a start began with
    /// (`isCurrentTarget`): false once any of its pickers moved, or the bot
    /// it makes changed.
    /// `createsTask` is what the start made; nil for a screen that makes no
    /// tasks, which a task picked in the dock never stops.
    public func isCurrentTarget(_ started: NewSessionDraft, bot: NewSessionBotDraft, createsTask: Bool? = nil) -> Bool {
        drafts.draft.sameTarget(as: started) && drafts.bot == bot && (createsTask.map { $0 == drafts.createsTask } ?? true)
    }

    /// Waits for current catalog corrections, then resolves off main from
    /// its cached pool. UI callers keep their target guard across this await.
    public func launchPrepared(prompt: String, attachments: [OutgoingAttachment]) async -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        await waitForIdle()
        return await deriver.launch(snapshot: snapshot, revision: snapshotRevision, draft: drafts.draft,
                                    prompt: prompt, attachments: attachments)
    }

    /// A task on the chosen computer, with the composer's text as its first
    /// message: the daemon names the task from it.
    public func launchTaskPrepared(prompt: String, attachments: [OutgoingAttachment]) async -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        await waitForIdle()
        return await deriver.launch(snapshot: snapshot, revision: snapshotRevision, draft: drafts.draft,
                                    createsTask: true, prompt: prompt, attachments: attachments)
    }

    /// The bot the draft names; `prompt` and `attachments`, when given, are
    /// its first message, sent once it wears its face.
    public func launchBotPrepared(prompt: String = "", attachments: [OutgoingAttachment] = []) async -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        await waitForIdle()
        return await deriver.launch(snapshot: snapshot, revision: snapshotRevision, draft: drafts.draft,
                                    bot: (name: drafts.botName, faceSeed: drafts.botFaceSeed), prompt: prompt, attachments: attachments)
    }

    // MARK: Refresh

    /// Rebuilds the choices and makes the dock's corrections; a correction
    /// changes the draft, which rebuilds again until nothing moves.
    private func refresh(pass: Int = 0) {
        guard !refreshing else { needsRefresh = true; return }
        refreshGeneration &+= 1
        let generation = refreshGeneration
        let snapshot = self.snapshot
        let revision = snapshotRevision
        let draft = drafts.draft
        let createsBot = drafts.createsBot
        let createsTask = drafts.createsTask
        let worktrees = gitWorktrees
        let deriver = self.deriver
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard !Task.isCancelled else { return }
            let next = await deriver.choices(snapshot: snapshot, revision: revision, generation: generation, draft: draft,
                                             createsBot: createsBot, createsTask: createsTask, worktrees: worktrees)
            guard !Task.isCancelled, let next, let self, self.refreshGeneration == generation else { return }
            self.canonicalSessions = next.sessions
            if next.revision != self.appliedChoiceRevision {
                self.choices = next.value
                self.appliedChoiceRevision = next.revision
                self.pendingChoiceChange = self.pendingChoiceChange || next.renderedRevision != self.appliedRenderedRevision
                self.appliedRenderedRevision = next.renderedRevision
            }
            self.builtFrom = (draft, createsBot, createsTask)
            self.refreshing = true
            self.needsRefresh = false
            self.reconcile()
            self.refreshing = false
            // Preserve the dock's four-pass correction bound. Notifications
            // during reconciliation coalesce into one follow-up derivation.
            if self.needsRefresh && pass < 3 {
                self.refresh(pass: pass + 1)
                return
            }
            guard self.refreshGeneration == generation else { return }
            self.updateWorktreeTarget()
            guard self.refreshGeneration == generation else { return }
            if self.pendingChoiceChange || self.pendingDraftChange {
                self.pendingChoiceChange = false
                self.pendingDraftChange = false
                self.onChange?()
            }
        }
    }

    /// HomeDock.tsx's effects that keep the draft in step with the store.
    private func reconcile() {
        // The screen can precede its first disk value. An unknown empty
        // catalog cannot establish that a persisted target disappeared.
        guard snapshot.machines.synced || !snapshot.machines.machines.isEmpty else { return }
        let draft = drafts.draft
        let kind = self.kind
        let current = choices.currentTarget
        if kind != .session, current?.makes(kind) != true {
            // A bot or a task whose computer can't make it (it left, or its
            // Happy Agent stopped offering it, or hasn't arrived) goes to one
            // that can; it waits while the list is still arriving, and only
            // with none on the whole account does it become a session.
            if let target = choices.preferredMachine(for: kind) {
                drafts.setMachineId(target.id)
            } else if snapshot.machines.synced {
                drafts.setCreatesBot(false)
                drafts.setCreatesTask(false)
            }
        } else if kind != .session, let current, !current.isOnline(for: kind), current.id != drafts.pickedMachineId,
                  let target = choices.preferredMachine(for: kind), target.id != current.id {
            // One that can, but whose Happy Agent doesn't answer (kept from
            // an earlier compose, or every one looked offline when the kind
            // was picked) goes to one that answers once there is one, as
            // picking the kind does; never past one the person picked.
            drafts.setMachineId(target.id)
        } else if choices.resolvedMachineId != draft.selectedMachineId {
            // A draft from before the pair was coalesced names the computer
            // under its other daemon's id, and keeps its place; a computer
            // that left is replaced by the first one offered, whose folders
            // are its own, so the left one's place goes with it.
            if choices.offersDraftMachine {
                drafts.renameMachineId(choices.resolvedMachineId)
            } else {
                drafts.setMachineId(choices.resolvedMachineId)
            }
        }
        if !choices.supportsWorktree && !choices.picksWorkspaces && draft.sessionType == .worktree {
            drafts.setSessionType(.simple)
            drafts.setWorktreeKey(nil)
        }
        if choices.resolvedAgent != draft.agentType {
            selectAgent(choices.resolvedAgent, picked: false)
        }
    }

    private func updateWorktreeTarget() {
        let target = choices.listsGitWorktrees
            ? choices.gitWorktreeMachineId.map { WorktreeTarget(machineId: $0, path: choices.resolvedPath) }
            : nil
        guard target != worktreeTarget else { return }
        worktreeTarget = target
        worktreeTask?.cancel()
        if let target {
            fetchWorktrees(target)
        } else if !gitWorktrees.isEmpty {
            gitWorktrees = []
            refresh()
        }
    }

    private func fetchWorktrees(_ target: WorktreeTarget) {
        worktreeTask?.cancel()
        let ops = ops
        worktreeTask = Task { [weak self] in
            let entries = await Worktrees.list(ops: ops, machineId: target.machineId, basePath: target.path)
            // RPCs can't be aborted; only the current target's reply lands.
            guard !Task.isCancelled, let self, self.worktreeTarget == target else { return }
            guard entries != self.gitWorktrees else { return }
            self.gitWorktrees = entries
            self.refresh()
        }
    }
}

extension NewSessionDraft {
    /// `isCurrentTarget`'s comparison: the fields that say which session a
    /// start makes.
    public func sameTarget(as other: NewSessionDraft) -> Bool {
        selectedMachineId == other.selectedMachineId
            && selectedPath == other.selectedPath
            && agentType == other.agentType
            && permissionMode == other.permissionMode
            && modelMode == other.modelMode
            && effortLevel == other.effortLevel
            && sessionType == other.sessionType
            && worktreeKey == other.worktreeKey
    }
}
