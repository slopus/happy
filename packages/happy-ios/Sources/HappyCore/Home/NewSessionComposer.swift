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
    public private(set) var snapshot: HomeSnapshot
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

    public convenience init(drafts: NewSessionDraftStore, snapshot: HomeSnapshot, ops: any HomeOps) {
        self.init(drafts: drafts, snapshot: snapshot, ops: ops, deriver: NewSessionChoiceDeriver())
    }

    init(drafts: NewSessionDraftStore, snapshot: HomeSnapshot, ops: any HomeOps, deriver: NewSessionChoiceDeriver) {
        self.drafts = drafts
        self.snapshot = snapshot
        self.ops = ops
        self.deriver = deriver
        // A bounded empty catalog supplies initial labels until the actor
        // derives the account's choices. No account rows are read here.
        choices = NewSessionChoices(.init(draft: drafts.draft, createsBot: drafts.createsBot, machines: [], sessions: []))
        draftObservation = drafts.observe { [weak self] _ in self?.draftChanged() }
        refresh()
    }

    /// The draft the choices were last built from. Names and faces remain
    /// immediate UI changes; they never enter the picker derivation actor.
    private var builtFrom: (draft: NewSessionDraft, createsBot: Bool)?

    private func draftChanged() {
        if let built = builtFrom, built.draft == drafts.draft, built.createsBot == drafts.createsBot, !refreshing {
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

    public func update(snapshot: HomeSnapshot) {
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

    public func selectMachine(_ key: String) {
        drafts.setMachineId(key)
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
    /// and wearing the picked face. A bot takes no first message.
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
    public func isCurrentTarget(_ started: NewSessionDraft, bot: NewSessionBotDraft) -> Bool {
        drafts.draft.sameTarget(as: started) && drafts.bot == bot
    }

    /// Waits for current catalog corrections, then resolves off main from
    /// its cached pool. UI callers keep their target guard across this await.
    public func launchPrepared(prompt: String, attachments: [OutgoingAttachment]) async -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        await waitForIdle()
        return await deriver.launch(snapshot: snapshot, revision: snapshotRevision, draft: drafts.draft,
                                    prompt: prompt, attachments: attachments)
    }

    public func launchBotPrepared() async -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        await waitForIdle()
        return await deriver.launch(snapshot: snapshot, revision: snapshotRevision, draft: drafts.draft,
                                    bot: (name: drafts.botName, faceSeed: drafts.botFaceSeed), prompt: "", attachments: [])
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
        let worktrees = gitWorktrees
        let deriver = self.deriver
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard !Task.isCancelled else { return }
            let next = await deriver.choices(snapshot: snapshot, revision: revision, generation: generation, draft: draft,
                                             createsBot: createsBot, worktrees: worktrees)
            guard !Task.isCancelled, let next, let self, self.refreshGeneration == generation else { return }
            self.canonicalSessions = next.sessions
            if next.revision != self.appliedChoiceRevision {
                self.choices = next.value
                self.appliedChoiceRevision = next.revision
                self.pendingChoiceChange = self.pendingChoiceChange || next.renderedRevision != self.appliedRenderedRevision
                self.appliedRenderedRevision = next.renderedRevision
            }
            self.builtFrom = (draft, createsBot)
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
        // A draft from before the pair was coalesced names the computer
        // under its other daemon's id; a computer that left is replaced by
        // the first one offered.
        if choices.resolvedMachineId != draft.selectedMachineId {
            drafts.renameMachineId(choices.resolvedMachineId)
        }
        if drafts.createsBot && !choices.supportsBots {
            drafts.setCreatesBot(false)
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
