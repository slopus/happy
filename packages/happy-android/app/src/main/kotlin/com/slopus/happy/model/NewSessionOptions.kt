package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.settings.AgentDefaultConfig
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.model.settings.Versions

// What the new-session composer offers for a draft, and how a pick changes
// the draft: HomeDock.tsx's derivations and homeDockInteraction.ts.

/** One row of a new-session picker. An [action] (Enter custom path…) is never drawn as chosen. */
@Immutable
data class PickerOption(
    val key: String,
    val name: String,
    val description: String? = null,
    val disabled: Boolean = false,
    val action: Boolean = false,
)

/** One group of a picker: a heading (a model's provider, say), then its rows. */
@Immutable
data class PickerSection(val key: String, val title: String?, val options: List<PickerOption>)

/** The pickers HomeDock opens: the four rows above the composer and the three chips in it. */
enum class NewSessionPage { Machine, Project, Worktree, Agent, Model, Permission, Effort }

/** A checkout `git worktree list` reported (utils/worktree.ts `WorktreeInfo`). */
@Immutable
data class GitWorktree(val path: String, val branch: String)

/** Where git worktrees are listed from: Happy CLI's machine and the draft's directory. */
@Immutable
data class WorktreeTarget(val machineId: String, val basePath: String)

/** The worktrees last listed, and for which target; a listing for another target is ignored. */
@Immutable
data class WorktreeListing(val target: WorktreeTarget, val worktrees: List<GitWorktree>)

/** The words HomeDock writes into its pickers (English literals in happy-app). */
@Immutable
class NewSessionLabels(
    val selectMachine: String = "Select machine",
    val project: String = "Project",
    val projects: String = "Projects",
    val noWorktree: String = "No worktree",
    val main: String = "Main",
    val createWorkspace: String = "Create New Workspace",
    val createWorktree: String = "Create New Worktree",
    val enterCustomPath: String = "Enter custom path",
    val online: String = "online",
    val notSupportedBy: (harness: String) -> String = { "Not supported by $it" },
    val lastSeen: (activeAt: Long) -> String = { "" },
)

const val CUSTOM_PROJECT_PATH_KEY = "__custom_project_path__"

/** modelModeOptions.ts `modeSupportedByCli`: an untagged mode, or an unknown CLI, goes everywhere. */
fun modeSupportedByCli(mode: ModeOption, cliVersion: String?): Boolean {
    val since = mode.sinceCliVersion
    if (since == null || cliVersion.isNullOrEmpty()) return true
    if (!Versions.isWellFormed(cliVersion)) return false
    return Versions.compareWithPrerelease(cliVersion, since) >= 0
}

/** homeDockInteraction.ts: a persisted pick survives an empty (still syncing) catalog; a stale one becomes the first. */
fun resolveHomeDockMachineSelection(selectedMachineId: String?, availableMachineIds: List<String>): String? = when {
    availableMachineIds.isEmpty() -> selectedMachineId
    selectedMachineId != null && selectedMachineId in availableMachineIds -> selectedMachineId
    else -> availableMachineIds.first()
}

/** HomeDock.tsx `resolveOption`: the first preferred key that exists, else the first option. */
fun resolvePickerOption(options: List<PickerOption>, preferred: List<String?>): PickerOption? =
    preferred.firstNotNullOfOrNull { key -> key?.let { wanted -> options.find { it.key == wanted } } } ?: options.firstOrNull()

private fun ModeOption.toPicker() = PickerOption(key, name, description)

/** The defaults an agent starts with on this computer: Happy Agent's catalog, else the user's and the code's. */
private fun agentDefaults(agent: AgentType, rig: RigSessionCreation?, overrides: AgentDefaultOverrides?, cliVersion: String?): AgentDefaultConfig =
    if (rig != null) {
        AgentDefaultConfig(rig.defaultPermissionMode.orEmpty(), rig.defaultModelKey.orEmpty(), rig.defaultEffortForModel(rig.defaultModelKey))
    } else {
        AgentDefaults.resolve(overrides, agent.wire, cliVersion)
    }

/**
 * HomeDock.tsx `selectAgent`: the harness and its defaults on the draft's
 * computer. [picked] is the person choosing it; following what the
 * computer can run never counts as a pick.
 */
