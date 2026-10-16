package com.slopus.happy.ui.home

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.DayTitle
import com.slopus.happy.model.FlatSessionRowData
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.ProjectWorktree
import com.slopus.happy.model.projectWorktreesBySession
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.SessionListInputs
import com.slopus.happy.model.SessionListItem
import com.slopus.happy.model.Settings
import com.slopus.happy.model.buildFlatSessionRows
import com.slopus.happy.model.buildProjectHomeRows
import com.slopus.happy.model.buildSessionListViewData
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.hasArchivedSessions
import com.slopus.happy.model.resolveHomeEmptyState
import com.slopus.happy.model.shouldShowFirstRunInstall
import com.slopus.happy.model.settings.LocalSettingsValues
import com.slopus.happy.model.shouldShowOfflineMachinesBanner
import com.slopus.happy.model.toFlatSessionRow
import com.slopus.happy.model.visibleSessionListItems
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.flow.stateIn
import java.time.LocalDate
import java.time.ZoneId

/** One row of the home list. [key] is stable across rebuilds; equal rows are the same instance. */
@Immutable
sealed interface HomeRow {
    val key: String

    /** A FlatSessionRow, live or (faded) archived. */
    data class Chat(val row: FlatSessionRowData, val showBorder: Boolean, val archived: Boolean = false) : HomeRow {
        override val key get() = "flat-session-${row.session.id}"
    }

    /** The divider that shows or hides the archive; [banded] in the flat list. */
    data class ArchiveToggle(val hidden: Boolean, val banded: Boolean) : HomeRow {
        override val key get() = "archive-toggle"
    }

    data class DayHeader(val title: DayTitle, val day: LocalDate) : HomeRow {
        override val key get() = "header-$day"
    }

    /** A row of the project hierarchy (ProjectHomeList). */
    data class Project(val row: ProjectHomeRow) : HomeRow {
        override val key get() = row.key
    }
}

/** The offline plaque: [machineName] when exactly one computer is linked. */
@Immutable
data class OfflineBanner(val machineName: String?)

/** What the home screen draws once the first read is in. */
@Immutable
data class HomeListState(
    val emptyState: HomeEmptyState,
    /** No computer linked: the link page takes the home over, even over sessions. */
    val showsInstallStep: Boolean = emptyState == HomeEmptyState.Link,
    val grouping: SessionListGrouping,
    val hasArchivedSessions: Boolean,
    val archiveHidden: Boolean,
    val rows: List<HomeRow>,
    val offlineBanner: OfflineBanner?,
    /** The linked computers' names, for the offline checklist. */
    val computers: List<String> = emptyList(),
    /** Grouped by project: each chat's checkout, whose chats the session screen shows as tabs. */
    val worktrees: Map<String, ProjectWorktree> = emptyMap(),
)

/** Everything one derivation reads. */
data class HomeListInputs(
    val snapshot: HomeSnapshot,
    val grouping: SessionListGrouping,
    val archiveHidden: Boolean,
    val expandedProjects: Set<String>,
    val unreadSessionIds: Set<String>,
    val archivingSessionIds: Set<String>,
)

/**
 * SessionsListWrapper, SessionsList and ProjectHomeList's data: the list
 * view data, the archive preference applied, then flattened into rows for
 * the chosen layout.
 */
fun deriveHomeList(inputs: HomeListInputs, zone: ZoneId, today: LocalDate): HomeListState {
    val snapshot = inputs.snapshot
    val machines = snapshot.machines.associateBy { it.id }
    val all = buildSessionListViewData(
        SessionListInputs(snapshot.sessions, machines, snapshot.projects, inputs.unreadSessionIds, inputs.archivingSessionIds, snapshot.gitStatuses),
        zone,
        today,
    )
    val visible = visibleSessionListItems(all, inputs.archiveHidden)
    val hasArchived = hasArchivedSessions(all)
    val choices = collectMachineChoices(snapshot.machines)
    val online = choices.count { it.online }
    val rows = when (inputs.grouping) {
        SessionListGrouping.Flat -> flatRows(visible, hasArchived, inputs.archiveHidden)
        SessionListGrouping.Project -> buildProjectHomeRows(visible, machines, "", inputs.expandedProjects, hasArchived, inputs.archiveHidden)
            .map(HomeRow::Project)
    }
    return HomeListState(
        emptyState = resolveHomeEmptyState(visible.size, hasArchived, choices.size, online),
        showsInstallStep = shouldShowFirstRunInstall(snapshot.machines.size),
        grouping = inputs.grouping,
        hasArchivedSessions = hasArchived,
        archiveHidden = inputs.archiveHidden,
        rows = rows,
        offlineBanner = if (shouldShowOfflineMachinesBanner(choices.size, online)) OfflineBanner(choices.singleOrNull()?.name) else null,
        computers = choices.map { it.name },
        worktrees = if (inputs.grouping == SessionListGrouping.Project) projectWorktreesBySession(all) else emptyMap(),
    )
}

