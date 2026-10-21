package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

// The home list's data, from happy-app sync/storage.ts (buildSessionRowData,
// buildSessionListViewData), hooks/useVisibleSessionListViewData.ts,
// utils/flatSessionList.ts and utils/flatSessionRowPresentation.ts.

/** One session as a list row shows it. Plain values only, so equal rows compare equal and the list can diff them. */
@Immutable
data class SessionRowData(
    val id: String,
    val botId: String? = null,
    val botUsername: String? = null,
    /** Null: "New chat". */
    val name: String? = null,
    /** Null: "unknown". */
    val subtitle: String? = null,
    val avatarId: String = id,
    val flavor: String? = null,
    val clientId: String? = null,
    val identityLine: String? = null,
    val providerKind: ProviderIconKind? = null,
    val modelName: String? = null,
    val activitySummary: String? = null,
    val gitChangedFiles: Long? = null,
    val gitCountsExact: Boolean = true,
    val gitDeletions: Long? = null,
    val gitInsertions: Long? = null,
    val gitBranch: String? = null,
    /** The daemon's working-tree count for the session's checkout ([GitStatus]), 0 until one is in. */
    val gitStatusLinesAdded: Long = 0,
    val gitStatusLinesRemoved: Long = 0,
    val state: SessionState = SessionState.Waiting,
    /** Only on inactive sessions: an active one's activeAt moves with every heartbeat. */
    val activeAt: Long? = null,
    val createdAt: Long = 0,
    val lastActivityAt: Long = 0,
    val hasDraft: Boolean = false,
    val active: Boolean = true,
    val archived: Boolean = false,
    val machineId: String? = null,
    val machineName: String? = null,
    /** Only when the session's machine is known to be offline; unknown machines count as online. */
    val machineOffline: Boolean = false,
    val path: String? = null,
    val homeDir: String? = null,
    val hasUnread: Boolean = false,
    val projectId: String? = null,
    val projectName: String? = null,
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val projectAvatarUri: String? = null,
    val projectAvatarThumbhash: String? = null,
    val avatarUri: String? = null,
    val avatarThumbhash: String? = null,
)

/** "Today", "Yesterday" or "N days ago" over an archived day (storage.ts relativeDayTitle). */
@Immutable
sealed interface DayTitle {
    data object Today : DayTitle
    data object Yesterday : DayTitle
    data class DaysAgo(val days: Long) : DayTitle
}

enum class ProjectSource { Rig, Happy }

/** storage.ts `SessionListViewItem`, as far as the phone builds it. */
@Immutable
sealed interface SessionListItem {
    data class Bots(val sessions: List<SessionRowData>) : SessionListItem
    data class Header(val title: DayTitle, val day: LocalDate) : SessionListItem
    data class ProjectsHeader(val source: ProjectSource) : SessionListItem
    data class ProjectItem(val source: ProjectSource, val project: ProjectGroupData) : SessionListItem
    data class SessionItem(val session: SessionRowData) : SessionListItem
}

/** What the list is built from: the store's sessions and machines plus the in-memory sets. */
data class SessionListInputs(
    val sessions: Collection<Session>,
    val machines: Map<String, Machine>,
    val projects: Map<String, Project> = emptyMap(),
    val unreadSessionIds: Set<String> = emptySet(),
    /** Chats archived on this device that no machine has confirmed yet: they leave the list on the press. */
    val archivingSessionIds: Set<String> = emptySet(),
    /** storage.ts pathGitStatus: by [gitStatusKey]. */
    val gitStatuses: Map<String, GitStatus> = emptyMap(),
)

/**
 * isSessionArchived: retired by the agent, being archived here, or a Happy
 * CLI session that has ended. A Rig session that only lost its connection
 * is still live work.
 */
fun Session.isArchived(archiving: Set<String>): Boolean =
    id in archiving || metadata?.lifecycleState == "archived" || (!metadata.isRig() && !active)

