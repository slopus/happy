package com.slopus.happy.ui.tablet

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.model.compactCount
import com.slopus.happy.model.toFlatSessionRow
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.chat.VibingMessages
import com.slopus.happy.ui.chat.formatLastSeen
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.AvatarBadgeLocation
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ProviderIcon
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.home.ArchiveToggleRow
import com.slopus.happy.ui.home.DayHeaderRow
import com.slopus.happy.ui.home.FlatSessionRow
import com.slopus.happy.ui.home.HomeBanners
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.home.HomeSpec
import com.slopus.happy.ui.home.HomeUpdate
import com.slopus.happy.ui.home.OfflineBanner
import com.slopus.happy.ui.home.SwipeToArchive
import com.slopus.happy.ui.home.gitAddedColor
import com.slopus.happy.ui.home.gitRemovedColor
import com.slopus.happy.ui.home.sessionPressDown
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object TabletGroupedTags {
    const val LIST = "tabletGrouped.list"
    const val BOTS = "tabletGrouped.bots"
    const val MACHINE = "tabletGrouped.machine"
    const val MACHINE_NAME = "tabletGrouped.machineName"
    const val CHECKOUT = "tabletGrouped.checkout"
    const val BRANCH = "tabletGrouped.branch"
    const val GIT = "tabletGrouped.git"
    const val ADD = "tabletGrouped.add"
    const val CARD = "tabletGrouped.card"
    const val COMPACT_ROW = "tabletGrouped.compactRow"
    const val INDICATOR = "tabletGrouped.indicator"
    const val ARCHIVED = "tabletGrouped.archived"
    const val ARCHIVED_STATUS = "tabletGrouped.archivedStatus"
}

/** SessionsList.tsx, ProjectGroup.tsx and ActiveSessionsGroupCompact.tsx's CompactSessionRow on Android. */
object TabletGroupedSpec {
    // SessionsList headerSection and MachineHeader.
    val machinePaddingHorizontal = 24.dp
    val machinePaddingTop = 8.dp
    val machineIcon = 11.dp
    val machineIconGap = 6.dp
    val machineTextGap = 4.dp
    val machine = happyTextStyle(fontSize = 11)
    const val MACHINE_NAME_MAX_FRACTION = 0.6f

    // ProjectGroup's WorkspaceSection.
    val headingPaddingTop = 12.dp
    val headingPaddingBottom = 8.dp
    val headingPaddingStart = 16.dp
    val headingPaddingEnd = 22.dp
    val headingGap = 8.dp
    val headingAvatar = 30.dp
    val branchGap = 6.dp
    val addButton = 30.dp
    val addIcon = 18.dp
    val projectGap = 4.dp
    val cardMarginHorizontal = 12.dp
    val cardMarginBottom = 8.dp
    val cardRadius = 18.dp
    val projectTitle = happyTextStyle(fontSize = 14, lineHeight = 20, letterSpacing = 0.1f, weight = FontWeight.Medium)
    val branch = happyTextStyle(fontSize = 12, lineHeight = 16)
    val gitCount = happyTextStyle(fontSize = 11, weight = FontWeight.SemiBold)

    // CompactSessionRow.
    val compactHeight = 56.dp
    val compactPaddingHorizontal = 16.dp
    val indicatorSlot = 18.dp
    val indicatorGap = 8.dp
    val draftIcon = 14.dp
    val compactTitle = happyTextStyle(fontSize = 15)

    // SessionItem.
    val itemHeight = 88.dp
    val itemMarginHorizontal = 16.dp
    val itemGap = 1.dp
    val itemGroupGap = 12.dp
    val itemRadius = 12.dp
    val itemPaddingHorizontal = 16.dp
    val itemAvatar = 48.dp
    val itemContentGap = 16.dp
    val itemDraftBox = 18.dp
    val itemDraftIcon = 12.dp
    val itemDraftOffset = 2.dp
    val itemProviderIcon = 13.dp
    val itemTitle = happyTextStyle(fontSize = 15, weight = FontWeight.SemiBold)
    val itemSubtitle = happyTextStyle(fontSize = 13)
    val itemStatus = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.Medium)
    val itemStatusDotBox = 16.dp
}

