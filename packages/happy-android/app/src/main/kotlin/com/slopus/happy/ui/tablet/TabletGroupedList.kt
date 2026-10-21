package com.slopus.happy.ui.tablet

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.DayTitle
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.Machine
import com.slopus.happy.model.ProjectWorkspaceGroup
import com.slopus.happy.model.SessionListInputs
import com.slopus.happy.model.SessionListItem
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.model.buildSessionListViewData
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.hasArchivedSessions
import com.slopus.happy.model.visibleGitChanges
import com.slopus.happy.model.visibleSessionListItems
import com.slopus.happy.ui.home.HomeSnapshot
import java.text.Collator
import java.time.LocalDate
import java.time.ZoneId

/**
 * One row of the sidebar's list grouped by project. MainView.tsx's sidebar
 * mounts SessionsList.tsx, not ProjectHomeList, so with "Group by project"
 * the sidebar keeps SessionsList's own hierarchy rather than home's cards.
 */
@Immutable
sealed interface TabletGroupedRow {
    val key: String

    /** "Bots", then each bot as a flat row. */
    data class Bots(val sessions: List<SessionRowData>) : TabletGroupedRow {
        override val key get() = "bots"
    }

    /** A computer's rule; null for chats that name none. */
    data class MachineHeader(val machineId: String?, val machineName: String) : TabletGroupedRow {
        override val key get() = "machine-header-$machineId"
    }

    /**
     * ProjectGroup's WorkspaceSection: one checkout's heading over a card of
     * its chats. [branch] is null for "main"; [lastOfProject] carries the
     * project's 4 below its last checkout.
     */
    data class Checkout(
        val projectKey: String,
        val projectName: String,
        val workspace: ProjectWorkspaceGroup,
        val branch: String?,
        val changes: VisibleGitChanges?,
        val lastOfProject: Boolean,
    ) : TabletGroupedRow {
        override val key get() = "project-$projectKey-${workspace.id}"
    }

    data class ArchiveToggle(val hidden: Boolean) : TabletGroupedRow {
        override val key get() = "archive-toggle"
    }

    data class DayHeader(val title: DayTitle, val day: LocalDate) : TabletGroupedRow {
        override val key get() = "header-$day"
    }

    /** SessionsList's SessionItem: an archived chat as a card in its day's group. */
    data class ArchivedSession(val session: SessionRowData, val first: Boolean, val last: Boolean) : TabletGroupedRow {
        override val key get() = "session-${session.id}"
    }
}

/**
 * SessionsList.tsx's data when it is not flat: the bots, then each
 * computer's projects (sessionDisplayOrder.ts `buildSessionProjectDisplayGroups`),
 * then the archive toggle and the date-grouped archive. [machines] are the
 * online ones (`useAllMachines()`), so an offline computer goes by its id.
 */
fun buildTabletGroupedRows(
    items: List<SessionListItem>,
    machines: List<Machine>,
    gitStatuses: Map<String, GitStatus>,
    hasArchived: Boolean,
    archiveHidden: Boolean,
    unknownText: String,
): List<TabletGroupedRow> {
    val collator = Collator.getInstance()
    val byId = machines.associateBy { it.id }
    fun nameOf(machineId: String?): String {
        val machine = machineId?.let { byId[it] }
        return machine?.metadata?.displayName?.takeIf { it.isNotEmpty() }
            ?: machine?.metadata?.host?.takeIf { it.isNotEmpty() }
            ?: machineId
            ?: "<$unknownText>"
    }

    val rows = mutableListOf<TabletGroupedRow>()
    items.filterIsInstance<SessionListItem.Bots>().forEach { rows.add(TabletGroupedRow.Bots(it.sessions)) }

    val byMachine = LinkedHashMap<String?, MutableList<SessionListItem.ProjectItem>>()
    items.filterIsInstance<SessionListItem.ProjectItem>().forEach { byMachine.getOrPut(it.project.machineId) { mutableListOf() }.add(it) }
    val groups = byMachine.entries
        .map { (id, projects) -> Triple(id, nameOf(id), projects) }
        .sortedWith(compareBy<Triple<String?, String, *>> { it.first == null }.thenComparator { a, b -> collator.compare(a.second, b.second) })
    for ((machineId, machineName, projects) in groups) {
        rows.add(TabletGroupedRow.MachineHeader(machineId, machineName))
        val sorted = projects.sortedWith { a, b ->
            collator.compare(a.project.name, b.project.name).takeIf { it != 0 } ?: collator.compare(a.project.id, b.project.id)
        }
        for (item in sorted) {
            val project = item.project
            val projectKey = "${item.source}-${project.machineId ?: "unknown"}-${project.id}"
            project.workspaces.forEachIndexed { index, workspace ->
                val first = workspace.sessions.firstOrNull()
                val status = first?.let { gitStatusKey(it.machineId, it.path) }?.let { gitStatuses[it] }
                rows.add(
                    TabletGroupedRow.Checkout(
                        projectKey = projectKey,
                        projectName = project.name,
                        workspace = workspace,
                        branch = workspace.name ?: workspace.id.ifEmpty { null } ?: status?.branch,
                        changes = checkoutChanges(first, status),
                        lastOfProject = index == project.workspaces.lastIndex,
                    ),
                )
            }
        }
    }

    if (hasArchived) rows.add(TabletGroupedRow.ArchiveToggle(archiveHidden))
    val archived = items.filter { it is SessionListItem.Header || it is SessionListItem.SessionItem }
    archived.forEachIndexed { index, item ->
        when (item) {
            is SessionListItem.Header -> rows.add(TabletGroupedRow.DayHeader(item.title, item.day))
            is SessionListItem.SessionItem -> rows.add(
                TabletGroupedRow.ArchivedSession(
                    item.session,
                    first = archived.getOrNull(index - 1) is SessionListItem.Header,
                    last = archived.getOrNull(index + 1).let { it == null || it is SessionListItem.Header },
                ),
            )
            else -> Unit
        }
    }
    return rows
}

/**
 * WorkspaceSection's counts: the daemon's unstaged lines when there are
 * any, else Happy Agent's own comparison for the first chat.
 */
fun checkoutChanges(first: SessionRowData?, status: GitStatus?): VisibleGitChanges? {
    val insertions = status?.unstagedLinesAdded ?: 0
    val deletions = status?.unstagedLinesRemoved ?: 0
    if (insertions > 0 || deletions > 0) return VisibleGitChanges(false, insertions, deletions)
    return first?.let(::visibleGitChanges)
}

/** The sidebar's grouped rows from Home's snapshot, as SessionsList derives them. */
fun deriveTabletGroupedList(
    snapshot: HomeSnapshot,
    archiveHidden: Boolean,
    unreadSessionIds: Set<String>,
    archivingSessionIds: Set<String>,
    unknownText: String,
    zone: ZoneId,
    today: LocalDate,
): List<TabletGroupedRow> {
    val all = buildSessionListViewData(
        SessionListInputs(
            snapshot.sessions,
            snapshot.machines.associateBy { it.id },
            snapshot.projects,
            unreadSessionIds,
            archivingSessionIds,
            snapshot.gitStatuses,
        ),
        zone,
        today,
    )
    return buildTabletGroupedRows(
        visibleSessionListItems(all, archiveHidden),
        snapshot.machines.filter { it.isOnline },
        snapshot.gitStatuses,
        hasArchivedSessions(all),
        archiveHidden,
        unknownText,
    )
}