fun buildSessionRowData(session: Session, inputs: SessionListInputs): SessionRowData {
    val metadata = session.metadata
    val rigIdentity = metadata.rigIdentity()
    val rigActivity = metadata.rigActivityIndicators()
    val rigGit = metadata.rigGitSummary()
    val machineId = metadata?.machineId
    val machine = machineId?.let { inputs.machines[it] }
    val projectId = session.projectIdOrNull()
    val linkedProject = projectId?.let { inputs.projects[it] }
    val projectAvatar = if (session.isHappyAgent()) linkedProject?.avatar else null
    val avatar = session.resolveAvatar(inputs.projects)
    val gitStatus = gitStatusKey(machineId, metadata?.path)?.let { inputs.gitStatuses[it] }
    return SessionRowData(
        id = session.id,
        botId = metadata?.bot?.id,
        botUsername = metadata?.bot?.username,
        name = session.displayName(),
        subtitle = session.displaySubtitle(),
        avatarId = session.avatarId(),
        flavor = metadata?.flavor,
        clientId = metadata?.client?.id,
        identityLine = rigIdentity?.let { "${it.clientName} · ${it.providerName}" },
        providerKind = rigIdentity?.providerKind ?: metadata?.provider?.kind?.let(::providerIconKind),
        modelName = rigIdentity?.modelName,
        activitySummary = rigActivity.takeIf { it.isNotEmpty() }?.joinToString(" · ") {
            "${it.count}${if (it.queued != null && it.queued != 0L) "+${it.queued}" else ""} ${it.key}"
        },
        gitChangedFiles = rigGit?.changedFiles,
        gitCountsExact = rigGit?.countsExact ?: true,
        gitDeletions = rigGit?.deletions,
        gitInsertions = rigGit?.insertions,
        gitBranch = metadata?.gitBranch,
        gitStatusLinesAdded = gitStatus?.linesAdded ?: 0,
        gitStatusLinesRemoved = gitStatus?.linesRemoved ?: 0,
        state = session.state,
        activeAt = if (!session.active) session.activeAt else null,
        createdAt = session.createdAt,
        lastActivityAt = session.activityAt(),
        hasDraft = !session.draft.isNullOrEmpty(),
        active = session.active,
        archived = session.isArchived(inputs.archivingSessionIds),
        machineId = machineId,
        machineName = machine?.metadata?.displayName?.takeIf { it.isNotEmpty() }
            ?: machine?.metadata?.host?.takeIf { it.isNotEmpty() }
            ?: metadata?.host?.takeIf { it.isNotEmpty() },
        machineOffline = machine != null && !machine.isOnline,
        path = metadata?.path,
        homeDir = metadata?.homeDir,
        hasUnread = session.id in inputs.unreadSessionIds,
        projectId = projectId,
        projectName = linkedProject?.name ?: metadata?.project?.name,
        workspaceId = metadata?.workspace?.id,
        workspaceName = metadata?.workspace?.name,
        projectAvatarUri = projectAvatar?.uri?.takeIf { it.isNotEmpty() },
        projectAvatarThumbhash = projectAvatar?.thumbhash?.takeIf { it.isNotEmpty() },
        avatarUri = avatar?.uri?.takeIf { it.isNotEmpty() },
        avatarThumbhash = avatar?.thumbhash?.takeIf { it.isNotEmpty() },
    )
}

/** relativeDayTitle; a DST day is 23 or 25 hours, so whole calendar days are counted. */
fun relativeDayTitle(timestamp: Long, today: LocalDate, zone: ZoneId): DayTitle {
    val day = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
    val diff = ChronoUnit.DAYS.between(day, today)
    return when {
        diff <= 0 -> DayTitle.Today
        diff == 1L -> DayTitle.Yesterday
        else -> DayTitle.DaysAgo(diff)
    }
}

/**
 * buildSessionListViewData: bots, then Rig projects, then Happy CLI
 * projects, then the archive as a flat tail split by day. Side chats never
 * appear. Projects sort active first, then by last activity, which keys off
 * the last meaningful message, not updatedAt, so streaming sessions do not
 * make the list jump.
 */