/** What the grouped rows do beyond the shared row callbacks. */
@Immutable
class TabletGroupedActions(
    /** CompactSessionRow's swipe: `sessionKill`, nothing more. */
    val onStop: (sessionId: String) -> Unit,
    /** WorkspaceSection's "+": the new-session draft points at that checkout. */
    val onNewInCheckout: (SessionRowData?) -> Unit,
)

/**
 * SessionsList.tsx's FlatList when it is not flat, on the grouped
 * background: the banners, then [rows], then [bottomSpacer]. The open chat
 * ([selectedSessionId]) is marked wherever it appears.
 */
@Composable
fun TabletGroupedList(
    rows: List<TabletGroupedRow>,
    offlineBanner: OfflineBanner?,
    update: HomeUpdate?,
    callbacks: HomeListCallbacks,
    actions: HomeScreenActions,
    grouped: TabletGroupedActions,
    selectedSessionId: String?,
    bottomSpacer: @Composable () -> Unit,
    stopping: Set<String> = emptySet(),
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(HappyTheme.colors.grouped.background)
            .testTag(TabletGroupedTags.LIST),
        contentPadding = PaddingValues(0.dp),
    ) {
        if (offlineBanner != null || update != null) {
            item(key = "banners", contentType = "banners") { HomeBanners(offlineBanner, update, actions) }
        }
        items(rows, key = { it.key }, contentType = { it::class }) { row ->
            when (row) {
                is TabletGroupedRow.Bots -> BotsSection(row.sessions, callbacks, selectedSessionId)
                is TabletGroupedRow.MachineHeader -> MachineRule(row.machineId, row.machineName, callbacks)
                is TabletGroupedRow.Checkout -> CheckoutSection(row, callbacks, grouped, selectedSessionId, stopping)
                is TabletGroupedRow.ArchiveToggle -> ArchiveToggleRow(row.hidden, banded = false, callbacks)
                is TabletGroupedRow.DayHeader -> DayHeaderRow(row.title, flat = false)
                is TabletGroupedRow.ArchivedSession ->
                    ArchivedSessionCard(row.session, row.first, row.last, row.session.id == selectedSessionId, callbacks)
            }
        }
        item(key = "bottom", contentType = "bottom") { bottomSpacer() }
    }
}

/** SessionsList's "bots" item: "Bots" in the section band, then each bot as a flat row. */
@Composable
private fun BotsSection(sessions: List<SessionRowData>, callbacks: HomeListCallbacks, selectedSessionId: String?) {
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxWidth().testTag(TabletGroupedTags.BOTS)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.grouped.background)
                .padding(
                    start = HomeSpec.sectionPaddingHorizontal,
                    end = HomeSpec.sectionPaddingHorizontal,
                    top = HomeSpec.sectionPaddingTop,
                    bottom = HomeSpec.sectionPaddingBottom,
                ),
        ) {
            // SessionsList spells it out in English.
            Text("Bots", style = HomeSpec.sectionHeader, color = colors.grouped.sectionTitle)
        }
        sessions.forEachIndexed { index, session ->
            FlatSessionRow(
                row = remember(session) { toFlatSessionRow(session) },
                showBorder = index < sessions.lastIndex,
                archived = false,
                callbacks = callbacks,
                selected = session.id == selectedSessionId,
            )
        }
    }
}

/**
 * MachineHeader: a hairline, the 11 desktop glyph 6 either side, the name
 * (11, secondary, at most 60% of the row, 4 before the second hairline);
 * 24 in, 8 above. A tap opens the computer.
 */
@Composable
private fun MachineRule(machineId: String?, machineName: String, callbacks: HomeListCallbacks) {
    val colors = HappyTheme.colors
    val line = hairline()
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(TabletGroupedTags.MACHINE)
            .then(if (machineId != null) Modifier.clickable(role = Role.Button) { callbacks.onOpenMachine(machineId) } else Modifier)
            .padding(
                start = TabletGroupedSpec.machinePaddingHorizontal,
                end = TabletGroupedSpec.machinePaddingHorizontal,
                top = TabletGroupedSpec.machinePaddingTop,
            ),
    ) {
        val nameMax = maxWidth * TabletGroupedSpec.MACHINE_NAME_MAX_FRACTION
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(line).background(colors.divider))
            Icon(
                Ionicon.DesktopOutline,
                size = TabletGroupedSpec.machineIcon,
                color = colors.textSecondary,
                modifier = Modifier.padding(horizontal = TabletGroupedSpec.machineIconGap),
            )
            Text(
                text = machineName,
                style = TabletGroupedSpec.machine,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(end = TabletGroupedSpec.machineTextGap)
                    .widthIn(max = nameMax)
                    .testTag(TabletGroupedTags.MACHINE_NAME),
            )
            Box(Modifier.weight(1f).height(line).background(colors.divider))
        }
    }
}

