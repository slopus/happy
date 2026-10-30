package com.slopus.happy.ui.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.DayTitle
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderIconButton
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MenuGroup
import com.slopus.happy.ui.components.MenuOption
import com.slopus.happy.ui.components.SettingsMenu
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HomeTags {
    const val SETTINGS = "home.settings"
    const val COMPOSE = "home.compose"
    const val TITLE = "home.title"
    const val STATUS = "home.status"
    const val LOADING = "home.loading"
    /** Home's empty state with no computer linked: Make art and Scan QR code, under the usual header. */
    const val LINK = "home.link"
    /** The tablet detail with no session open: blank, as MainView.tsx leaves it. */
    const val TABLET_BLANK = "home.tabletBlank"
    const val LIST = "home.list"
    const val ARCHIVE_TOGGLE = "home.archiveToggle"
    const val DAY_HEADER = "home.dayHeader"
    const val EMPTY = "home.empty"
    const val SHOW_ARCHIVED = "home.showArchived"
}

/** MainView.tsx and SessionsList.tsx on a phone. */
object HomeSpec {
    val actionButton = 44.dp
    val actionIcon = 22.dp
    val status = happyTextStyle(fontSize = 11, lineHeight = 16, weight = FontWeight.Medium)
    val statusDot = 6.dp
    val statusDotGap = 4.dp

    /** The content starts 12 below the header (topContentInset). */
    val contentTop = 12.dp
    val sectionHeader = happyTextStyle(fontSize = 14, letterSpacing = 0.1f, weight = FontWeight.SemiBold)
    val sectionPaddingTop = 20.dp
    val sectionPaddingBottom = 8.dp
    val flatSectionPaddingHorizontal = 16.dp
    val sectionPaddingHorizontal = 24.dp
    val archiveToggleGap = 12.dp
    val archiveToggleText = happyTextStyle(fontSize = 14)
    val archiveTogglePaddingTop = 20.dp
    val archiveTogglePaddingBottom = 12.dp
    val bandedTogglePaddingTop = 24.dp
    val bandedTogglePaddingBottom = 8.dp
}

/** Everything the home screen asks of the app. */
@Immutable
class HomeScreenActions(
    val onSettings: () -> Unit,
    val onNewSession: () -> Unit,
    val onTroubleshoot: () -> Unit,
    val onOpenUrl: (String) -> Unit,
    val onWhatsNew: () -> Unit,
    val onSwitchAccount: (String) -> Unit = {},
    /** Links a computer from the empty home: the terminal scan Settings uses, approved with this account. */
    val onLinkComputer: () -> Unit = {},
)

/**
 * Signed in, on a phone. Home is always home: the header (account menu;
 * the connection status always centred; settings and compose), the account menu and
 * the composer are there whether or not a computer is linked, and whatever the
 * account already lists stays listed. Under the header: the loading spinner,
 * the link state (no computer and nothing to list: what's missing and the way
 * to link one, never a takeover), the no-sessions state, [offlineContent] (the onboarding's
 * offline checklist, given the computers' names) or the list: the banners,
 * then the flat chat list or the project hierarchy. The [dock] rests over
 * the bottom of all of these and, focused, covers the whole screen.
 */
@Composable
fun HomeScreen(
    state: HomeListState?,
    connectionStatus: ConnectionStatus,
    grouping: SessionListGrouping,
    callbacks: HomeListCallbacks,
    actions: HomeScreenActions,
    modifier: Modifier = Modifier,
    update: HomeUpdate? = null,
    offlineContent: @Composable (computers: List<String>, onShowArchived: (() -> Unit)?) -> Unit = { _, _ -> },
    dock: HomeDockState? = null,
    dockActions: HomeDockActions? = null,
    accounts: AccountMenu = AccountMenu(),
    listState: LazyListState = rememberLazyListState(),
    syncing: Boolean = false,
) {
    Box(modifier = modifier.fillMaxSize()) {
        HomeContent(state, connectionStatus, accounts, callbacks, actions, update, offlineContent, dock, dockActions, listState, syncing)
        if (dock != null && dockActions != null && dock.focused) HomeDockFocus(dock, dockActions)
    }
}

