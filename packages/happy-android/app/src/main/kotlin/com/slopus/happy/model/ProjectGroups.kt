package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// happy-app sync/projectGroups.ts: sessions dealt into projects and their
// worktrees. Sessions arrive sorted, and insertion order carries that sort
// through to projects, worktrees and the sessions inside them.

/** One git worktree inside a project. [id] is empty and [name] null for the primary tree, which sorts first. */
@Immutable
data class ProjectWorkspaceGroup(val id: String, val name: String?, val sessions: List<SessionRowData>)

/** A project: Rig's durable identity, or a Happy CLI session's machine and working directory. */
@Immutable
data class ProjectGroupData(
    val id: String,
    val name: String,
    val machineId: String?,
    val workspaces: List<ProjectWorkspaceGroup>,
    val sessionCount: Int,
    val activeCount: Int,
)

/** isProjectSession: Rig reports a project for its current sessions. */
fun Session.isProjectSession(): Boolean = !metadata?.project?.id.isNullOrEmpty()

private class GroupBuilder(val id: String, val name: String, val machineId: String?) {
    val workspaces = mutableListOf<WorkspaceBuilder>()
    var sessionCount = 0
    var activeCount = 0

    fun build(): ProjectGroupData {
        // The primary tree leads; the rest keep newest-first order.
        val primary = workspaces.indexOfFirst { it.id == "" }
        if (primary > 0) workspaces.add(0, workspaces.removeAt(primary))
        return ProjectGroupData(id, name, machineId, workspaces.map { it.build() }, sessionCount, activeCount)
    }
}

private class WorkspaceBuilder(val id: String, val name: String?) {
    val sessions = mutableListOf<SessionRowData>()
    fun build() = ProjectWorkspaceGroup(id, name, sessions.toList())
}

/** buildProjectGroups: Rig sessions collapsed into their projects, each holding its worktrees. */
fun buildProjectGroups(
    sessions: List<Session>,
    toRow: (Session) -> SessionRowData,
    isActive: (Session) -> Boolean,
): List<ProjectGroupData> {
    val projects = LinkedHashMap<String, GroupBuilder>()
    val workspaces = HashMap<String, WorkspaceBuilder>()
    for (session in sessions) {
        val project = session.metadata!!.project!!
        val group = projects.getOrPut(project.id) { GroupBuilder(project.id, project.name, session.metadata.machineId) }
        val workspace = session.metadata.workspace
        val workspaceId = workspace?.id ?: ""
        val workspaceGroup = workspaces.getOrPut("${project.id}\u0000$workspaceId") {
            WorkspaceBuilder(workspaceId, workspace?.name).also { group.workspaces.add(it) }
        }
        workspaceGroup.sessions.add(toRow(session))
        group.sessionCount += 1
        if (isActive(session)) group.activeCount += 1
    }
    return projects.values.map { it.build() }
}

/**
 * buildPathProjectGroups: sessions without a native project, grouped by
 * machine and repository path. Happy-created worktree paths nest under their
 * main checkout; identical paths on different computers stay apart.
 */
fun buildPathProjectGroups(
    sessions: List<Session>,
    toRow: (Session) -> SessionRowData,
    isActive: (Session) -> Boolean,
    idPrefix: String,
): List<ProjectGroupData> {
    val projects = LinkedHashMap<String, GroupBuilder>()
    val workspaces = HashMap<String, WorkspaceBuilder>()
    for (session in sessions) {
        val machineId = session.metadata?.machineId
        val sessionPath = session.metadata?.path?.trim().orEmpty()
        val worktree = WorktreePaths.isWorktree(sessionPath)
        val projectPath = if (worktree) WorktreePaths.repoPath(sessionPath) else sessionPath
        val workspaceId = if (worktree) sessionPath else ""
        val workspaceName = if (worktree) WorktreePaths.worktreeName(sessionPath) else null
        // JSON.stringify([machineId, projectPath])
        val key = JsonArray(listOf(machineId?.let(::JsonPrimitive) ?: JsonNull, JsonPrimitive(projectPath))).toString()
        val group = projects.getOrPut(key) {
            GroupBuilder("$idPrefix:$key", pathProjectName(projectPath, session.metadata?.homeDir), machineId)
        }
        val workspace = workspaces.getOrPut("$key\u0000$workspaceId") {
            WorkspaceBuilder(workspaceId, workspaceName).also { group.workspaces.add(it) }
        }
        workspace.sessions.add(toRow(session))
        group.sessionCount += 1
        if (isActive(session)) group.activeCount += 1
    }
    return projects.values.map { it.build() }
}

private fun pathProjectName(path: String, homeDir: String?): String {
    val trailing = Regex("[\\\\/]+$")
    val normalizedPath = path.replace(trailing, "")
    val normalizedHome = homeDir?.replace(trailing, "")
    if (normalizedPath.isEmpty() || normalizedPath == "~" || normalizedPath == normalizedHome) return "Home"
    return normalizedPath.split(Regex("[\\\\/]")).lastOrNull { it.isNotEmpty() } ?: normalizedPath
}

/** filterProjectGroupSessions: only the rows [keep] accepts, with the counts refreshed; null if none are left. */
fun ProjectGroupData.filterSessions(keep: (SessionRowData) -> Boolean): ProjectGroupData? {
    val kept = workspaces
        .map { it.copy(sessions = it.sessions.filter(keep)) }
        .filter { it.sessions.isNotEmpty() }
    if (kept.isEmpty()) return null
    val sessions = kept.flatMap { it.sessions }
    return copy(workspaces = kept, sessionCount = sessions.size, activeCount = sessions.count { it.active })
}
