package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import java.text.Collator

// utils/projectHomeList.ts and utils/sessionDisplayOrder.ts: the home list
// grouped by project, under the computer the work runs on.

/** One checkout of a project (its own, or a worktree) and the chats in it. */
@Immutable
data class ProjectWorktree(
    val id: String,
    val projectId: String,
    val projectName: String,
    /** Empty for the project's own checkout. */
    val workspaceId: String,
    /** Null for the project's own checkout. */
    val workspaceName: String?,
    /** What a tap opens: the chat worked on most recently. */
    val session: SessionRowData,
    /** Every chat in the checkout, oldest first, so activity never reshuffles the tabs. */
    val tabs: List<SessionRowData>,
    val unread: Boolean,
    val working: Boolean,
    /** Something here is stopped on a question only the user can answer. */
    val blocked: Boolean,
    /** A chat here runs on a reachable machine. */
    val live: Boolean,
    val machineId: String?,
)

/** A project's card: it goes by the project's name and opens the project's own checkout. */
@Immutable
data class ProjectHomeEntry(
    val id: String,
    val name: String,
    /** Null for a project that only has worktrees. */
    val session: SessionRowData?,
    val tabs: List<SessionRowData>,
    /** Supplies the avatar: a worktree's chat when there is no own checkout. */
    val avatarSession: SessionRowData?,
    val worktreeCount: Int,
    val unread: Boolean,
    val working: Boolean,
    val blocked: Boolean,
    val live: Boolean,
)

/** The row that ends a project's worktrees: `Show all N` while some are held back, `Show fewer` once out. */
@Immutable
data class WorktreeToggle(
    val projectId: String,
    val worktreeCount: Int,
    val hiddenCount: Int,
    val expanded: Boolean,
    val unread: Boolean,
    val working: Boolean,
    val blocked: Boolean,
)

enum class ProjectHomeSection { Bots, Projects }

@Immutable
sealed interface ProjectHomeRow {
    val key: String

    data class Section(val id: String, val section: ProjectHomeSection) : ProjectHomeRow {
        override val key get() = "section-$id"
    }

    /** The computer everything below it runs on, drawn even for a single machine. */
    data class MachineHeader(val machineId: String?, val machineName: String) : ProjectHomeRow {
        override val key get() = "machine-${machineId ?: "unknown"}"
    }

    data class Bot(val session: SessionRowData) : ProjectHomeRow {
        override val key get() = "bot-${session.id}"
    }

    data class ProjectCard(val project: ProjectHomeEntry) : ProjectHomeRow {
        override val key get() = "project-${project.id}"
    }

    /** [last] closes the tree line from the project's avatar. */
    data class Worktree(val worktree: ProjectWorktree, val last: Boolean) : ProjectHomeRow {
        override val key get() = "worktree-${worktree.id}"
    }

    data class Toggle(val toggle: WorktreeToggle) : ProjectHomeRow {
        override val key get() = "worktree-toggle-${toggle.projectId}"
    }

    data class ArchiveToggle(val hidden: Boolean) : ProjectHomeRow {
        override val key get() = "archive-toggle"
    }

    data class ArchiveHeader(val title: DayTitle, val day: java.time.LocalDate) : ProjectHomeRow {
        override val key get() = "archive-header-$day"
    }

    data class Archived(val session: SessionRowData) : ProjectHomeRow {
        override val key get() = "archived-${session.id}"
    }
}

/** How many worktrees a project shows before the rest are summarised. */
const val WORKTREE_PREVIEW_COUNT = 3

fun worktreePlaceId(projectId: String, workspaceId: String) = "$projectId\u0000$workspaceId"

/** Where a new workspace for a project would be created, read off one of its chats. */
data class WorkspaceOrigin(val machineId: String, val projectId: String?, val path: String?)

fun workspaceOrigin(session: SessionRowData): WorkspaceOrigin? {
    val machineId = session.machineId ?: return null
    if (session.projectId != null) return WorkspaceOrigin(machineId, session.projectId, null)
    val path = session.path?.trim().orEmpty()
    if (path.isEmpty()) return null
    return WorkspaceOrigin(machineId, null, if (WorktreePaths.isWorktree(path)) WorktreePaths.repoPath(path) else path)
}

private data class Activity(val unread: Boolean, val working: Boolean, val blocked: Boolean)

private fun activity(sessions: List<SessionRowData>) = Activity(
    unread = sessions.any { it.hasUnread },
    working = sessions.any { it.state == SessionState.Thinking },
    blocked = sessions.any { it.state == SessionState.PermissionRequired || it.state == SessionState.InputRequired },
)

private fun isLive(sessions: List<SessionRowData>) = sessions.any { it.active && !it.machineOffline }

fun tabOrder(sessions: List<SessionRowData>): List<SessionRowData> =
    sessions.sortedWith(compareBy<SessionRowData> { it.createdAt }.thenBy { it.id })

