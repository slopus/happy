package com.slopus.happy.ui.home

import com.slopus.happy.ui.migration.MigrationPath

import com.slopus.happy.ui.tablet.LocalSidebarHome
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.tablet.SidebarFootBar
import com.slopus.happy.ui.tablet.SidebarSpec
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.DayTitle
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.GlassBarLayout
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.HomeCardRow
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.connection.AgentHomeSpec
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.accountLinkState
import com.slopus.happy.ui.connection.BarTitle
import com.slopus.happy.ui.connection.ComposeFab
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HomeTags {
    const val BAR = "home.bar"
    const val SETTINGS = "home.settings"
    /** The floating compose button. */
    const val COMPOSE = "home.compose"
    const val TITLE = "home.title"
    const val STATUS = "home.status"
    const val LOADING = "home.loading"
    /** Home's empty state with no computer linked: Make art and Scan QR code, under the usual header. */
    const val LINK = "home.link"
    /** The tablet detail with no session open: blank, as MainView.tsx leaves it. */
    const val LIST = "home.list"
    const val ARCHIVE_TOGGLE = "home.archiveToggle"
    const val DAY_HEADER = "home.dayHeader"
    const val EMPTY = "home.empty"
    const val SHOW_ARCHIVED = "home.showArchived"
    /** Every row in a card: its column, the card [HomeCardSpec.inset] in from it. */
    const val CARD_ROW = "home.cardRow"
}

/** MainView.tsx and SessionsList.tsx on a phone. */
object HomeSpec {
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
    /** The new-session screen (the tablet's sidebar). */
    val onNewSession: () -> Unit,
    val onTroubleshoot: () -> Unit,
    val onOpenUrl: (String) -> Unit,
    val onWhatsNew: () -> Unit,
    val onSwitchAccount: (String) -> Unit = {},
    /** Links a computer from the empty home: the terminal scan Settings uses, approved with this account. */
    val onLinkComputer: () -> Unit = {},
    /** The phone's compose: an empty chat whose first send starts the session. */
    val onCompose: () -> Unit = onNewSession,
    /** The migration card's screen, and its ×. */
    val onMigration: (MigrationPath) -> Unit = {},
    val onCloseMigration: (MigrationPath) -> Unit = {},
)

