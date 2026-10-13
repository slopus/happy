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
    private var draftObservation: AccountsObservation?
    private var refreshing = false
    private var needsRefresh = false
    private var worktreeTarget: WorktreeTarget?
    private var worktreeTask: Task<Void, Never>?

    /// Where git worktrees are listed: a Happy CLI machine and a directory.
    struct WorktreeTarget: Equatable {
        var machineId: String
        var path: String
    }

    public init(drafts: NewSessionDraftStore, snapshot: HomeSnapshot, ops: any HomeOps) {
        self.drafts = drafts
        self.snapshot = snapshot
        self.ops = ops
        choices = NewSessionChoices(.init(draft: drafts.draft, createsBot: drafts.createsBot, snapshot: snapshot))
        draftObservation = drafts.observe { [weak self] _ in self?.draftChanged() }
        refresh()
    }

    /// The draft the choices were last built from.
    private var builtFrom: (draft: NewSessionDraft, createsBot: Bool)?

    /// A bot's name and faces move no picker: what shows them is told, and
    /// the choices stay as they are.
    private func draftChanged() {
        if let built = builtFrom, built.draft == drafts.draft, built.createsBot == drafts.createsBot, !refreshing {
            onChange?()
            return
        }
        refresh()
    }

    deinit {
        worktreeTask?.cancel()
    }

    public func update(snapshot: HomeSnapshot) {
        guard snapshot != self.snapshot else { return }
        self.snapshot = snapshot
        refresh()
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
            sessions: snapshot.sessions,
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
            sessions: snapshot.sessions,
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

    // MARK: Refresh

    /// Rebuilds the choices and makes the dock's corrections; a correction
    /// changes the draft, which rebuilds again until nothing moves.
    private func refresh() {
        guard !refreshing else {
            needsRefresh = true
            return
        }
        refreshing = true
        var passes = 0
        repeat {
            needsRefresh = false
            choices = NewSessionChoices(.init(
                draft: drafts.draft,
                createsBot: drafts.createsBot,
                snapshot: snapshot,
                gitWorktrees: gitWorktrees
            ))
            builtFrom = (drafts.draft, drafts.createsBot)
            reconcile()
            passes += 1
        } while needsRefresh && passes < 4
        refreshing = false
        updateWorktreeTarget()
        onChange?()
    }

    /// HomeDock.tsx's effects that keep the draft in step with the store.
    private func reconcile() {
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