@Composable
private fun HomeContent(
    state: HomeListState?,
    connectionStatus: ConnectionStatus,
    accounts: AccountMenu,
    callbacks: HomeListCallbacks,
    actions: HomeScreenActions,
    update: HomeUpdate?,
    offlineContent: @Composable (computers: List<String>, onShowArchived: (() -> Unit)?) -> Unit,
    dock: HomeDockState?,
    dockActions: HomeDockActions?,
    listState: LazyListState,
    syncing: Boolean,
) {
    val colors = HappyTheme.colors
    Column(modifier = Modifier.fillMaxSize().background(colors.grouped.background)) {
        HomeHeader(connectionStatus, accounts, actions, syncing || state == null)
        com.slopus.happy.ui.voice.VoiceStatusBar()
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            val showArchived = { callbacks.onSetArchiveHidden(false) }
            when {
                state == null -> Box(
                    modifier = Modifier.fillMaxSize().padding(top = HomeSpec.contentTop, bottom = 32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        color = colors.textSecondary,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp).testTag(HomeTags.LOADING),
                    )
                }
                // No computer linked and nothing to show: say so where home is, with the way to
                // link one beside it. Home keeps its bar, its account menu and its compose, and a
                // cached list is never replaced by this (resolveHomeEmptyState: sessions win).
                state.emptyState == HomeEmptyState.Link -> StatePage(
                    tag = HomeTags.LINK,
                    art = StateArt.Make,
                    title = stringResource(R.string.onboarding_link_title),
                    body = stringResource(R.string.tablet_install_description),
                    action = stringResource(R.string.onboarding_scan_button) to actions.onLinkComputer,
                )
                state.emptyState == HomeEmptyState.Offline ->
                    offlineContent(state.computers, if (state.hasArchivedSessions) showArchived else null)
                state.emptyState == HomeEmptyState.NoSessions ->
                    NoSessionsState(onNewSession = actions.onNewSession, onShowArchived = if (state.hasArchivedSessions) showArchived else null)
                else -> HomeList(
                    state,
                    callbacks,
                    actions,
                    update,
                    contentTop = HomeSpec.contentTop,
                    listState = listState,
                    bottomSpacer = { Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).height(HomeDockSpec.contentInset)) },
                )
            }
            // The focused composer replaces the resting one rather than covering it.
            if (dock != null && dockActions != null && !dock.focused) {
                HomeDock(dock, dockActions, Modifier.align(Alignment.BottomCenter))
            }
        }
    }
}

/**
 * Home's top bar (AGENTS.md, design decisions): the account menu on the
 * left; settings, then compose at the far right. No title: only an
 * connection status shows, centred, including online and syncing.
 */
@Composable
private fun HomeHeader(connectionStatus: ConnectionStatus, accounts: AccountMenu, actions: HomeScreenActions, syncing: Boolean) {
    Header(
        alignment = TitleAlignment.Center,
        titleContent = { HomeConnectionStatus(connectionStatus, syncing) },
        left = {
            AccountMenuButton(accounts, actions.onSwitchAccount)
        },
        right = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.testTag(HomeTags.SETTINGS)) {
                    HeaderIconButton(
                        icon = Ionicon.SettingsOutline,
                        contentDescription = stringResource(R.string.settings_title),
                        onClick = actions.onSettings,
                        iconSize = HomeSpec.actionIcon,
                        buttonSize = HomeSpec.actionButton,
                    )
                }
                Box(modifier = Modifier.testTag(HomeTags.COMPOSE)) {
                    HeaderIconButton(
                        icon = Ionicon.CreateOutline,
                        contentDescription = stringResource(R.string.home_compose),
                        onClick = actions.onNewSession,
                        iconSize = HomeSpec.actionIcon,
                        buttonSize = HomeSpec.actionButton,
                    )
                }
            }
        },
    )
}

/** The connection line always shows; a healthy socket can still be catching up. */
@Composable
private fun HomeConnectionStatus(status: ConnectionStatus, syncing: Boolean) {
    val catchingUp = status == ConnectionStatus.CONNECTED && syncing
    val color = connectionStatusColor(HappyTheme.colors, if (catchingUp) ConnectionStatus.CONNECTING else status)
    Row(modifier = Modifier.testTag(HomeTags.STATUS), verticalAlignment = Alignment.CenterVertically) {
        StatusDot(color = color, pulsing = status == ConnectionStatus.CONNECTING || catchingUp, size = HomeSpec.statusDot)
        Spacer(Modifier.width(HomeSpec.statusDotGap))
        Text(text = stringResource(if (catchingUp) R.string.status_syncing else status.label), style = HomeSpec.status, color = color, maxLines = 1)
    }
}

fun connectionStatusColor(colors: HappyColors, status: ConnectionStatus) = when (status) {
    ConnectionStatus.CONNECTED -> colors.status.connected
    ConnectionStatus.CONNECTING -> colors.status.connecting
    ConnectionStatus.DISCONNECTED -> colors.status.disconnected
    ConnectionStatus.ERROR -> colors.status.error
}

