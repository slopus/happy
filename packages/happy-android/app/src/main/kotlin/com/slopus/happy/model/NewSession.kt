package com.slopus.happy.model

import com.slopus.happy.sync.HappyAgentSpawnTarget
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The new-session draft and the pure parts of starting from it:
// sync/persistence.ts NewSessionDraft, sync/agentSessionPlaces.ts,
// sync/happyAgentSpawn.ts, utils/pathUtils.ts resolveAbsolutePath and
// components/newSessionProgress.ts.

enum class SessionType(val wire: String) { Simple("simple"), Worktree("worktree") }

/** What a worktree selection means: none, a new one, or an existing checkout's path. */
object WorktreeSelection {
    const val NONE = "__none__"
    const val NEW = "__new__"
}

/**
 * persistence.ts `NewSessionDraft`: the composer's last configuration, kept
 * across launches and shared by the home dock and the new-session screen.
 * Exactly one of [selectedPath] and [selectedProjectId] names the place.
 */
data class NewSessionDraft(
    val input: String = "",
    val selectedMachineId: String? = null,
    val selectedPath: String? = null,
    val selectedProjectId: String? = null,
    val agentType: AgentType = AgentType.Claude,
    /** The harness last picked by hand; [agentType] follows what the computer can run. */
    val pickedAgentType: AgentType? = null,
    val permissionMode: String? = null,
    val modelMode: String? = null,
    val effortLevel: String? = null,
    val sessionType: SessionType = SessionType.Simple,
    val worktreeKey: String? = null,
    val updatedAt: Long = 0,
) {
    /** setMachineId: another computer's folders mean nothing here. */
    fun withMachine(id: String?) = copy(selectedMachineId = id, selectedPath = null, selectedProjectId = null, worktreeKey = null)

    fun withPath(path: String?) = copy(selectedPath = path, selectedProjectId = null, worktreeKey = null)

    fun withProject(id: String?) = copy(selectedProjectId = id, selectedPath = null, worktreeKey = null)

    fun pickAgent(agent: AgentType) = copy(agentType = agent, pickedAgentType = agent)

    fun toJson(): JsonObject = JsonObject(
        listOfNotNull(
            "input" to JsonPrimitive(input),
            "selectedMachineId" to JsonPrimitive(selectedMachineId),
            "selectedPath" to JsonPrimitive(selectedPath),
            "selectedProjectId" to JsonPrimitive(selectedProjectId),
            "agentType" to JsonPrimitive(agentType.wire),
            "pickedAgentType" to JsonPrimitive(pickedAgentType?.wire),
            "permissionMode" to JsonPrimitive(permissionMode),
            "modelMode" to JsonPrimitive(modelMode),
            "effortLevel" to JsonPrimitive(effortLevel),
            "sessionType" to JsonPrimitive(sessionType.wire),
            "worktreeKey" to JsonPrimitive(worktreeKey),
            "updatedAt" to JsonPrimitive(updatedAt),
        ).toMap(),
    )

    companion object {
        /** loadNewSessionDraft: every field checked on its own; anything off takes its default. */
        fun parse(text: String?): NewSessionDraft? {
            val json = parseJsonObject(text) ?: return null
            fun string(key: String) = (json[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun agent(key: String) = AgentType.fromWire(string(key))
            return NewSessionDraft(
                input = string("input") ?: "",
                selectedMachineId = string("selectedMachineId"),
                selectedPath = string("selectedPath"),
                selectedProjectId = string("selectedProjectId"),
                agentType = agent("agentType") ?: AgentType.Claude,
                pickedAgentType = agent("pickedAgentType"),
                permissionMode = string("permissionMode"),
                modelMode = string("modelMode"),
                effortLevel = string("effortLevel"),
                sessionType = if (string("sessionType") == SessionType.Worktree.wire) SessionType.Worktree else SessionType.Simple,
                worktreeKey = string("worktreeKey"),
                updatedAt = (json["updatedAt"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()?.toLong() ?: 0,
            )
        }
    }
}

/** resolveAbsolutePath: `~` and `~/…` against the machine's home, in its own separator. */
fun resolveAbsolutePath(path: String, homeDir: String?): String {
    if (!path.startsWith("~") || homeDir.isNullOrEmpty()) return path
    val home = if (homeDir.endsWith("/") || homeDir.endsWith("\\")) homeDir.dropLast(1) else homeDir
    if (path == "~") return home
    if (path.startsWith("~/")) {
        val separator = if (homeDir.lastIndexOf('\\') > homeDir.lastIndexOf('/')) '\\' else '/'
        return home + separator + path.substring(2)
    }
    return path
}

/** agentSessionPlaces.ts `SessionPlace`: a directory, or a project only the catalog can place. */
data class SessionPlace(val key: String, val name: String, val path: String?, val projectId: String? = null)

/** agentSessionPlaces.ts `SessionWorkspace` */
data class SessionWorkspace(val id: String, val key: String, val name: String, val path: String, val projectId: String?)

private const val PROJECT_PLACE_PREFIX = "project:"

fun projectPlaceKey(projectId: String) = "$PROJECT_PLACE_PREFIX$projectId"

fun readProjectPlaceKey(key: String): String? =
    if (key.startsWith(PROJECT_PLACE_PREFIX)) key.removePrefix(PROJECT_PLACE_PREFIX).ifEmpty { null } else null

/**
 * collectSessionPlaces: everywhere on the computer's machines a session has
 * worked, archived ones aside, a project's name winning over its bare path.
 * A project met only inside its workspaces is offered by identity.
 */
fun collectSessionPlaces(machineIds: Collection<String>, sessions: Collection<Session>, selectedPath: String? = null): List<SessionPlace> {
    val ids = machineIds.filter { it.isNotEmpty() }.toSet()
    val byPath = LinkedHashMap<String, SessionPlace>()
    val byProject = LinkedHashMap<String, String>()
    val projectsWithPath = HashSet<String>()
    fun remember(place: SessionPlace, named: Boolean) {
        val existing = byPath[place.path!!]
        if (existing != null && (!named || existing.projectId != null)) return
        byPath[place.path] = place
    }
    selectedPath?.trim()?.takeIf { it.isNotEmpty() }?.let { remember(SessionPlace(it, it, it), named = false) }
    for (session in sessions) {
        val metadata = session.metadata ?: continue
        if (metadata.bot != null) continue
        val path = metadata.path.trim().takeIf { it.isNotEmpty() } ?: continue
        if (metadata.machineId != null && metadata.machineId !in ids) continue
        if (metadata.lifecycleState == "archived") continue
        val project = metadata.project
        if (metadata.workspace != null) {
            if (project != null && project.id.isNotEmpty()) byProject[project.id] = project.name
            continue
        }
        if (project != null && project.id.isNotEmpty()) {
            projectsWithPath += project.id
            remember(SessionPlace(path, project.name, path, project.id), named = true)
            continue
        }
        remember(SessionPlace(path, path, path), named = false)
    }
    val places = byPath.values.toMutableList()
    for ((projectId, name) in byProject) {
        if (projectId in projectsWithPath) continue
        places += SessionPlace(projectPlaceKey(projectId), name, null, projectId)
    }
    return places
}

/** collectSessionWorkspaces: a project's workspaces as Happy Agent published them, archived ones aside. */
fun collectSessionWorkspaces(machineIds: Collection<String>, projectId: String?, sessions: Collection<Session>): List<SessionWorkspace> {
    val project = projectId?.trim()?.takeIf { it.isNotEmpty() } ?: return emptyList()
    val ids = machineIds.filter { it.isNotEmpty() }.toSet()
    val byId = LinkedHashMap<String, SessionWorkspace>()
    for (session in sessions) {
        val metadata = session.metadata ?: continue
        if (metadata.bot != null) continue
        val workspace = metadata.workspace ?: continue
        val path = metadata.path.trim().takeIf { it.isNotEmpty() } ?: continue
        if (metadata.project?.id != project) continue
        if (metadata.machineId != null && metadata.machineId !in ids) continue
        if (metadata.lifecycleState == "archived") continue
        byId.getOrPut(workspace.id) { SessionWorkspace(workspace.id, path, workspace.name, path, project) }
    }
    return byId.values.toList()
}

class UnavailableWorkspaceException : IllegalStateException("The selected Happy Agent workspace is no longer available.")

/** resolveHappyAgentSpawnTarget: null for a plain directory; a known project never falls back to its path. */
fun resolveHappyAgentSpawnTarget(projectId: String?, workspaceSelection: String, workspaces: List<SessionWorkspace>): HappyAgentSpawnTarget? {
    val project = projectId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return when (workspaceSelection) {
        WorktreeSelection.NEW -> HappyAgentSpawnTarget.NewWorkspace(project)
        WorktreeSelection.NONE -> HappyAgentSpawnTarget.Project(project)
        else -> HappyAgentSpawnTarget.Workspace(
            workspaces.find { it.path == workspaceSelection }?.id ?: throw UnavailableWorkspaceException(),
        )
    }
}

/** newSessionProgress.ts: no canceling phase; Stop hands the composer back at once. */
enum class StartPhase { Worktree, Spawning, Avatar, Opening }

sealed interface StartProgress {
    data class CreatingWorkspace(val workspace: Boolean) : StartProgress
    data class Starting(val agentName: String) : StartProgress
    data object CreatingBot : StartProgress
    /** "Putting on a face…": the bot's picture is painted, uploaded and worn. */
    data object Avatar : StartProgress
    data class Opening(val bot: Boolean = false) : StartProgress
}

/** resolveNewSessionProgressLabel: the step, named for a bot while one is being made. */
fun resolveStartProgress(phase: StartPhase?, agentName: String, picksWorkspaces: Boolean, createsBot: Boolean = false): StartProgress? = when (phase) {
    null -> null
    StartPhase.Worktree -> StartProgress.CreatingWorkspace(picksWorkspaces)
    StartPhase.Spawning -> if (createsBot) StartProgress.CreatingBot else StartProgress.Starting(agentName)
    StartPhase.Avatar -> StartProgress.Avatar
    StartPhase.Opening -> StartProgress.Opening(createsBot)
}

/** newSessionProgress.ts `NewSessionPrimaryAction`: the one button at the end of the composer. */
enum class StartButton { Send, Stop, Busy, Idle }

/** resolveNewSessionPrimaryAction: Stop for the whole flow, unless there is nowhere to send it. */
fun resolveStartButton(canSubmit: Boolean, phase: StartPhase?, canCancel: Boolean): StartButton = when {
    phase != null -> if (canCancel) StartButton.Stop else StartButton.Busy
    canSubmit -> StartButton.Send
    else -> StartButton.Idle
}