/**
 * Signed in, on a phone. Home is always home: the bar (as an agent
 * connection's home has it: the account menu, the account's name 18
 * semibold with how the connection stands after it while it isn't online,
 * and settings) and the account menu are there whether or not a computer is
 * linked, and whatever the account already lists stays listed. Under the
 * bar: the loading spinner, the link state (no computer and nothing to
 * list: what's missing and the way to link one, never a takeover), the
 * no-sessions state, [offlineContent] (the onboarding's offline checklist,
 * given the computers' names) or the list in its inset cards: the banners,
 * then the flat chat list or the project hierarchy. Nothing is typed here
 * (iOS's legacy home since 91e51d0f8): compose is a floating button at the
 * bottom end, in every state but loading and the link state, and opens an
 * empty chat ([HomeScreenActions.onCompose]).
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
    /** The migration card leading the list, if it shows ([MigrationPath.shown]). */
    migration: MigrationPath? = null,
    offlineContent: @Composable (computers: List<String>, onShowArchived: (() -> Unit)?) -> Unit = { _, _ -> },
    accounts: AccountMenu = AccountMenu(),
    listState: LazyListState = rememberLazyListState(),
    syncing: Boolean = false,
    /** What the title shows of the link, debounced ([com.slopus.happy.ui.chat.rememberShownLinkState]) by [LegacyHome]; as the socket stands by default. */
    link: LinkState = accountLinkState(connectionStatus == ConnectionStatus.CONNECTED, catchingUp = syncing || state == null, network = true),
) {
    val colors = HappyTheme.colors
    // As the tablet's sidebar, home wears its chrome: no settings in the bar, settings and compose at its foot.
    val sidebar = LocalSidebarHome.current
    val listed = state != null && state.emptyState != HomeEmptyState.Link && state.emptyState != HomeEmptyState.Offline &&
        state.emptyState != HomeEmptyState.NoSessions
    // The bar is glass over the page, as agent home's: the cards scroll on under it, softened.
    GlassBarLayout(
        modifier = modifier.fillMaxSize().background(colors.surface),
        ground = colors.surface,
        // Only the list runs under the bar; the other states are held below its foot, with no feather over them.
        feathered = listed,
        bar = {
            Column {
                HomeHeader(link, accounts, actions, settings = sidebar == null)
                com.slopus.happy.ui.voice.VoiceStatusBar()
            }
        },
    ) { top ->
        Box(modifier = Modifier.fillMaxSize()) {
            val showArchived = { callbacks.onSetArchiveHidden(false) }
            // Everything but the list is held below the bar; the list starts under it, clear of its feather.
            val below = Modifier.padding(top = top - GlassSpec.feather)
            when {
                state == null -> LoadingIndicator(below.testTag(HomeTags.LOADING))
                // No computer linked and nothing to show: say so where home is, with the way to
                // link one beside it. Home keeps its bar and its account menu, and a cached list is
                // never replaced by this (resolveHomeEmptyState: sessions win).
                state.emptyState == HomeEmptyState.Link -> StatePage(
                    tag = HomeTags.LINK,
                    art = StateArt.Make,
                    title = stringResource(R.string.onboarding_link_title),
                    body = stringResource(R.string.tablet_install_description),
                    action = stringResource(R.string.onboarding_scan_button) to actions.onLinkComputer,
                    modifier = below,
                )
                state.emptyState == HomeEmptyState.Offline -> Box(below) {
                    offlineContent(state.computers, if (state.hasArchivedSessions) showArchived else null)
                }
                state.emptyState == HomeEmptyState.NoSessions -> Box(below) {
                    NoSessionsState(onNewSession = actions.onCompose, onShowArchived = if (state.hasArchivedSessions) showArchived else null)
                }
                else -> HomeList(
                    state,
                    callbacks,
                    actions,
                    update,
                    migration = migration,
                    contentTop = top + HomeCardSpec.contentTop,
                    listState = listState,
                    // Room for the last card to scroll clear of the compose button, or the sidebar's foot.
                    bottomSpacer = {
                        if (sidebar != null) Spacer(Modifier.height(SidebarSpec.listClearance()))
                        else Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).height(AgentHomeSpec.fabClearance))
                    },
                    carded = true,
                    selectedSessionId = MainPanelKey.sessionId(sidebar?.selected),
                )
            }
            // With no computer there is nothing to start work on.
            val canStart = state != null && state.emptyState != HomeEmptyState.Link
            if (sidebar != null) {
                SidebarFootBar(if (canStart) stringResource(R.string.sidebar_new_session) else null, actions.onSettings, actions.onCompose)
            } else if (canStart) {
                ComposeFab(actions.onCompose, HomeTags.COMPOSE)
            }
        }
    }
}

/**
 * Home's top bar, the agent connection home's ([AgentTopBar]): the account
 * menu, the open account's name, then settings. While the socket is on its
 * way back, or catching up after a connect, its status stands in the
 * name's place ([BarTitle]); online says nothing.
 */
@Composable
private fun HomeHeader(link: LinkState, accounts: AccountMenu, actions: HomeScreenActions, settings: Boolean = true) {
    val colors = HappyTheme.colors
    // Named as its kind until it has a name of its own (iOS 64edb6a34).
    val name = accounts.active?.name ?: stringResource(R.string.account_kind_cli)
    AgentTopBar(
        tag = HomeTags.BAR,
        container = colors.surface,
        navigationIcon = { AccountMenuButton(accounts, actions.onSwitchAccount) },
        title = { BarTitle(name, link, HomeTags.TITLE, HomeTags.STATUS) },
        actions = {
            if (settings) BarIconButton(Ionicon.SettingsOutline, stringResource(R.string.settings_title), actions.onSettings, Modifier.testTag(HomeTags.SETTINGS))
        },
        inset = HomeCardSpec.inset,
    )
}