/**
 * ProjectGroup's WorkspaceSection: the first chat's face (30), the project
 * (14/20 medium, section title colour) over its branch (12/16) and line
 * counts, and a 30 filled "+" whose centre lines up with the card's status
 * dots; padded 12/8, 16 in and 22 from the end. Under it a card (surface,
 * hairline, radius 18, 12 in, 8 below) of [CompactSessionRow]s.
 */
@Composable
private fun CheckoutSection(
    row: TabletGroupedRow.Checkout,
    callbacks: HomeListCallbacks,
    grouped: TabletGroupedActions,
    selectedSessionId: String?,
    stopping: Set<String>,
) {
    val colors = HappyTheme.colors
    val first = row.workspace.sessions.firstOrNull()
    val cardShape = RoundedCornerShape(TabletGroupedSpec.cardRadius)
    val newSessionLabel = stringResource(R.string.sidebar_new_session)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(TabletGroupedTags.CHECKOUT)
            .padding(bottom = if (row.lastOfProject) TabletGroupedSpec.projectGap else 0.dp),
    ) {
        Row(
            modifier = Modifier.padding(
                start = TabletGroupedSpec.headingPaddingStart,
                end = TabletGroupedSpec.headingPaddingEnd,
                top = TabletGroupedSpec.headingPaddingTop,
                bottom = TabletGroupedSpec.headingPaddingBottom,
            ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TabletGroupedSpec.headingGap),
        ) {
            if (first != null) {
                Avatar(id = first.avatarId, size = TabletGroupedSpec.headingAvatar, imageUri = first.projectAvatarUri, thumbhash = first.projectAvatarThumbhash)
            }
            Column(Modifier.weight(1f)) {
                Text(
                    text = row.projectName,
                    style = TabletGroupedSpec.projectTitle,
                    color = colors.grouped.sectionTitle,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TabletGroupedSpec.branchGap)) {
                    Text(
                        text = row.branch ?: "main",
                        style = TabletGroupedSpec.branch,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).testTag(TabletGroupedTags.BRANCH),
                    )
                    row.changes?.let { LineChanges(it) }
                }
            }
            Box(
                modifier = Modifier
                    .testTag(TabletGroupedTags.ADD)
                    .size(TabletGroupedSpec.addButton)
                    .clip(CircleShape)
                    .background(colors.surfaceHighest)
                    .clickable(role = Role.Button) { grouped.onNewInCheckout(first) }
                    .semantics { contentDescription = newSessionLabel },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.Add, size = TabletGroupedSpec.addIcon, color = colors.text)
            }
        }
        Column(
            modifier = Modifier
                .padding(horizontal = TabletGroupedSpec.cardMarginHorizontal)
                .padding(bottom = TabletGroupedSpec.cardMarginBottom)
                .fillMaxWidth()
                .testTag(TabletGroupedTags.CARD)
                .clip(cardShape)
                .background(colors.surface)
                .border(hairline(), colors.divider, cardShape),
        ) {
            row.workspace.sessions.forEachIndexed { index, session ->
                CompactSessionRow(
                    session = session,
                    selected = session.id == selectedSessionId,
                    showBorder = index < row.workspace.sessions.lastIndex,
                    callbacks = callbacks,
                    stopping = session.id in stopping,
                    onStop = grouped.onStop,
                )
            }
        }
    }
}

/** GitLineChanges: ≈ when approximate, +insertions, -deletions, 11 semibold, 4 apart. */
@Composable
private fun LineChanges(changes: VisibleGitChanges) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier.testTag(TabletGroupedTags.GIT),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (changes.approximate) Text("≈", style = TabletGroupedSpec.gitCount.copy(fontWeight = FontWeight.Normal), color = colors.textSecondary)
        if (changes.insertions > 0) Text("+${compactCount(changes.insertions)}", style = TabletGroupedSpec.gitCount, color = gitAddedColor(colors))
        if (changes.deletions > 0) Text("-${compactCount(changes.deletions)}", style = TabletGroupedSpec.gitCount, color = gitRemovedColor(colors))
    }
}

