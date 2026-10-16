package com.slopus.happy.ui.home

import com.slopus.happy.model.BotDraft
import com.slopus.happy.model.rollBotFaceSeeds
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.Settings
import com.slopus.happy.model.WorktreeListing
import com.slopus.happy.model.WorktreePaths
import com.slopus.happy.model.WorktreeSelection
import com.slopus.happy.model.WorktreeTarget
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

    private val resolved: StateFlow<Resolved?> = combine(drafts.draft, snapshots, settings, listing) { draft, snapshot, settings, worktrees ->
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
                val machines = snapshots.value?.machines ?: return@collect
                drafts.change { draft -> if (draft == current.draft) current.options.reconcile(draft, machines, settings.value.agentDefaultOverrides) else draft }
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
    }

    /** The dock's text becomes the draft's at Send (MainView handleHomePromptSubmit). */
    fun setInput(text: String) = drafts.change { it.copy(input = text) }

    private val botState = MutableStateFlow(BotDraft(seeds = rollBotFaceSeeds()))

    /** useNewSessionDraft's bot fields, in memory: a restarted app offers a session. */
    val bot: StateFlow<BotDraft> = botState.asStateFlow()

    fun setCreatesBot(creating: Boolean) = botState.update { it.copy(creating = creating) }

    fun setBotName(name: String) = botState.update { it.copy(name = name) }

    fun pickBotFace(slot: Int) = botState.update { if (slot in it.seeds.indices) it.copy(slot = slot) else it }

    fun rollBotFaces() = botState.update { it.copy(seeds = rollBotFaceSeeds()) }

    /** A bot was made from [made]: the next starts from a clean name and fresh faces, and offers a session. */
    fun botCreated(made: BotDraft) = botState.update { current ->
        BotDraft(name = if (current.name == made.name) "" else current.name, seeds = rollBotFaceSeeds())
    }
}