fun buildSessionListViewData(
    inputs: SessionListInputs,
    zone: ZoneId = ZoneId.systemDefault(),
    today: LocalDate = LocalDate.now(zone),
): List<SessionListItem> {
    val rigProjectSessions = mutableListOf<Session>()
    val botSessions = mutableListOf<Session>()
    val rigPathSessions = mutableListOf<Session>()
    val happySessions = mutableListOf<Session>()
    val archivedSessions = mutableListOf<Session>()

    for (session in inputs.sessions) {
        if (session.metadata?.isSideChat == true) continue
        when {
            session.isArchived(inputs.archivingSessionIds) -> archivedSessions.add(session)
            session.metadata?.bot != null -> botSessions.add(session)
            session.metadata.isRig() -> if (session.isProjectSession()) rigProjectSessions.add(session) else rigPathSessions.add(session)
            else -> happySessions.add(session)
        }
    }

    val projectOrder = compareByDescending<Session> { it.active }.thenByDescending { it.activityAt() }
    rigProjectSessions.sortWith(projectOrder)
    rigPathSessions.sortWith(projectOrder)
    happySessions.sortWith(projectOrder)
    archivedSessions.sortByDescending { it.activityAt() }

    val toRow = { session: Session -> buildSessionRowData(session, inputs) }
    val isActive = { session: Session -> session.active }
    val items = mutableListOf<SessionListItem>()

    if (botSessions.isNotEmpty()) {
        botSessions.sortWith { a, b ->
            val machineOrder = (a.metadata?.machineId ?: "").compareTo(b.metadata?.machineId ?: "")
            if (machineOrder != 0) return@sortWith machineOrder
            val aKey = a.metadata!!.bot!!.orderKey
            val bKey = b.metadata!!.bot!!.orderKey
            if (aKey != bKey) aKey.compareTo(bKey) else a.id.compareTo(b.id)
        }
        items.add(SessionListItem.Bots(botSessions.map(toRow)))
    }

    val rigProjects = buildProjectGroups(rigProjectSessions, toRow, isActive) +
        buildPathProjectGroups(rigPathSessions, toRow, isActive, "rig")
    if (rigProjects.isNotEmpty()) {
        items.add(SessionListItem.ProjectsHeader(ProjectSource.Rig))
        rigProjects.forEach { items.add(SessionListItem.ProjectItem(ProjectSource.Rig, it)) }
    }

    val happyProjects = buildPathProjectGroups(happySessions, toRow, isActive, "happy")
    if (happyProjects.isNotEmpty()) {
        items.add(SessionListItem.ProjectsHeader(ProjectSource.Happy))
        happyProjects.forEach { items.add(SessionListItem.ProjectItem(ProjectSource.Happy, it)) }
    }

    var currentDay: LocalDate? = null
    for (session in archivedSessions) {
        val timestamp = session.activityAt()
        val day = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
        if (day != currentDay) {
            currentDay = day
            items.add(SessionListItem.Header(relativeDayTitle(timestamp, today, zone), day))
        }
        items.add(SessionListItem.SessionItem(toRow(session)))
    }
    return items
}

/**
 * useVisibleSessionListViewData: the archive-visibility preference applied.
 * The rule is `archived`, never `!active`. A date heading is held back until
 * a row under it survives, so hiding the archive never leaves an empty heading.
 */
fun visibleSessionListItems(items: List<SessionListItem>, hideArchived: Boolean): List<SessionListItem> {
    val visibleProjects = HashMap<Int, SessionListItem.ProjectItem>()
    val visibleSources = HashSet<ProjectSource>()
    items.forEachIndexed { index, item ->
        if (item !is SessionListItem.ProjectItem) return@forEachIndexed
        val project = if (hideArchived) item.project.filterSessions { !it.archived } else item.project
        if (project != null) {
            visibleProjects[index] = item.copy(project = project)
            visibleSources.add(item.source)
        }
    }

    val result = mutableListOf<SessionListItem>()
    items.forEachIndexed { index, item ->
        when (item) {
            is SessionListItem.ProjectsHeader -> if (item.source in visibleSources) result.add(item)
            is SessionListItem.ProjectItem -> visibleProjects[index]?.let(result::add)
            is SessionListItem.Bots -> result.add(item)
            else -> Unit
        }
    }

    var pendingHeader: SessionListItem.Header? = null
    for (item in items) {
        if (item is SessionListItem.Header) {
            pendingHeader = item
            continue
        }
        if (item !is SessionListItem.SessionItem) continue
        if (hideArchived && item.session.archived) continue
        pendingHeader?.let(result::add)
        pendingHeader = null
        result.add(item)
    }
    return result
}