/** SessionsList's STATUS_CONFIG, with a quiet unread result in blue. */
private data class RowStatus(val color: Color, val pulsing: Boolean, val connected: Boolean)

private fun rowStatus(session: SessionRowData): RowStatus {
    val base = when (session.state) {
        SessionState.Disconnected -> RowStatus(SessionStatusColors.disconnected, pulsing = false, connected = false)
        SessionState.Thinking -> RowStatus(SessionStatusColors.thinking, pulsing = true, connected = true)
        SessionState.Waiting -> RowStatus(SessionStatusColors.online, pulsing = false, connected = true)
        SessionState.PermissionRequired, SessionState.InputRequired -> RowStatus(SessionStatusColors.attention, pulsing = true, connected = true)
    }
    // User action stays orange and pulsing even when the request also marked the session unread.
    return if (session.hasUnread && !session.needsUserAction()) base.copy(color = SessionStatusColors.thinking, pulsing = false) else base
}

private fun SessionRowData.needsUserAction() = state == SessionState.PermissionRequired || state == SessionState.InputRequired

/**
 * CompactSessionRow: 56 tall on the card's surface, 16 in; the name (15,
 * two lines at most, secondary once disconnected) and an 18 slot 8 after it
 * for the dot: pulsing orange for a request, blue for a result, the draft
 * glyph on an idle chat with one, pulsing blue while thinking, a grey dot
 * while idle. Swiping uncovers Archive, which only stops the agent.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CompactSessionRow(
    session: SessionRowData,
    selected: Boolean,
    showBorder: Boolean,
    callbacks: HomeListCallbacks,
    stopping: Boolean,
    onStop: (String) -> Unit,
) {
    val colors = HappyTheme.colors
    val status = rowStatus(session)
    SwipeToArchive(enabled = !stopping, onArchive = { onStop(session.id) }) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(TabletGroupedSpec.compactHeight)
                .testTag(TabletGroupedTags.COMPACT_ROW)
                .background(if (selected) colors.surfaceSelected else colors.surface)
                .then(if (selected) Modifier.semantics { this.selected = true } else Modifier)
                .sessionPressDown(session.id, callbacks)
                .combinedClickable(onClick = { callbacks.onOpen(session.id) }, onLongClick = { callbacks.onMenu(session.id) }),
        ) {
            Row(
                modifier = Modifier.align(Alignment.CenterStart).padding(horizontal = TabletGroupedSpec.compactPaddingHorizontal),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = session.name ?: stringResource(R.string.session_new_chat),
                    style = TabletGroupedSpec.compactTitle,
                    color = if (status.connected) colors.text else colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    modifier = Modifier
                        .padding(start = TabletGroupedSpec.indicatorGap)
                        .size(TabletGroupedSpec.indicatorSlot)
                        .testTag(TabletGroupedTags.INDICATOR),
                    contentAlignment = Alignment.Center,
                ) {
                    when {
                        session.needsUserAction() -> StatusDot(status.color, pulsing = status.pulsing)
                        session.hasUnread -> StatusDot(status.color)
                        session.state == SessionState.Waiting && session.hasDraft ->
                            Icon(Ionicon.CreateOutline, size = TabletGroupedSpec.draftIcon, color = colors.textSecondary)
                        session.state == SessionState.Thinking -> StatusDot(status.color, pulsing = status.pulsing)
                        session.state == SessionState.Waiting -> StatusDot(colors.textSecondary)
                    }
                }
            }
            if (showBorder) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(hairline()).background(colors.divider))
            }
        }
    }
}

/**
 * SessionsList's SessionItem, the archive's card: 88 tall, 16 in, a 48
 * avatar (grey when disconnected, the draft glyph at its corner) 16 before
 * the name (15 semibold), the provider and identity, the folder or the
 * subtitle (13, secondary), and the status line (12/16 medium in the
 * status colour, after a 6 dot): model · status · activity. Cards of one
 * day stack 1 apart on a hairline, rounded 12 at the ends, 12 after the last.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ArchivedSessionCard(
    session: SessionRowData,
    first: Boolean,
    last: Boolean,
    selected: Boolean,
    callbacks: HomeListCallbacks,
) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val status = rowStatus(session)
    val radius = TabletGroupedSpec.itemRadius
    val shape = RoundedCornerShape(
        topStart = if (first) radius else 0.dp,
        topEnd = if (first) radius else 0.dp,
        bottomStart = if (last) radius else 0.dp,
        bottomEnd = if (last) radius else 0.dp,
    )
    val vibing = remember(session.state) { VibingMessages.random().lowercase() + "…" }
    val statusText = when {
        session.state == SessionState.InputRequired -> stringResource(R.string.status_input_required)
        session.state == SessionState.PermissionRequired -> stringResource(R.string.status_permission_required)
        session.hasUnread -> stringResource(R.string.status_unread)
        session.state == SessionState.Thinking -> vibing
        session.state == SessionState.Disconnected ->
            stringResource(R.string.status_last_seen, formatLastSeen(resources, session.activeAt ?: 0L, System.currentTimeMillis()))
        else -> stringResource(R.string.status_online)
    }
    val line = buildString {
        session.modelName?.let { append(it).append(" · ") }
        append(statusText)
        session.activitySummary?.let { append(" · ").append(it) }
    }
    Row(
        modifier = Modifier
            .padding(horizontal = TabletGroupedSpec.itemMarginHorizontal)
            .padding(bottom = if (last) TabletGroupedSpec.itemGroupGap else TabletGroupedSpec.itemGap)
            .fillMaxWidth()
            .height(TabletGroupedSpec.itemHeight)
            .testTag(TabletGroupedTags.ARCHIVED)
            .clip(shape)
            .background(if (selected) colors.surfaceSelected else colors.surface)
            .border(hairline(), colors.divider, shape)
            .then(if (selected) Modifier.semantics { this.selected = true } else Modifier)
            .sessionPressDown(session.id, callbacks)
                .combinedClickable(onClick = { callbacks.onOpen(session.id) }, onLongClick = { callbacks.onMenu(session.id) })
            .padding(horizontal = TabletGroupedSpec.itemPaddingHorizontal),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(TabletGroupedSpec.itemAvatar)) {
            Avatar(
                id = session.avatarId,
                size = TabletGroupedSpec.itemAvatar,
                bot = session.botId != null,
                monochrome = !status.connected,
                flavor = session.flavor,
                clientId = session.clientId,
                badgeLocation = AvatarBadgeLocation.SessionList,
                imageUri = session.avatarUri,
                thumbhash = session.avatarThumbhash,
            )
            if (session.hasDraft) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = TabletGroupedSpec.itemDraftOffset, y = TabletGroupedSpec.itemDraftOffset)
                        .size(TabletGroupedSpec.itemDraftBox),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Ionicon.CreateOutline, size = TabletGroupedSpec.itemDraftIcon, color = colors.textSecondary)
                }
            }
        }
        Column(Modifier.padding(start = TabletGroupedSpec.itemContentGap).weight(1f)) {
            Text(
                text = session.name ?: stringResource(R.string.session_new_chat),
                style = TabletGroupedSpec.itemTitle,
                color = if (status.connected) colors.text else colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 2.dp),
            )
            // A path names its last folder, even when that leaves nothing to show.
            val folder = session.path?.takeIf { it.isNotEmpty() }?.let { path -> path.split('/', '\\').lastOrNull { it.isNotEmpty() }.orEmpty() }
            Row(
                modifier = Modifier.padding(bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (session.identityLine != null) ProviderIcon(session.providerKind, size = TabletGroupedSpec.itemProviderIcon)
                Text(
                    text = session.identityLine
                        ?: folder
                        ?: if (session.botId != null) toFlatSessionRow(session).projectName else session.subtitle ?: stringResource(R.string.status_unknown),
                    style = TabletGroupedSpec.itemSubtitle,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.padding(top = 2.dp, end = 4.dp).height(TabletGroupedSpec.itemStatusDotBox),
                    contentAlignment = Alignment.Center,
                ) {
                    StatusDot(status.color, pulsing = status.pulsing)
                }
                Text(
                    text = line,
                    style = TabletGroupedSpec.itemStatus,
                    color = status.color,
                    modifier = Modifier.testTag(TabletGroupedTags.ARCHIVED_STATUS),
                )
            }
        }
    }
}