fun NewSessionDraft.selectingAgent(
    agent: AgentType,
    picked: Boolean,
    machines: List<Machine>,
    overrides: AgentDefaultOverrides?,
): NewSessionDraft {
    val choice = findMachineChoice(collectMachineChoices(machines), selectedMachineId)
    val rig = if (agent == AgentType.Rig) choice?.rigMachine?.metadata.rigSessionCreation() else null
    val defaults = agentDefaults(agent, rig, overrides, choice?.happyMachine?.metadata?.happyCliVersion)
    val base = if (picked) pickAgent(agent) else copy(agentType = agent)
    return base.copy(
        permissionMode = defaults.permissionMode,
        modelMode = defaults.modelMode,
        effortLevel = defaults.effortLevel ?: base.effortLevel,
    )
}

/** A project row: its folder, or (a catalog-only project) Happy Agent with the project's identity. */
fun NewSessionDraft.selectingProject(key: String, machines: List<Machine>, overrides: AgentDefaultOverrides?): NewSessionDraft {
    val projectId = readProjectPlaceKey(key) ?: return withPath(key)
    return withProject(projectId).selectingAgent(AgentType.Rig, picked = true, machines, overrides)
}

/** A worktree row: none, a new one, or an existing checkout. */
fun NewSessionDraft.selectingWorktree(key: String): NewSessionDraft = copy(
    sessionType = if (key == WorktreeSelection.NONE) SessionType.Simple else SessionType.Worktree,
    worktreeKey = key.takeUnless { it == WorktreeSelection.NONE || it == WorktreeSelection.NEW },
)

/**
 * Everything the composer shows for one draft (HomeDock.tsx), resolved
 * against the computers and sessions as they are now. The keys are what
 * the pickers hand back; [reconcile] says what the draft should become.
 */
@Immutable
data class NewSessionOptions(
    val choice: MachineChoice?,
    val resolvedMachineId: String?,
    val machines: List<PickerOption>,
    val machine: PickerOption?,
    val projects: List<PickerOption>,
    val project: PickerOption?,
    val picksWorkspaces: Boolean,
    val supportsWorktree: Boolean,
    /** Where to list git worktrees from; null when the picker lists none. */
    val worktreeTarget: WorktreeTarget?,
    val worktrees: List<PickerOption>,
    val worktreeSelection: String,
    val worktree: PickerOption?,
    val agents: List<PickerOption>,
    val agent: PickerOption,
    val resolvedAgent: AgentType,
    val models: List<PickerSection>,
    val model: PickerOption?,
    val permissions: List<PickerOption>,
    val permission: PickerOption?,
    val efforts: List<PickerOption>,
    val effort: PickerOption?,
    /** The computer's Happy Agent can make bots (`capabilities.bots`): the composer offers Session | Bot. */
    val supportsBots: Boolean = false,
) {
    val hasHarness: Boolean get() = agents.isNotEmpty()

    /** new/index.tsx `isOffline`: the daemon that would run this harness is known and offline. */
    val agentMachineOffline: Boolean get() = resolveAgentMachine(choice, resolvedAgent)?.isOnline == false

    /** The permission chip's one word. */
    val permissionLabel: String? get() = permissionModeShortLabel(permission?.name)

    /** The model chip: the model, else the harness. */
    val modelChip: String get() = (model?.name ?: agent.name).trim()

    /**
     * HomeDock.tsx's effects in one step: the machine renamed to the computer
     * it belongs to, the harness moved to one the computer runs, and a
     * worktree pick dropped where none can be made.
     */
    fun reconcile(draft: NewSessionDraft, machines: List<Machine>, overrides: AgentDefaultOverrides?): NewSessionDraft {
        var next = draft
        if (resolvedMachineId != next.selectedMachineId) next = next.copy(selectedMachineId = resolvedMachineId)
        if (resolvedAgent != next.agentType) next = next.selectingAgent(resolvedAgent, picked = false, machines, overrides)
        if (!supportsWorktree && !picksWorkspaces && next.sessionType == SessionType.Worktree) {
            next = next.copy(sessionType = SessionType.Simple, worktreeKey = null)
        }
        return next
    }

    /** The choices behind a picker, with the one drawn as chosen. */
    fun sections(page: NewSessionPage, labels: NewSessionLabels, titles: (NewSessionPage) -> String): Pair<List<PickerSection>, String?> = when (page) {
        NewSessionPage.Machine -> listOf(PickerSection("machine", titles(page), machines)) to resolvedMachineId
        NewSessionPage.Project -> listOf(
            PickerSection("projects", labels.projects, projects),
            PickerSection("custom", null, listOf(PickerOption(CUSTOM_PROJECT_PATH_KEY, labels.enterCustomPath, action = true))),
        ) to project?.key
        NewSessionPage.Worktree -> listOf(PickerSection("worktree", titles(page), worktrees)) to worktreeSelection
        NewSessionPage.Agent -> listOf(PickerSection("agent", titles(page), agents)) to agent.key
        NewSessionPage.Model -> models.map { it.copy(title = it.title ?: titles(page)) } to model?.key
        NewSessionPage.Permission -> listOf(PickerSection("permission", titles(page), permissions)) to permission?.key
        NewSessionPage.Effort -> listOf(PickerSection("effort", titles(page), efforts)) to effort?.key
    }
}