/** useHasArchivedSessions: whether the archive toggle would change anything. */
fun hasArchivedSessions(items: List<SessionListItem>): Boolean = items.any { item ->
    when (item) {
        is SessionListItem.ProjectItem -> item.project.workspaces.any { w -> w.sessions.any { it.archived } }
        is SessionListItem.SessionItem -> item.session.archived
        else -> false
    }
}

/** utils/flatSessionList.ts: one session with its project and worktree spelled out on the row. */
@Immutable
data class FlatSessionRowData(
    val session: SessionRowData,
    val projectName: String,
    /** Null in a project's primary checkout. */
    val workspaceName: String?,
)

/**
 * buildFlatSessionRows: the project cards flattened back into one list,
 * active first, then most recent. Archived rows and their headings are left
 * out: they are a separate tail the caller appends.
 */
fun buildFlatSessionRows(items: List<SessionListItem>, sortByActivity: Boolean): List<FlatSessionRowData> {
    val rows = mutableListOf<FlatSessionRowData>()
    for (item in items) {
        when (item) {
            is SessionListItem.Bots -> item.sessions.forEach { rows.add(toFlatSessionRow(it)) }
            is SessionListItem.ProjectItem -> for (workspace in item.project.workspaces) {
                for (session in workspace.sessions) {
                    rows.add(FlatSessionRowData(session, item.project.name, workspace.name ?: workspace.id.ifEmpty { null }))
                }
            }
            else -> Unit
        }
    }
    val key: (FlatSessionRowData) -> Long = if (sortByActivity) { r -> r.session.lastActivityAt } else { r -> r.session.createdAt }
    return rows.sortedWith(compareByDescending<FlatSessionRowData> { it.session.active }.thenByDescending(key))
}

/** toFlatSessionRow: a row outside any project card placed by the same worktree rule the cards use. */
fun toFlatSessionRow(session: SessionRowData): FlatSessionRowData {
    if (session.botId != null) return FlatSessionRowData(session, "@${session.botUsername ?: ""}", null)
    val path = session.path?.trim().orEmpty()
    val worktree = WorktreePaths.isWorktree(path)
    val projectPath = if (worktree) WorktreePaths.repoPath(path) else path
    return FlatSessionRowData(
        session = session,
        projectName = session.projectName ?: projectPath.split(Regex("[\\\\/]")).lastOrNull { it.isNotEmpty() } ?: "",
        workspaceName = session.workspaceName ?: if (worktree) WorktreePaths.worktreeName(path) else null,
    )
}

/** flatSessionRowPresentation.ts: the corner shows a dot only for something to notice. */
sealed interface FlatRowTopRight {
    data object Timestamp : FlatRowTopRight
    /** [blocked]: orange (#FF9500) for a permission or question; else blue (#007AFF), results ready. */
    data class Dot(val blocked: Boolean) : FlatRowTopRight
}

data class FlatRowPresentation(val shimmerTitle: Boolean, val topRight: FlatRowTopRight)

/**
 * resolveFlatSessionRowPresentation: active work shimmers the title; only
 * something the user should notice replaces the timestamp with a dot.
 */
fun resolveFlatRowPresentation(state: SessionState, hasUnread: Boolean, faded: Boolean): FlatRowPresentation = when {
    faded -> FlatRowPresentation(false, FlatRowTopRight.Timestamp)
    state == SessionState.PermissionRequired || state == SessionState.InputRequired ->
        FlatRowPresentation(false, FlatRowTopRight.Dot(blocked = true))
    state == SessionState.Thinking -> FlatRowPresentation(true, FlatRowTopRight.Timestamp)
    hasUnread -> FlatRowPresentation(false, FlatRowTopRight.Dot(blocked = false))
    else -> FlatRowPresentation(false, FlatRowTopRight.Timestamp)
}