private val ConnectionStatus.label: Int
    get() = when (this) {
        ConnectionStatus.CONNECTED -> R.string.status_online
        ConnectionStatus.CONNECTING -> R.string.status_connecting
        ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR -> R.string.status_offline
    }

/**
 * SessionsList: the banners, then the rows. The phone home starts it 12 under
 * its header and ends it over the dock; the tablet sidebar starts it flush and
 * marks [selectedSessionId], the session open beside it.
 */
@Composable
fun HomeList(
    state: HomeListState,
    callbacks: HomeListCallbacks,
    actions: HomeScreenActions,
    update: HomeUpdate?,
    contentTop: Dp,
    bottomSpacer: @Composable () -> Unit,
    selectedSessionId: String? = null,
    listState: LazyListState = rememberLazyListState(),
) {
    val colors = HappyTheme.colors
    val flat = state.grouping == SessionListGrouping.Flat
    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .background(if (flat) flatListBackground(colors) else colors.grouped.background)
            .testTag(HomeTags.LIST),
        contentPadding = PaddingValues(top = contentTop),
    ) {
        if (state.offlineBanner != null || update != null) {
            item(key = "banners", contentType = "banners") {
                HomeBanners(state.offlineBanner, update, actions)
            }
        }
        items(state.rows, key = { it.key }, contentType = { it::class }) { row ->
            when (row) {
                is HomeRow.Chat -> FlatSessionRow(row.row, row.showBorder, row.archived, callbacks, selected = row.row.session.id == selectedSessionId)
                is HomeRow.ArchiveToggle -> ArchiveToggleRow(row.hidden, row.banded, callbacks)
                is HomeRow.DayHeader -> DayHeaderRow(row.title, flat)
                is HomeRow.Project -> ProjectHomeRowContent(row.row, callbacks)
            }
        }
        item(key = "bottom", contentType = "bottom") { bottomSpacer() }
    }
}

/** A date heading between archived rows: 14 semibold section title; in the flat list it drops the grey band. */
@Composable
fun DayHeaderRow(title: DayTitle, flat: Boolean) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(HomeTags.DAY_HEADER)
            .background(if (flat) flatListBackground(colors) else colors.grouped.background)
            .padding(
                start = if (flat) HomeSpec.flatSectionPaddingHorizontal else HomeSpec.sectionPaddingHorizontal,
                end = if (flat) HomeSpec.flatSectionPaddingHorizontal else HomeSpec.sectionPaddingHorizontal,
                top = HomeSpec.sectionPaddingTop,
                bottom = HomeSpec.sectionPaddingBottom,
            ),
    ) {
        Text(text = dayTitleText(title), style = HomeSpec.sectionHeader, color = colors.grouped.sectionTitle)
    }
}

@Composable
fun dayTitleText(title: DayTitle): String = when (title) {
    DayTitle.Today -> stringResource(R.string.session_history_today)
    DayTitle.Yesterday -> stringResource(R.string.session_history_yesterday)
    is DayTitle.DaysAgo -> title.days.toInt().let { pluralResource(R.plurals.session_history_days_ago, it, it) }
}

/**
 * The archive's divider: hairlines either side of "Show archived" / "Hide
 * archived" (14, secondary), 12 apart, 24 in from the sides. Banded (the
 * flat list), it sits on the row colour with 24 above and 8 below.
 */
@Composable
fun ArchiveToggleRow(hidden: Boolean, banded: Boolean, callbacks: HomeListCallbacks) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(HomeTags.ARCHIVE_TOGGLE)
            .then(if (banded) Modifier.background(flatListBackground(colors)) else Modifier)
            .clickable(role = Role.Button) { callbacks.onSetArchiveHidden(!hidden) }
            .semantics { selected = !hidden }
            .padding(
                start = HomeSpec.sectionPaddingHorizontal,
                end = HomeSpec.sectionPaddingHorizontal,
                top = if (banded) HomeSpec.bandedTogglePaddingTop else HomeSpec.archiveTogglePaddingTop,
                bottom = if (banded) HomeSpec.bandedTogglePaddingBottom else HomeSpec.archiveTogglePaddingBottom,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HomeSpec.archiveToggleGap),
    ) {
        Box(Modifier.weight(1f).height(hairline()).background(colors.divider))
        Text(
            text = stringResource(if (hidden) R.string.sidebar_show_archived else R.string.sidebar_hide_archived),
            style = HomeSpec.archiveToggleText,
            color = colors.textSecondary,
        )
        Box(Modifier.weight(1f).height(hairline()).background(colors.divider))
    }
}