fun connectionStatusColor(colors: HappyColors, status: ConnectionStatus) = when (status) {
    ConnectionStatus.CONNECTED -> colors.status.connected
    ConnectionStatus.CONNECTING -> colors.status.connecting
    ConnectionStatus.DISCONNECTED -> colors.status.disconnected
    ConnectionStatus.ERROR -> colors.status.error
}

/**
 * SessionsList: the banners, then the rows. The phone home draws them
 * [carded], in the agent home's inset cards ([HomeListState.cards]), from 8
 * under its bar to clear of its compose button; the tablet sidebar starts
 * them flush, full width, and marks [selectedSessionId], the session open
 * beside it.
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
    carded: Boolean = false,
    migration: MigrationPath? = null,
) {
    val colors = HappyTheme.colors
    val flat = state.grouping == SessionListGrouping.Flat
    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .background(
                when {
                    carded -> colors.surface
                    flat -> flatListBackground(colors)
                    else -> colors.grouped.background
                },
            )
            .testTag(HomeTags.LIST),
        contentPadding = PaddingValues(top = contentTop),
    ) {
        if (state.offlineBanner != null || update != null || migration != null) {
            item(key = "banners", contentType = "banners") {
                HomeBanners(state.offlineBanner, update, actions, migration)
            }
        }
        if (carded) {
            items(state.cards, key = { it.key }, contentType = { (it.row as? HomeRow.Project)?.row?.let { row -> row::class } ?: it.row::class }) { entry ->
                HomeCardItem(entry, callbacks, selectedSessionId)
            }
        } else items(state.rows, key = { it.key }, contentType = { it::class }) { row ->
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

/** One row of the phone's home: in its card ([HomeCardRow]) at its kind's fixed height, or on the page between cards. */
@Composable
private fun HomeCardItem(entry: HomeCardEntry, callbacks: HomeListCallbacks, selectedSessionId: String?) {
    val place = entry.place
    when (val row = entry.row) {
        is HomeRow.Chat -> if (place != null) {
            HomeCardRow(place, FlatRowSpec.cardRowHeight(), FlatRowSpec.paddingLeft + FlatRowSpec.cardAvatar + FlatRowSpec.avatarGap, tag = HomeTags.CARD_ROW) {
                FlatSessionRow(row.row, showBorder = false, archived = row.archived, callbacks = callbacks, selected = row.row.session.id == selectedSessionId, carded = true)
            }
        }
        is HomeRow.ArchiveToggle -> ArchiveToggleRow(row.hidden, row.banded, callbacks, carded = true)
        is HomeRow.DayHeader -> Unit
        is HomeRow.Project -> if (place != null) {
            HomeCardRow(place, ProjectListSpec.cardRowHeight(row.row), ProjectListSpec.nameX, tag = HomeTags.CARD_ROW, selected = selectedSessionId != null && row.row.shows(selectedSessionId)) {
                ProjectHomeRowContent(row.row, callbacks, carded = true)
            }
        } else {
            ProjectHomeRowContent(row.row, callbacks, carded = true)
        }
    }
}

/** Whether [sessionId]'s chat is what this row opens: a bot's, a task's, a project's checkout, or one of a worktree's tabs. */
private fun ProjectHomeRow.shows(sessionId: String): Boolean = when (this) {
    is ProjectHomeRow.Bot -> session.id == sessionId
    is ProjectHomeRow.Task -> session.id == sessionId
    is ProjectHomeRow.Archived -> session.id == sessionId
    is ProjectHomeRow.ProjectCard -> project.session?.id == sessionId
    is ProjectHomeRow.Worktree -> worktree.tabs.any { it.id == sessionId } || worktree.session.id == sessionId
    else -> false
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
 * flat list), it sits on the row colour with 24 above and 8 below; [carded],
 * it stands on the page between the cards, keeping the band's room.
 */
@Composable
fun ArchiveToggleRow(hidden: Boolean, banded: Boolean, callbacks: HomeListCallbacks, carded: Boolean = false) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .then(if (carded) Modifier.contentMaxWidth(LocalWindowLayout.current) else Modifier.fillMaxWidth())
            .testTag(HomeTags.ARCHIVE_TOGGLE)
            .then(if (banded && !carded) Modifier.background(flatListBackground(colors)) else Modifier)
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