/**
 * The flat list: live chats by recent activity, then the archive toggle in
 * the heading band, then the archive by day, each archived chat a faded row.
 */
private fun flatRows(visible: List<SessionListItem>, hasArchived: Boolean, archiveHidden: Boolean): List<HomeRow> {
    val archived = visible.filter { it is SessionListItem.Header || it is SessionListItem.SessionItem }
    val grouped = visible.filter { it !is SessionListItem.Header && it !is SessionListItem.SessionItem }
    val live = buildFlatSessionRows(grouped, sortByActivity = true)
    val rows = ArrayList<HomeRow>(live.size + archived.size + 1)
    live.forEachIndexed { index, row -> rows.add(HomeRow.Chat(row, showBorder = index != live.lastIndex)) }
    if (hasArchived) rows.add(HomeRow.ArchiveToggle(archiveHidden, banded = true))
    archived.forEachIndexed { index, item ->
        when (item) {
            is SessionListItem.Header -> rows.add(HomeRow.DayHeader(item.title, item.day))
            is SessionListItem.SessionItem ->
                rows.add(HomeRow.Chat(toFlatSessionRow(item.session), showBorder = index != archived.lastIndex, archived = true))
            else -> Unit
        }
    }
    return rows
}

/**
 * [next] with every row equal to one in [previous] replaced by that
 * instance, and the whole list kept when nothing changed, so Compose skips
 * every row but the ones that differ.
 */
fun reuseUnchanged(previous: HomeListState?, next: HomeListState): HomeListState {
    if (previous == null) return next
    if (previous == next) return previous
    val old = previous.rows.associateBy { it.key }
    val rows = next.rows.map { row -> old[row.key]?.takeIf { it == row } ?: row }
    return next.copy(rows = if (rows == previous.rows) previous.rows else rows)
}

/**
 * The home list, derived on [dispatcher] whenever an input changes and
 * diffed against the last one ([reuseUnchanged]). [state] is null until
 * a snapshot that is [HomeSnapshot.ready] is in.
 */
class HomeListModel(
    snapshots: Flow<HomeSnapshot?>,
    settings: Flow<Settings>,
    localSettings: Flow<LocalSettingsValues>,
    unreadSessionIds: Flow<Set<String>>,
    archivingSessionIds: Flow<Set<String>>,
    scope: CoroutineScope,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    zone: () -> ZoneId = ZoneId::systemDefault,
) {
    val state: StateFlow<HomeListState?> = combine(
        snapshots.filterNotNull().filter { it.ready },
        settings.map { it.sessionListGrouping to it.hideInactiveSessions }.distinctUntilChanged(),
        localSettings.map { values -> values.expandedProjects.filterValues { it }.keys }.distinctUntilChanged(),
        unreadSessionIds,
        archivingSessionIds,
    ) { snapshot, (grouping, archiveHidden), expanded, unread, archiving ->
        HomeListInputs(snapshot, grouping, archiveHidden, expanded, unread, archiving)
    }
        .distinctUntilChanged()
        .map { inputs ->
            val zoneId = zone()
            deriveHomeList(inputs, zoneId, LocalDate.now(zoneId))
        }
        .scan(null as HomeListState?) { previous, next -> reuseUnchanged(previous, next) }
        .filterNotNull()
        .distinctUntilChanged { a, b -> a === b }
        .flowOn(dispatcher)
        .stateIn(scope, SharingStarted.Eagerly, null)
}