/**
 * HomeDock.tsx's option derivation. [worktrees] is the last git listing;
 * it counts only for the target it was made for. [projectName] names a
 * project the catalog knows but no session shows.
 */
fun resolveNewSessionOptions(
    draft: NewSessionDraft,
    machines: List<Machine>,
    sessions: List<Session>,
    overrides: AgentDefaultOverrides?,
    worktrees: WorktreeListing? = null,
    labels: NewSessionLabels = NewSessionLabels(),
    translate: (Int) -> String = { "" },
    projectName: (String) -> String? = { null },
): NewSessionOptions {
    // A person picks a computer, not a daemon: the Happy CLI and Happy Agent pair is offered once.
    val choices = collectMachineChoices(machines)
    val choice = findMachineChoice(choices, draft.selectedMachineId)
    val machineOptions = choices.sortedByDescending { it.online }.map {
        PickerOption(it.id, it.name, if (it.online) labels.online else labels.lastSeen(it.activeAt))
    }
    val currentMachine = resolvePickerOption(machineOptions, listOf(choice?.id))
    val resolvedMachineId = resolveHomeDockMachineSelection(choice?.id ?: draft.selectedMachineId, machineOptions.map { it.key })
    val homeDir = choice?.happyMachine?.metadata?.homeDir ?: choice?.rigMachine?.metadata?.homeDir

    val placeMachineIds = choice?.machineIds.orEmpty()
    val places = collectSessionPlaces(placeMachineIds, sessions, draft.selectedPath ?: "~")
    val rigSelection = choice?.rigMachine?.metadata.rigSessionCreation()
    val draftProjectId = draft.selectedProjectId
    // A project worked on in its own checkout is offered as that directory, and the draft follows it.
    val draftProjectPlace = draftProjectId?.let { id -> places.find { it.projectId == id } }
    val draftProjectPlaceKey = draftProjectId?.let { draftProjectPlace?.key ?: projectPlaceKey(it) }
    val projectOptions = buildList {
        for (place in places) {
            if (place.path == null) {
                // Only Happy Agent can open a project the catalog alone has the folder for.
                if (rigSelection != null) add(PickerOption(place.key, place.name))
                continue
            }
            val relative = formatPathRelativeToHome(place.path, homeDir)
            val name = if (place.projectId != null) place.name else relative
            add(PickerOption(place.key, name, relative.takeUnless { name == place.path }))
        }
        // The draft's own project keeps its row after its last chat is archived.
        if (draftProjectId != null && draftProjectPlace == null) {
            add(PickerOption(projectPlaceKey(draftProjectId), projectName(draftProjectId) ?: labels.project))
        }
    }
    val selectedProjectId = draftProjectId ?: places.find { it.path == draft.selectedPath }?.projectId
    val currentProject = resolvePickerOption(projectOptions, listOf(draftProjectPlaceKey, draft.selectedPath, "~"))

    val agentType = draft.agentType
    val rigCreation = if (agentType == AgentType.Rig) rigSelection else null
    val supportsWorktree = rigCreation?.supportsWorktrees ?: (agentType != AgentType.Rig && agentType != AgentType.OpenClaw)
    val worktreeSelection = if (draft.sessionType == SessionType.Worktree) draft.worktreeKey ?: WorktreeSelection.NEW else WorktreeSelection.NONE
    // Happy Agent calls these workspaces, and names them; git calls them worktrees.
    val picksWorkspaces = selectedProjectId != null
    val happyMachine = choice?.happyMachine
    val worktreeTarget = if (!picksWorkspaces && supportsWorktree && happyMachine != null && happyMachine.isOnline) {
        WorktreeTarget(happyMachine.id, resolveAbsolutePath(draft.selectedPath ?: "~", homeDir))
    } else {
        null
    }
    val existing = if (picksWorkspaces) {
        collectSessionWorkspaces(placeMachineIds, selectedProjectId, sessions).map { PickerOption(it.key, it.name, it.path) }
    } else {
        worktrees?.takeIf { it.target == worktreeTarget }?.worktrees.orEmpty().map { PickerOption(it.path, it.branch, it.path) }
    }
    val createsNativeWorkspace = agentType == AgentType.Rig && picksWorkspaces && rigCreation != null
    val canCreateWorktree = createsNativeWorkspace ||
        (agentType != AgentType.Rig && resolveWorktreeCreationMachine(choice, agentType, supportsWorktree) != null)
    val worktreeOptions = if (!supportsWorktree && !picksWorkspaces) {
        listOf(PickerOption(WorktreeSelection.NONE, labels.noWorktree, labels.notSupportedBy(agentType.displayName)))
    } else {
        buildList {
            if (canCreateWorktree) add(PickerOption(WorktreeSelection.NEW, if (picksWorkspaces) labels.createWorkspace else labels.createWorktree))
            // No workspace is the project's own checkout: a place with a name.
            add(PickerOption(WorktreeSelection.NONE, if (picksWorkspaces) labels.main else labels.noWorktree))
            addAll(existing)
            draft.worktreeKey?.let { key -> if (none { it.key == key }) add(PickerOption(key, key)) }
        }
    }

    val agents = listMachineChoiceAvailableAgents(choice).map { PickerOption(it.wire, it.displayName) }
    val cliVersion = happyMachine?.metadata?.happyCliVersion
    val defaults = agentDefaults(agentType, rigCreation, overrides, cliVersion)
    // The CLI daemon on the picked computer parses the mode; older ones drop prompts on modes they don't know.
    val permissions = rigCreation?.permissionModes?.map { PickerOption(it.key, it.name, it.description) }
        ?: ModeOptions.permissionModes(agentType.wire, translate).filter { modeSupportedByCli(it, cliVersion) }.map { it.toPicker() }
    val modelSections = if (rigCreation != null) {
        rigCreation.models.groupBy { it.providerId }.map { (providerId, group) ->
            PickerSection(providerId, group.first().providerName, group.map { PickerOption(it.key, it.name) })
        }
    } else {
        val models = ModeOptions.includeConfiguredModel(agentType.wire, ModeOptions.modelModes(agentType.wire), defaults.modelMode)
        listOf(PickerSection("__models__", null, models.map { it.toPicker() }))
    }
    val modelOptions = modelSections.flatMap { it.options }
    // The code default last: when the saved and configured modes were filtered out for an old CLI.
    val permission = resolvePickerOption(
        permissions,
        listOf(draft.permissionMode, defaults.permissionMode, if (rigCreation != null) null else AgentDefaults.codeDefaults(agentType.wire, cliVersion).permissionMode),
    )
    val model = resolvePickerOption(modelOptions, listOf(AgentDefaults.retireModelMode(agentType.wire, draft.modelMode), defaults.modelMode))
    val efforts = rigCreation?.effortsForModel(model?.key)?.map { PickerOption(it, it) }
        ?: ModeOptions.effortLevelsForModel(agentType.wire, model?.key ?: "default").map { it.toPicker() }
    val effortDefault = rigCreation?.defaultEffortForModel(model?.key) ?: defaults.effortLevel
    val effort = resolvePickerOption(efforts, listOf(draft.effortLevel, effortDefault))

    return NewSessionOptions(
        choice = choice,
        resolvedMachineId = resolvedMachineId,
        machines = machineOptions,
        machine = currentMachine,
        projects = projectOptions,
        project = currentProject,
        picksWorkspaces = picksWorkspaces,
        supportsWorktree = supportsWorktree,
        worktreeTarget = worktreeTarget,
        worktrees = worktreeOptions,
        worktreeSelection = worktreeSelection,
        worktree = resolvePickerOption(worktreeOptions, listOf(worktreeSelection)),
        agents = agents,
        agent = agents.find { it.key == agentType.wire } ?: agents.firstOrNull() ?: PickerOption(agentType.wire, agentType.displayName),
        resolvedAgent = resolveNewSessionAgent(choice, agentType, draft.pickedAgentType),
        models = modelSections,
        model = model,
        permissions = permissions,
        permission = permission,
        efforts = efforts,
        effort = effort,
        supportsBots = rigSelection?.supportsBots == true,
    )
}