private fun toWorktree(project: ProjectGroupData, workspace: ProjectWorkspaceGroup): ProjectWorktree? {
    val newest = workspace.sessions.firstOrNull() ?: return null
    val a = activity(workspace.sessions)
    return ProjectWorktree(
        id = worktreePlaceId(project.id, workspace.id),
        projectId = project.id,
        projectName = project.name,
        workspaceId = workspace.id,
        workspaceName = if (workspace.id == "") null else workspace.name ?: workspace.id,
        session = newest,
        tabs = tabOrder(workspace.sessions),
        unread = a.unread,
        working = a.working,
        blocked = a.blocked,
        live = isLive(workspace.sessions),
        machineId = project.machineId,
    )
}

private fun projectRows(project: ProjectGroupData, expanded: Set<String>): List<ProjectHomeRow> {
    val checkouts = project.workspaces.mapNotNull { toWorktree(project, it) }
    if (checkouts.isEmpty()) return emptyList()
    val primary = checkouts.find { it.workspaceId == "" }
    val worktrees = checkouts.filter { it.workspaceId != "" }
    val ownTabs = primary?.tabs.orEmpty()
    val own = activity(ownTabs)
    val rows = mutableListOf<ProjectHomeRow>(
        ProjectHomeRow.ProjectCard(
            ProjectHomeEntry(
                id = project.id,
                name = project.name,
                session = primary?.session,
                tabs = ownTabs,
                avatarSession = primary?.session ?: worktrees.firstOrNull()?.session,
                worktreeCount = worktrees.size,
                unread = own.unread,
                working = own.working,
                blocked = own.blocked,
                live = isLive(ownTabs),
            ),
        ),
    )
    val isExpanded = project.id in expanded
    val shown = if (isExpanded) worktrees else worktrees.take(WORKTREE_PREVIEW_COUNT)
    val hidden = worktrees.drop(shown.size)
    val togglable = if (isExpanded) worktrees.size > WORKTREE_PREVIEW_COUNT else hidden.isNotEmpty()
    shown.forEachIndexed { index, worktree ->
        rows.add(ProjectHomeRow.Worktree(worktree, last = !togglable && index == shown.size - 1))
    }
    if (togglable) {
        val a = activity(hidden.flatMap { it.tabs })
        rows.add(ProjectHomeRow.Toggle(WorktreeToggle(project.id, worktrees.size, hidden.size, isExpanded, a.unread, a.working, a.blocked)))
    }
    return rows
}

private class MachineSection(val machineId: String?, val machineName: String, val rig: Boolean) {
    val bots = mutableListOf<SessionRowData>()
    val projects = mutableListOf<ProjectHomeRow>()
    var lastActivityAt = 0L
}

/** sessionDisplayOrder.ts `buildSessionProjectDisplayGroups`: projects per machine, by name. */
private fun projectsByMachine(items: List<SessionListItem>, machineName: (String?) -> String, collator: Collator): List<Pair<String?, List<ProjectGroupData>>> {
    val byMachine = LinkedHashMap<String?, MutableList<ProjectGroupData>>()
    for (item in items) {
        if (item !is SessionListItem.ProjectItem) continue
        byMachine.getOrPut(item.project.machineId) { mutableListOf() }.add(item.project)
    }
    return byMachine.entries
        .map { (id, projects) -> id to projects.sortedWith { a, b -> collator.compare(a.name, b.name).takeIf { it != 0 } ?: collator.compare(a.id, b.id) } }
        .sortedWith(compareBy<Pair<String?, List<ProjectGroupData>>> { it.first == null }.thenComparator { a, b -> collator.compare(machineName(a.first), machineName(b.first)) })
}

/**
 * buildProjectHomeRows: each computer, then its bots, then its projects (a
 * card per project with its worktrees under it). Happy Agent computers lead,
 * then the most recently worked on; chats that name no computer go last. The
 * archive trails behind its toggle as the flat, date-grouped tail.
 */
