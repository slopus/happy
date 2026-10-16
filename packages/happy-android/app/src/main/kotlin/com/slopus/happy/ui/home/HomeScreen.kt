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
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HomeTags {
    const val LOGO = "home.logo"
    const val FILTER = "home.filter"
    const val ACTION_DIVIDER = "home.actionDivider"
    const val SETTINGS = "home.settings"
    const val TITLE = "home.title"
    const val STATUS = "home.status"
    const val LOADING = "home.loading"
    /** The first-run link page standing in for the whole home screen. */
    const val LINK = "home.link"
    /** The tablet detail with no session open: blank, as MainView.tsx leaves it. */
    const val TABLET_BLANK = "home.tabletBlank"
    const val LIST = "home.list"
    const val ARCHIVE_TOGGLE = "home.archiveToggle"
    const val DAY_HEADER = "home.dayHeader"
    const val EMPTY = "home.empty"
    const val SHOW_ARCHIVED = "home.showArchived"
}

/** MainView.tsx, HomeHeaderTitle.tsx and SessionsList.tsx on a phone. */
object HomeSpec {
    val logoBox = 32.dp
    val logo = 19.dp
    val actionButton = 44.dp
    val actionIcon = 22.dp
    val actionDividerHeight = 22.dp
    val title = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold)
    val status = happyTextStyle(fontSize = 11, lineHeight = 16, weight = FontWeight.Medium)
    val statusDot = 6.dp
    val statusDotGap = 4.dp
    val statusOverlap = 2.dp
    val statusMinHeight = 16.dp

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
    val onAppearance: () -> Unit,
    val onSetGrouping: (SessionListGrouping) -> Unit,
    val onNewSession: () -> Unit,
    val onTroubleshoot: () -> Unit,
    val onOpenUrl: (String) -> Unit,
    val onWhatsNew: () -> Unit,
)

/**
 * Signed in, on a phone. With no computer linked, [linkContent] takes the
 * whole screen, sessions or not (index.tsx shouldShowFirstRunInstall: the
 * onboarding's link page, no home chrome). Otherwise the home header (logo; "Happy" centred
 * with the connection status under it while the socket isn't healthy; the
 * filter menu and settings gear sharing one control), then the loading
 * spinner, the no-sessions state, [offlineContent] (the onboarding's
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
    linkContent: @Composable () -> Unit = {},
    offlineContent: @Composable (computers: List<String>, onShowArchived: (() -> Unit)?) -> Unit = { _, _ -> },
    dock: HomeDockState? = null,
    dockActions: HomeDockActions? = null,
) {
    val colors = HappyTheme.colors
    if (state?.showsInstallStep == true) {
        Box(modifier = modifier.fillMaxSize().testTag(HomeTags.LINK)) { linkContent() }
        return
    }
    Box(modifier = modifier.fillMaxSize()) {
        HomeContent(state, connectionStatus, grouping, callbacks, actions, update, offlineContent, dock, dockActions)
        if (dock != null && dockActions != null && dock.focused) HomeDockFocus(dock, dockActions)
    }
}

@Composable
private fun HomeContent(
    state: HomeListState?,
    connectionStatus: ConnectionStatus,
    grouping: SessionListGrouping,
    callbacks: HomeListCallbacks,
    actions: HomeScreenActions,
    update: HomeUpdate?,
    offlineContent: @Composable (computers: List<String>, onShowArchived: (() -> Unit)?) -> Unit,
    dock: HomeDockState?,
    dockActions: HomeDockActions?,
) {
    val colors = HappyTheme.colors
    Column(modifier = Modifier.fillMaxSize().background(colors.grouped.background)) {
        HomeHeader(connectionStatus, grouping, actions)
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

@Composable
private fun HomeHeader(connectionStatus: ConnectionStatus, grouping: SessionListGrouping, actions: HomeScreenActions) {
    val colors = HappyTheme.colors
    Header(
        alignment = TitleAlignment.Center,
        // MainView's phone header names the tab (`tabs.sessions`); HomeHeader's "Happy" is no longer mounted.
        titleContent = { HomeHeaderTitle(stringResource(R.string.tabs_sessions), connectionStatus) },
        left = {
            Box(modifier = Modifier.size(HomeSpec.logoBox).testTag(HomeTags.LOGO), contentAlignment = Alignment.Center) {
                Image(
                    painter = painterResource(R.drawable.happy_logo),
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    colorFilter = ColorFilter.tint(colors.header.tint),
                    modifier = Modifier.size(HomeSpec.logo),
                )
            }
        },
        right = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                var menuOpen by remember { mutableStateOf(false) }
                val groupingTitle = stringResource(R.string.sessions_filter_grouping_title)
                val flatLabel = stringResource(R.string.sessions_filter_flat_list)
                val projectLabel = stringResource(R.string.sessions_filter_group_by_project)
                val appearanceLabel = stringResource(R.string.sessions_filter_appearance_settings)
                val groups = remember(grouping, groupingTitle, flatLabel, projectLabel, appearanceLabel, actions) {
                    listOf(
                        MenuGroup(
                            key = "grouping",
                            label = groupingTitle,
                            options = listOf(MenuOption(SessionListGrouping.Flat.wire, flatLabel), MenuOption(SessionListGrouping.Project.wire, projectLabel)),
                            selectedKey = grouping.wire,
                            onSelect = { key -> SessionListGrouping.entries.find { it.wire == key }?.let(actions.onSetGrouping) },
                        ),
                        // A plain row, not a choice: it leaves for the appearance settings.
                        MenuGroup(
                            key = "appearance",
                            label = "",
                            options = listOf(MenuOption("open", appearanceLabel, action = true)),
                            selectedKey = null,
                            onSelect = { actions.onAppearance() },
                        ),
                    )
                }
                SettingsMenu(groups = groups, expanded = menuOpen, onDismiss = { menuOpen = false }) {
                    Box(modifier = Modifier.testTag(HomeTags.FILTER)) {
                        HeaderIconButton(
                            icon = Ionicon.Filter,
                            contentDescription = stringResource(R.string.sessions_filter_title),
                            onClick = { menuOpen = true },
                            iconSize = HomeSpec.actionIcon,
                            buttonSize = HomeSpec.actionButton,
                        )
                    }
                }
                // Shorter than the buttons, so it reads as a seam inside one control.
                Box(
                    modifier = Modifier
                        .testTag(HomeTags.ACTION_DIVIDER)
                        .width(hairline())
                        .height(HomeSpec.actionDividerHeight)
                        .background(colors.divider),
                )
                Box(modifier = Modifier.testTag(HomeTags.SETTINGS)) {
                    HeaderIconButton(
                        icon = Ionicon.SettingsOutline,
                        contentDescription = stringResource(R.string.settings_title),
                        onClick = actions.onSettings,
                        iconSize = HomeSpec.actionIcon,
                        buttonSize = HomeSpec.actionButton,
                    )
                }
            }
        },
    )
}

/** homeConnectionStatus.ts: only an unhealthy socket is worth a line. */
fun shouldShowHomeConnectionStatus(status: ConnectionStatus, hasCustomSubtitle: Boolean = false): Boolean =
    status != ConnectionStatus.CONNECTED && !hasCustomSubtitle

