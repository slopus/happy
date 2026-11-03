package com.slopus.happy.ui.home

import com.slopus.happy.model.BotDraft
import com.slopus.happy.model.rollBotFaceSeeds
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.ComposeKind
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.Settings
import com.slopus.happy.model.WorktreeListing
import com.slopus.happy.model.WorktreePaths
import com.slopus.happy.model.WorktreeSelection
import com.slopus.happy.model.WorktreeTarget
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.collectSessionPlaces
import com.slopus.happy.model.findMachineChoice
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.model.resolveNewSessionOptions
import com.slopus.happy.model.selectingAgent
import com.slopus.happy.model.selectingProject
import com.slopus.happy.model.selectingWorktree
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The new-session composer's state behind the home dock and the
 * new-session screen: the stored draft, what it resolves to on the
 * computers as they are now (derived off the main thread), the git
 * worktrees of the draft's directory, and the [starter] that turns it
 * into a session.
 */
class NewSessionServices(
    private val drafts: NewSessionDraftStore,
    private val snapshots: StateFlow<HomeSnapshot?>,
    private val settings: StateFlow<Settings>,
    private val machineActions: MachineActions,
    val starter: SessionStarter,
    private val labels: NewSessionLabels,
    private val translate: (Int) -> String,
    private val scope: CoroutineScope,
    compute: CoroutineDispatcher = Dispatchers.Default,
) {
    private class Resolved(val draft: NewSessionDraft, val options: NewSessionOptions)

    private val listing = MutableStateFlow<WorktreeListing?>(null)
    private val worktreeRequests = MutableStateFlow(0)

    val draft: StateFlow<NewSessionDraft> = drafts.draft

    private val botState = MutableStateFlow(BotDraft(seeds = rollBotFaceSeeds()))

    /** useNewSessionDraft's bot fields, in memory: a restarted app offers a session. */
    val bot: StateFlow<BotDraft> = botState.asStateFlow()

    private val creatingTask = MutableStateFlow(false)

    /** What the first send makes: a session, or a bot or task Happy Agent makes (in memory, as [bot]). */
    val kind: StateFlow<ComposeKind> = combine(botState, creatingTask) { bot, task ->
        when {
            bot.creating -> ComposeKind.Bot
            task -> ComposeKind.Task
            else -> ComposeKind.Session
        }
    }.stateIn(scope, SharingStarted.Eagerly, ComposeKind.Session)

    /**
     * The computer the person picked in the compose chat's menu, which a bot
     * or task is never moved off (happy-ios 9e58785b4). Picking a kind or a
     * new compose forgets it.
     */
    @Volatile
    var pickedMachineId: String? = null

    private val resolved: StateFlow<Resolved?> = combine(drafts.draft, snapshots, settings, listing, kind) { draft, snapshot, settings, worktrees, kind ->
        snapshot?.let {
            Resolved(
                draft,
                resolveNewSessionOptions(
                    draft,
                    it.machines,
                    it.sessions,
                    settings.agentDefaultOverrides,
                    worktrees,
                    labels,
                    translate,
                    projectName = { id -> it.projects[id]?.name },
                    kind = kind,
                    machinesSynced = it.machinesSynced,
                ),
            )
        }
    }.flowOn(compute).stateIn(scope, SharingStarted.Eagerly, null)

    val options: StateFlow<NewSessionOptions?> = resolved
        .map { it?.options }
        .stateIn(scope, SharingStarted.Eagerly, null)

    init {
        // HomeDock.tsx's effects: the draft follows the computer it names. Only
        // a resolution of the draft as it still is may rewrite it.
        scope.launch {
            resolved.filterNotNull().collect { current ->
                val snapshot = snapshots.value ?: return@collect
                if (routeKind(current.options, snapshot)) return@collect
                drafts.change { draft -> if (draft == current.draft) current.options.reconcile(draft, snapshot.machines, settings.value.agentDefaultOverrides) else draft }
            }
        }
        // useWorktrees: git is asked when the target changes or a picker opens, never on store updates.
        scope.launch {
            combine(options.map { it?.worktreeTarget }.distinctUntilChanged(), worktreeRequests) { target, _ -> target }
                .collectLatest { target -> listing.value = target?.let { list(it) } }
        }
    }

    private suspend fun list(target: WorktreeTarget) = WorktreeListing(target, machineActions.listWorktrees(target.machineId, target.basePath))

    /** A picker is opening: the worktree one lists git's worktrees again. */
    fun onOpenPicker(page: NewSessionPage) {
        if (page == NewSessionPage.Worktree) worktreeRequests.value++
    }

    /**
     * happy-ios NewSessionComposer.reconcile's kind half: a bot or task whose
     * computer can't make it goes to one that can (it waits while the list is
     * arriving; with none on the whole account it becomes a session), and one
     * whose Happy Agent doesn't answer goes to one that does, unless the
     * person picked it. True when it moved the draft or the kind, whose
     * change comes back here.
     */
    private fun routeKind(options: NewSessionOptions, snapshot: HomeSnapshot): Boolean {
        val kind = options.kind
        if (kind == ComposeKind.Session) return false
        // An unknown empty list can't say a kept computer is gone.
        if (!snapshot.machinesSynced && snapshot.machines.isEmpty()) return false
        val current = options.currentTarget
        val target = options.preferredTarget(kind)
        if (current?.makes(kind) != true) {
            if (target != null) return moveTo(target.id)
            if (snapshot.machinesSynced) {
                setKind(ComposeKind.Session)
                return true
            }
            return false
        }
        if (!current.isOnline(kind) && current.id != pickedMachineId && target != null && target.id != current.id) return moveTo(target.id)
        return false
    }

    private fun moveTo(machineId: String): Boolean {
        if (drafts.draft.value.selectedMachineId == machineId) return false
        drafts.change { it.withMachine(machineId) }
        return true
    }

    /**
     * happy-ios NewSessionComposer.selectKind: a bot or a task goes to a
     * computer whose Happy Agent makes it and answers, keeping the chosen
     * one when it can, and its harness becomes Happy Agent, as picked. While
     * the computers are still arriving it waits for one that can.
     */
    fun setKind(kind: ComposeKind) {
        pickedMachineId = null
        botState.update { it.copy(creating = kind == ComposeKind.Bot) }
        creatingTask.value = kind == ComposeKind.Task
        if (kind == ComposeKind.Session) return
        val snapshot = snapshots.value ?: return
        val options = resolveNewSessionOptions(
            drafts.draft.value, snapshot.machines, snapshot.sessions, settings.value.agentDefaultOverrides,
            kind = kind, machinesSynced = snapshot.machinesSynced,
        )
        val target = options.preferredTarget(kind) ?: return
        val overrides = settings.value.agentDefaultOverrides
        drafts.change { draft ->
            val placed = if (target.id != options.currentTarget?.id) draft.withMachine(target.id) else draft
            // Already Happy Agent's, the picks stay; the pickers read them against the one it goes to.
            if (placed.agentType == AgentType.Rig) placed else placed.selectingAgent(AgentType.Rig, picked = true, snapshot.machines, overrides)
        }
    }

    /** The compose chat's computer menu: a pick the routing keeps; one that can't make the kind makes a session. */
    fun selectMachine(machineId: String) {
        val kind = kind.value
        if (kind != ComposeKind.Session && options.value?.targets?.find { it.id == machineId }?.makes(kind) == false) setKind(ComposeKind.Session)
        pickedMachineId = machineId
        drafts.change { it.withMachine(machineId) }
    }

    /** A new compose: the routing may move a kept bot or task again. */
    fun forgetPickedMachine() {
        pickedMachineId = null
    }

    /** A pick from one of the composer's pickers. */
    fun select(page: NewSessionPage, key: String) {
        val machines = snapshots.value?.machines.orEmpty()
        val overrides = settings.value.agentDefaultOverrides
        drafts.change { draft ->
            when (page) {
                NewSessionPage.Machine -> draft.withMachine(key)
                NewSessionPage.Project -> draft.selectingProject(key, machines, overrides)
                NewSessionPage.Worktree -> draft.selectingWorktree(key)
                NewSessionPage.Agent -> AgentType.fromWire(key)?.let { draft.selectingAgent(it, picked = true, machines, overrides) } ?: draft
                NewSessionPage.Model -> draft.copy(modelMode = key)
                NewSessionPage.Permission -> draft.copy(permissionMode = key)
                NewSessionPage.Effort -> draft.copy(effortLevel = key)
            }
        }
    }

    /** A custom directory typed in by hand. */
    fun selectPath(path: String) = drafts.change { it.withPath(path) }

    /**
     * LegacyComposeStart's followMachine: a computer with no folder picked
     * (another was just chosen, or nothing ever was) starts in its most
     * recent folder, so the folders follow the computer. With none known
     * yet nothing is written, and the start goes home (`~`): a computer
     * whose chats are still arriving takes its most recent folder once they
     * are in, instead of being held at home by an early answer.
     */
    fun followMachine() {
        val snapshot = snapshots.value ?: return
        drafts.change { draft ->
            if (draft.selectedPath != null || draft.selectedProjectId != null) return@change draft
            val choice = findMachineChoice(collectMachineChoices(snapshot.machines), draft.selectedMachineId) ?: return@change draft
            val recent = collectSessionPlaces(choice.machineIds, snapshot.sessions).firstOrNull { it.projectId == null && it.path != null }
            recent?.path?.let(draft::withPath) ?: draft
        }
    }

    /** ProjectHomeList's "+": the dock opens on a new workspace (or worktree) of that project. */
    fun prepareWorkspace(machineId: String, projectId: String?, path: String?) {
        drafts.change { draft ->
            val placed = draft.withMachine(machineId).let { onMachine ->
                when {
                    // A Happy Agent project is a catalog identity: a worktree's directory says nothing of it.
                    projectId != null -> onMachine.pickAgent(AgentType.Rig).withProject(projectId)
                    path != null -> onMachine.withPath(path)
                    else -> onMachine
                }
            }
            placed.selectingWorktree(WorktreeSelection.NEW)
        }
    }

    /**
     * ProjectGroup's "+" (the tablet sidebar grouped by project): the draft
     * points at that exact checkout, a worktree by its own path, the rest by
     * the repo's path from home. The machine goes first, as it clears the place.
     */
    fun prepareCheckout(machineId: String?, path: String?, homeDir: String?) {
        val sessionPath = path.orEmpty()
        val worktree = WorktreePaths.isWorktree(sessionPath)
        val repoPath = if (worktree) WorktreePaths.repoPath(sessionPath) else sessionPath
        drafts.change { draft ->
            var next = if (machineId != null) draft.withMachine(machineId) else draft
            if (repoPath.isNotEmpty()) next = next.withPath(formatPathRelativeToHome(repoPath, homeDir))
            next.selectingWorktree(if (worktree) sessionPath else WorktreeSelection.NONE)
        }
    }

    /** Logout (clearPersistence): the draft, its bot fields included, starts over. */
    fun resetDraft() {
        drafts.reset()
        botState.value = BotDraft(seeds = rollBotFaceSeeds())
        creatingTask.value = false
        pickedMachineId = null
    }

    /** The dock's text becomes the draft's at Send (MainView handleHomePromptSubmit). */
    fun setInput(text: String) = drafts.change { it.copy(input = text) }

    fun setCreatesBot(creating: Boolean) = setKind(if (creating) ComposeKind.Bot else ComposeKind.Session)

    /** A task was made: the next compose offers a session. */
    fun taskCreated() {
        creatingTask.value = false
    }

    fun setBotName(name: String) = botState.update { it.copy(name = name) }

    fun pickBotFace(slot: Int) = botState.update { if (slot in it.seeds.indices) it.copy(slot = slot) else it }

    fun rollBotFaces() = botState.update { it.copy(seeds = rollBotFaceSeeds()) }

    /** A bot was made from [made]: the next starts from a clean name and fresh faces, and offers a session. */
    fun botCreated(made: BotDraft) = botState.update { current ->
        BotDraft(name = if (current.name == made.name) "" else current.name, seeds = rollBotFaceSeeds())
    }
}