fun buildProjectHomeRows(
    items: List<SessionListItem>,
    machines: Map<String, Machine>,
    unknownMachineText: String,
    expanded: Set<String>,
    hasArchivedSessions: Boolean = false,
    archiveHidden: Boolean = true,
): List<ProjectHomeRow> {
    val collator = Collator.getInstance()
    val sections = LinkedHashMap<String?, MachineSection>()
    fun nameOf(machineId: String?): String {
        val machine = machineId?.let { machines[it] }
        return machine?.metadata?.displayName?.takeIf { it.isNotEmpty() }
            ?: machine?.metadata?.host?.takeIf { it.isNotEmpty() }
            ?: machineId
            ?: "<$unknownMachineText>"
    }
    fun sectionFor(machineId: String?): MachineSection = sections.getOrPut(machineId) {
        MachineSection(machineId, nameOf(machineId), machineId?.let { machines[it] }?.metadata?.machineKind == "rig")
    }

    for (item in items) {
        if (item !is SessionListItem.Bots) continue
        for (session in item.sessions) {
            val section = sectionFor(session.machineId)
            section.bots.add(session)
            section.lastActivityAt = maxOf(section.lastActivityAt, session.lastActivityAt)
        }
    }
    for ((machineId, projects) in projectsByMachine(items, ::nameOf, collator)) {
        val section = sectionFor(machineId)
        for (project in projects) {
            val built = projectRows(project, expanded)
            if (built.isEmpty()) continue
            section.projects.addAll(built)
            project.workspaces.forEach { w -> w.sessions.forEach { section.lastActivityAt = maxOf(section.lastActivityAt, it.lastActivityAt) } }
        }
    }

    val rank = { s: MachineSection -> if (s.machineId == null) 2 else if (s.rig) 0 else 1 }
    val ordered = sections.values.sortedWith(
        compareBy<MachineSection> { rank(it) }
            .thenByDescending { it.lastActivityAt }
            .thenComparator { a, b -> collator.compare(a.machineName, b.machineName) },
    )
    val rows = mutableListOf<ProjectHomeRow>()
    for (section in ordered) {
        if (section.bots.isEmpty() && section.projects.isEmpty()) continue
        val key = section.machineId ?: "unknown"
        rows.add(ProjectHomeRow.MachineHeader(section.machineId, section.machineName))
        if (section.bots.isNotEmpty()) {
            rows.add(ProjectHomeRow.Section("bots:$key", ProjectHomeSection.Bots))
            section.bots.forEach { rows.add(ProjectHomeRow.Bot(it)) }
        }
        if (section.projects.isNotEmpty()) {
            rows.add(ProjectHomeRow.Section("projects:$key", ProjectHomeSection.Projects))
            rows.addAll(section.projects)
        }
    }

    if (hasArchivedSessions) rows.add(ProjectHomeRow.ArchiveToggle(archiveHidden))
    var pending: SessionListItem.Header? = null
    for (item in items) {
        if (item is SessionListItem.Header) {
            pending = item
            continue
        }
        if (item !is SessionListItem.SessionItem) continue
        pending?.let { rows.add(ProjectHomeRow.ArchiveHeader(it.title, it.day)) }
        pending = null
        rows.add(ProjectHomeRow.Archived(item.session))
    }
    return rows
}

/** Every project chat's checkout, by session id (one [findProjectWorktree] per chat, in one pass). */
fun projectWorktreesBySession(items: List<SessionListItem>): Map<String, ProjectWorktree> {
    val result = HashMap<String, ProjectWorktree>()
    for (item in items) {
        if (item !is SessionListItem.ProjectItem) continue
        for (workspace in item.project.workspaces) {
            val worktree = toWorktree(item.project, workspace) ?: continue
            workspace.sessions.forEach { result[it.id] = worktree }
        }
    }
    return result
}

/** The checkout a chat runs in, with its sibling chats as tabs; null for bots and unknown chats. */
fun findProjectWorktree(items: List<SessionListItem>?, sessionId: String): ProjectWorktree? {
    for (item in items ?: return null) {
        if (item !is SessionListItem.ProjectItem) continue
        for (workspace in item.project.workspaces) {
            if (workspace.sessions.any { it.id == sessionId }) return toWorktree(item.project, workspace)
        }
    }
    return null
}

/** rigGitLineChanges.ts `compactCount`: happy-desktop's dense-row count. */
fun compactCount(value: Long): String {
    val count = maxOf(0L, value)
    if (count < 1_000) return count.toString()
    if (count < 5_000) {
        val tenths = Math.round(count / 100.0)
        return if (tenths % 10 == 0L) "${tenths / 10}k" else "${tenths / 10}.${tenths % 10}k"
    }
    return "${Math.round(count / 1_000.0)}k"
}

/** visibleRigGitLineChanges: nothing for a clean comparison. */
data class VisibleGitChanges(val approximate: Boolean, val insertions: Long, val deletions: Long)

fun visibleGitChanges(row: SessionRowData): VisibleGitChanges? {
    if (row.gitChangedFiles == null) return null
    val insertions = row.gitInsertions ?: 0
    val deletions = row.gitDeletions ?: 0
    if (insertions == 0L && deletions == 0L) return null
    return VisibleGitChanges(!row.gitCountsExact, insertions, deletions)
}

/**
 * ProjectHomeList useGitChanges: Happy Agent's whole-checkout comparison
 * when it published one, else the daemon's working-tree count.
 */
fun projectGitChanges(row: SessionRowData): VisibleGitChanges? {
    if (row.gitChangedFiles != null) return visibleGitChanges(row)
    if (row.gitStatusLinesAdded <= 0 && row.gitStatusLinesRemoved <= 0) return null
    return VisibleGitChanges(false, row.gitStatusLinesAdded, row.gitStatusLinesRemoved)
}