fun connectionStatusColor(colors: HappyColors, status: ConnectionStatus) = when (status) {
    ConnectionStatus.CONNECTED -> colors.status.connected
    ConnectionStatus.CONNECTING -> colors.status.connecting
    ConnectionStatus.DISCONNECTED -> colors.status.disconnected
    ConnectionStatus.ERROR -> colors.status.error
}

/**
 * HomeHeaderTitle: the title is centred on its own; the status line hangs
 * under it (2 up, 16 minimum, 11/16 medium in the status colour, a 6 dot
 * pulsing while connecting) and never moves it.
 */
@Composable
fun HomeHeaderTitle(title: String, status: ConnectionStatus) {
    val colors = HappyTheme.colors
    val statusColor = connectionStatusColor(colors, status)
    Layout(
        content = {
            Text(
                text = title,
                style = HomeSpec.title,
                color = colors.header.tint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag(HomeTags.TITLE).semantics { heading() },
            )
            if (shouldShowHomeConnectionStatus(status)) {
                Row(modifier = Modifier.testTag(HomeTags.STATUS), verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(color = statusColor, pulsing = status == ConnectionStatus.CONNECTING, size = HomeSpec.statusDot)
                    Spacer(Modifier.width(HomeSpec.statusDotGap))
                    Text(text = stringResource(status.label), style = HomeSpec.status, color = statusColor, maxLines = 1)
                }
            }
        },
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val titlePlaceable = measurables[0].measure(loose)
        val statusPlaceable = measurables.getOrNull(1)?.measure(loose)
        val width = maxOf(titlePlaceable.width, statusPlaceable?.width ?: 0).coerceIn(constraints.minWidth, constraints.maxWidth)
        layout(width, titlePlaceable.height) {
            titlePlaceable.place((width - titlePlaceable.width) / 2, 0)
            statusPlaceable?.let {
                val slot = HomeSpec.statusMinHeight.roundToPx()
                val top = titlePlaceable.height - HomeSpec.statusOverlap.roundToPx() + maxOf(0, (slot - it.height) / 2)
                it.place((width - it.width) / 2, top)
            }
        }
    }
}

private val ConnectionStatus.label: Int
    get() = when (this) {
        ConnectionStatus.CONNECTED -> R.string.status_connected
        ConnectionStatus.CONNECTING -> R.string.status_connecting
        ConnectionStatus.DISCONNECTED -> R.string.status_disconnected
        ConnectionStatus.ERROR -> R.string.status_error
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
) {
    val colors = HappyTheme.colors
    val flat = state.grouping == SessionListGrouping.Flat
    LazyColumn(
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
