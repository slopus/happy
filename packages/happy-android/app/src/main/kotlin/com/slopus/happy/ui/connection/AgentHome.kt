package com.slopus.happy.ui.connection

import com.slopus.happy.ui.rememberHomeAccountSwitch
import com.slopus.happy.ui.components.PageBackHandler as BackHandler
import androidx.activity.compose.ReportDrawnWhen
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.connection.LinkState
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.conversation.linkState
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.GlassBarLayout
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.LocalBarOnGlass
import com.slopus.happy.ui.components.PopupMotion
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.launch

/** Everything an agent connection's home asks of the app. */
@Immutable
class AgentHomeActions(
    /** Opens the conversation [agentId] of this connection. */
    val onOpenConversation: (agentId: String) -> Unit,
    /** Opens an empty new chat. */
    val onCompose: () -> Unit,
    val onSettings: () -> Unit,
    /** Opens a row of the connection's settings search found ([openAgentSettingsRow]). */
    val onSettingsRow: (AgentSettingsRow) -> Unit,
    val onSwitchAccount: (String) -> Unit,
    /** Scans a code and adds the Happy account or agent connection it is for. */
    val onAdd: () -> Unit,
    /** Opens the agent's artifacts, and one Surface. */
    val onOpenArtifacts: () -> Unit = {},
    val onOpenSurface: (AgentFeedRow.Surface) -> Unit = {},
    /**
     * Leaves a Surface ([com.slopus.happy.agent.AgentSession.leaveSurface]):
     * null once left, else the agent's words for its refusal, empty where
     * it gave none. Null here offers no Leave.
     */
    val onLeaveSurface: (suspend (AgentFeedRow.Surface) -> String?)? = null,
    /** Signs a team server in again, once its sign-in expired (edge SSO). */
    val onSignIn: () -> Unit = {},
    /** Opens new work with "+"'s sheet up, for its first message's picture. */
    val onComposeWithPicture: () -> Unit = onCompose,
)

/** The colours of every bar on an agent connection's screens: the page's own [container], scrolled or not. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun agentBarColors(container: Color = HappyTheme.colors.surface): TopAppBarColors {
    val colors = HappyTheme.colors
    return TopAppBarDefaults.topAppBarColors(
        containerColor = container,
        scrolledContainerColor = container,
        navigationIconContentColor = colors.text,
        titleContentColor = colors.text,
        actionIconContentColor = colors.text,
    )
}

/** A Material icon button around one of the app's glyphs, at Material's 24. */
@Composable
internal fun BarIconButton(icon: Ionicon, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    IconButton(onClick = onClick, modifier = modifier) {
        Icon(icon, 24.dp, LocalContentColor.current, contentDescription = label)
    }
}

/**
 * A top app bar whose [container] colour runs the whole width (under the
 * status bar too) while the bar itself is held to the content width and
 * centred, so on a wide window its controls line up with the rows beneath
 * rather than sitting out at the glass. A no-op on a phone, where the
 * content width is the window ([ContentWidth]). Inside a [GlassBarLayout]
 * the colour is the glass's. Over home's cards the bar comes [inset] further
 * in ([HomeCardSpec.inset]), so its outer glyphs stand on the rows' content
 * inside the cards, not on the cards' edges; the targets stay 48.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentTopBar(
    tag: String,
    container: Color,
    navigationIcon: @Composable () -> Unit,
    title: @Composable () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    inset: Dp = 0.dp,
) {
    val layout = LocalWindowLayout.current
    // On glass the glass is the ground ([GlassBarLayout]).
    Box(Modifier.fillMaxWidth().then(if (LocalBarOnGlass.current) Modifier else Modifier.background(container))) {
        TopAppBar(
            modifier = Modifier.contentMaxWidth(layout).testTag(tag).padding(horizontal = inset),
            colors = agentBarColors(Color.Transparent),
            navigationIcon = navigationIcon,
            title = title,
            actions = actions,
        )
    }
}

/**
 * Home while an agent connection is open: a Material top app bar with the
 * account menu (the agent's own picture) as its navigation, the agent's
 * name as its title (the link's status in its place while on its way, [BarTitle]),
 * and search and settings as its actions. No composer. Then the
 * conversations ([AgentHomeList]), with new chat as a floating button at
 * the bottom end, or a state page while there are none to show. Search swaps the bar for a
 * search bar of the same height, and the results lie over home in a panel
 * of their own ([AgentSearchResults]), so opening and closing it moves
 * nothing and home keeps its scroll.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentHomeScreen(
    name: String,
    feed: AgentFeed,
    status: AgentLinkStatus,
    accounts: AccountMenu,
    actions: AgentHomeActions,
    /** A team server signed in to but without the person's profile yet: SignInRequired asks for a name instead. */
    profileRequired: Boolean = false,
    /** What the title shows of the link, debounced ([rememberShownLinkState]) by [AgentHome]; as [status] stands by default. */
    link: LinkState = status.linkState(syncing = false, network = true),
) {
    val colors = HappyTheme.colors
    val reduceMotion = rememberReduceMotion()
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val focus = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    // The Surface whose Leave waits on the confirm, and a refused one's name and the agent's reason.
    var confirmingLeave by remember { mutableStateOf<AgentFeedRow.Surface?>(null) }
    var leaveRefused by remember { mutableStateOf<Pair<String, String>?>(null) }
    val closeSearch = {
        focus.clearFocus()
        searching = false
        query = ""
    }
    BackHandler(enabled = searching, onBack = closeSearch)

    val items = remember(feed) { agentHomeItems(feed) }
    val searchEntries = rememberSearchEntries(actions)
    val untitled = stringResource(R.string.session_new_chat)
    val headings = Triple(
        stringResource(R.string.agent_search_conversations),
        stringResource(R.string.agent_search_actions),
        stringResource(R.string.settings_title),
    )
    val results = remember(feed, query, searchEntries) {
        agentSearchResults(feed, query, untitled, headings, searchEntries.first, searchEntries.second)
    }

    // One ground under the bar and the page, the chat's own (surface), light and dark; the cards sit on it, as on iOS.
    // The bar is glass over the page: the cards scroll on under it, softened.
    val ground = colors.surface
    val phase = when {
        !feed.loaded && status == AgentLinkStatus.Connecting -> HomePhase.Loading
        !feed.loaded -> HomePhase.Offline
        // Artifacts alone is no home yet: the first chat is.
        feed.rows.all { it is AgentFeedRow.Section || it == AgentFeedRow.Artifacts } -> HomePhase.Empty
        else -> HomePhase.List
    }
    GlassBarLayout(
        modifier = Modifier.fillMaxSize().background(ground),
        ground = ground,
        // Only the list runs under the bar. The other states, and search's results hanging from the bar, are held
        // below its foot, with no feather over them.
        feathered = phase == HomePhase.List && !searching,
        bar = {
            if (searching) {
                AgentTopBar(
                    tag = AgentHomeTags.BAR,
                    container = ground,
                    navigationIcon = { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), closeSearch) },
                    title = { AgentSearchField(query, { query = it }) },
                    actions = {
                        if (query.isNotEmpty()) {
                            BarIconButton(Ionicon.Close, stringResource(R.string.agent_search_clear), { query = "" }, Modifier.testTag(AgentSearchTags.CLEAR))
                        }
                    },
                )
            } else {
                AgentTopBar(
                    tag = AgentHomeTags.BAR,
                    container = ground,
                    navigationIcon = { AccountMenuButton(accounts, actions.onSwitchAccount, actions.onAdd) },
                    title = { BarTitle(name, link, AgentHomeTags.TITLE, AgentHomeTags.STATUS) },
                    actions = {
                        BarIconButton(Ionicon.SearchOutline, stringResource(R.string.tools_names_search), { searching = true }, Modifier.testTag(AgentHomeTags.SEARCH))
                        BarIconButton(Ionicon.SettingsOutline, stringResource(R.string.settings_title), actions.onSettings, Modifier.testTag(AgentHomeTags.SETTINGS))
                    },
                    inset = HomeCardSpec.inset,
                )
            }
        },
    ) { top ->
        Box(modifier = Modifier.fillMaxSize()) {
            val barFoot = top - GlassSpec.feather
            // The loader fades into what comes, and every state into the next.
            Crossfade(phase, label = "agentHome") { shown ->
                when (shown) {
                    HomePhase.Loading -> LoadingIndicator(Modifier.padding(top = barFoot).testTag(AgentHomeTags.SPINNER))
                    // Offline and removed keep a plain glyph, as desktop's errors do.
                    HomePhase.Offline -> StatePage(
                        tag = AgentHomeTags.OFFLINE,
                        icon = if (status == AgentLinkStatus.Offline) Ionicon.CloudOfflineOutline else Ionicon.AlertCircleOutline,
                        title = when (status) {
                            AgentLinkStatus.Revoked -> null
                            AgentLinkStatus.UpdateRequired -> null
                            else -> stringResource(R.string.agent_home_offline_title, name)
                        },
                        body = statusMessage(status, profileRequired) ?: stringResource(R.string.agent_home_offline_body),
                        action = signInAction(status, actions, profileRequired),
                        modifier = Modifier.padding(top = barFoot),
                    )
                    // Desktop's wand beside the button that makes the first chat.
                    HomePhase.Empty -> StatePage(
                        tag = AgentHomeTags.EMPTY,
                        art = if (statusMessage(status, profileRequired) == null) StateArt.Make else null,
                        title = stringResource(R.string.agent_home_empty_title),
                        body = statusMessage(status, profileRequired) ?: stringResource(R.string.agent_home_empty_body),
                        action = signInAction(status, actions, profileRequired) ?: (stringResource(R.string.session_new_chat) to actions.onCompose),
                        modifier = Modifier.padding(top = barFoot),
                    )
                    HomePhase.List -> AgentHomeList(
                        items = items,
                        state = listState,
                        onOpen = actions.onOpenConversation,
                        onOpenArtifacts = actions.onOpenArtifacts,
                        onOpenSurface = actions.onOpenSurface,
                        onLeaveSurface = actions.onLeaveSurface?.let { { surface: AgentFeedRow.Surface -> confirmingLeave = surface } },
                        // The list starts under the glass bar and scrolls on beneath it.
                        contentPadding = PaddingValues(top = top),
                        // The notice is the list's first row (iOS ba0d7da0e): it comes and goes as a row does, the rows it
                        // pushes sliding with it, and a reader further down keeps their place.
                        header = noticeMessage(status, profileRequired)?.let { text ->
                            val action = signInAction(status, actions, profileRequired)
                            val header: LazyListScope.() -> Unit = {
                                item(key = "banner", contentType = "banner") {
                                    Banner(text, action, if (reduceMotion) Modifier else Modifier.animateItem(BANNER_FADE_IN, BANNER_PLACEMENT, BANNER_FADE_OUT))
                                }
                            }
                            header
                        },
                        // Room for the last card to scroll clear of the compose button.
                        bottom = { Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = AgentHomeSpec.fabClearance)) },
                    )
                }
            }
            if (feed.loaded && !searching) ComposeFab(actions.onCompose, AgentHomeTags.COMPOSE, stringResource(R.string.agent_search_new_task))
            // Home dims under the results, and a tap on it ends the search; it stays as it was underneath.
            // Both start at the bar's own foot.
            AnimatedVisibility(
                visible = searching && query.isNotBlank(),
                enter = fadeIn(tween(PopupMotion.ENTER_MS)),
                exit = fadeOut(tween(PopupMotion.EXIT_MS)),
                modifier = Modifier.padding(top = barFoot),
            ) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f))
                        .clickable(interactionSource = null, indication = null, onClick = closeSearch)
                        .testTag(AgentSearchTags.SCRIM),
                )
            }
            AnimatedVisibility(
                visible = searching,
                enter = fadeIn(tween(PopupMotion.ENTER_MS)),
                exit = fadeOut(tween(PopupMotion.EXIT_MS)),
                modifier = Modifier.padding(top = barFoot),
            ) {
                AgentSearchResults(
                    query = query,
                    results = results,
                    onOpenConversation = { id ->
                        closeSearch()
                        actions.onOpenConversation(id)
                    },
                )
            }
        }
    }
    LeaveSurfaceDialogs(
        confirming = confirmingLeave,
        refused = leaveRefused,
        onConfirm = { surface ->
            actions.onLeaveSurface?.let { leave ->
                scope.launch { leave(surface)?.let { reason -> leaveRefused = surface.name to reason } }
            }
        },
        onDismissConfirm = { confirmingLeave = null },
        onDismissRefused = { leaveRefused = null },
    )
}

/**
 * Leaving a Surface, after its row's Leave: first "Leave “name”?" with what
 * that does, Cancel or Leave; the row then goes at once. If the agent
 * refuses, the row is back and "Couldn't leave “name”" says why, in the
 * agent's words or, where it gave none, that it didn't answer (iOS shows
 * the same words in home's notice).
 */
@Composable
private fun LeaveSurfaceDialogs(
    confirming: AgentFeedRow.Surface?,
    refused: Pair<String, String>?,
    onConfirm: (AgentFeedRow.Surface) -> Unit,
    onDismissConfirm: () -> Unit,
    onDismissRefused: () -> Unit,
) {
    if (confirming != null) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.surface_leave_title, confirming.name),
                message = stringResource(R.string.surface_leave_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.surface_leave)) { onConfirm(confirming) },
                ),
                cancelable = false,
            ),
            onDismiss = onDismissConfirm,
        )
    }
    if (refused != null) {
        val (name, reason) = refused
        HappyAlert(
            Alert(
                title = stringResource(R.string.surface_leave_failed, name),
                message = reason.ifEmpty { stringResource(R.string.surface_leave_no_answer) },
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = onDismissRefused,
        )
    }
}

/** What home's page shows under the bar. */
private enum class HomePhase { Loading, Offline, Empty, List }

/**
 * The quick actions and settings search offers, and where each goes. The
 * settings are the connection's settings rows ([agentSettingsIndex], iOS's
 * `SettingsIndex.computer`): one opens its page at the row, flashing it.
 */
@Composable
private fun rememberSearchEntries(actions: AgentHomeActions): Pair<List<AgentSearchEntry>, List<AgentSearchEntry>> {
    val newTask = stringResource(R.string.agent_search_new_task)
    val newTaskPicture = stringResource(R.string.agent_search_new_task_picture)
    val connect = stringResource(R.string.agent_search_connect_agent)
    val scan = stringResource(R.string.onboarding_scan_button)
    val openSettings = stringResource(R.string.agent_search_open_settings)
    val index = agentSettingsIndex()
    return remember(actions, newTask, newTaskPicture, connect, scan, openSettings, index) {
        // happy-ios HomeViewController.quickActions (7a605f6ce). Connect and Scan both open the
        // scanner here: Android's one Add scanner takes a computer's, a terminal's or an agent's code.
        listOf(
            AgentSearchEntry("new-work", newTask, Ionicon.CreateOutline, actions.onCompose),
            AgentSearchEntry("new-work-picture", newTaskPicture, Ionicon.ImageOutline, actions.onComposeWithPicture),
            AgentSearchEntry("connect-agent", connect, Ionicon.LaptopOutline, actions.onAdd),
            AgentSearchEntry("scan", scan, Ionicon.QrCodeOutline, actions.onAdd),
            AgentSearchEntry("settings", openSettings, Ionicon.SettingsOutline, actions.onSettings),
        ) to index.map { row -> AgentSearchEntry(row.id, row.title, row.icon) { actions.onSettingsRow(row) } }
    }
}

/**
 * A home's compose: a floating button at the bottom end of the content
 * column (so on a tablet it stays with the rows), clear of the navigation
 * bar. Put it last in a box over the page.
 */
@Composable
internal fun BoxScope.ComposeFab(onClick: () -> Unit, tag: String, label: String = stringResource(R.string.session_new_chat)) {
    Box(Modifier.align(Alignment.BottomCenter).contentMaxWidth(LocalWindowLayout.current)) {
        FloatingActionButton(
            onClick = onClick,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(AgentHomeSpec.fabMargin)
                .testTag(tag),
        ) {
            Icon(Ionicon.CreateOutline, 24.dp, LocalContentColor.current, contentDescription = label)
        }
    }
}

@Composable
private fun statusMessage(status: AgentLinkStatus, profileRequired: Boolean = false): String? = when (status) {
    AgentLinkStatus.Revoked -> stringResource(R.string.agent_home_revoked)
    AgentLinkStatus.UpdateRequired -> stringResource(R.string.agent_home_update_required)
    AgentLinkStatus.SignInRequired -> stringResource(if (profileRequired) R.string.team_server_profile_required else R.string.team_server_error_sign_in_required)
    else -> null
}

/**
 * The notice heading home's list: why the agent can't be reached for good,
 * or "The computer did not answer." while it doesn't (iOS's
 * `Strings.unanswered`); the title keeps the name meanwhile ([BarTitle]).
 */
@Composable
private fun noticeMessage(status: AgentLinkStatus, profileRequired: Boolean): String? =
    statusMessage(status, profileRequired) ?: if (status == AgentLinkStatus.Offline) stringResource(R.string.agent_home_unanswered) else null

/** The notice row's motion, the rows' own ([agentHomeRows]). */
private val BANNER_FADE_IN = tween<Float>(180)
private val BANNER_PLACEMENT = tween<IntOffset>(220)
private val BANNER_FADE_OUT = tween<Float>(140)

/** A team server's "Sign in again", while its sign-in has expired. */
@Composable
private fun signInAction(status: AgentLinkStatus, actions: AgentHomeActions, profileRequired: Boolean): Pair<String, () -> Unit>? =
    if (status == AgentLinkStatus.SignInRequired) stringResource(if (profileRequired) R.string.team_server_add_name else R.string.team_server_sign_in_again) to actions.onSignIn else null

/** The list's first row: why the agent can't be reached (removed, too new, not answering). */
@Composable
private fun Banner(text: String, action: Pair<String, () -> Unit>? = null, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .background(scheme.errorContainer, MaterialTheme.shapes.medium)
            .padding(16.dp)
            .testTag(AgentHomeTags.BANNER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.AlertCircleOutline, 24.dp, scheme.onErrorContainer)
        Spacer(Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = scheme.onErrorContainer, modifier = Modifier.weight(1f, fill = false))
        action?.let { (label, onClick) ->
            Spacer(Modifier.size(8.dp))
            androidx.compose.material3.TextButton(onClick = onClick, modifier = Modifier.testTag(AgentHomeTags.BANNER_ACTION)) {
                Text(label, color = scheme.onErrorContainer)
            }
        }
    }
}

/**
 * [AgentHomeScreen] for the agent connection [id], from its session
 * ([AppGraph.agentSessions]): the cached home at once, then live.
 */
@Composable
fun AgentHome(
    graph: AppGraph,
    id: String,
    onOpenConversation: (agentId: String) -> Unit,
    onCompose: () -> Unit,
    onSettings: () -> Unit,
    onSettingsRow: (AgentSettingsRow) -> Unit,
    onComposeWithPicture: () -> Unit = onCompose,
    onOpenArtifacts: () -> Unit = {},
    onOpenSurface: (AgentFeedRow.Surface) -> Unit = {},
    /** Signs the team server at [server] in again ([AgentConnection.server]). */
    onSignIn: (server: String) -> Unit = {},
) {
    val session = remember(id) { graph.agentSessions.session(id) } ?: return
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val feed by session.feed.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    val link = rememberShownLinkState(status.linkState(syncing, rememberNetworkPath()))
    // Fully drawn (cold start's timeToFullDisplay, research/cold-start.md): home past its loader.
    ReportDrawnWhen { feed.loaded || status != AgentLinkStatus.Connecting }
    val add = LocalAddFlow.current
    val switchAccount = rememberHomeAccountSwitch(graph)
    val actions = remember(graph, session, onOpenConversation, onCompose, onComposeWithPicture, onSettings, onSettingsRow, onOpenArtifacts, onOpenSurface, add, switchAccount, onSignIn) {
        AgentHomeActions(
            onOpenConversation = onOpenConversation,
            onCompose = onCompose,
            onComposeWithPicture = onComposeWithPicture,
            onSettings = onSettings,
            onSettingsRow = onSettingsRow,
            onSwitchAccount = switchAccount,
            onAdd = { add?.scan() },
            onOpenArtifacts = onOpenArtifacts,
            onOpenSurface = onOpenSurface,
            onLeaveSurface = { session.leaveSurface(it.id) },
            onSignIn = { graph.agentConnections.accounts.value.firstOrNull { it.id == id }?.server?.let(onSignIn) },
        )
    }
    CompositionLocalProvider(LocalAgentPictures provides session.pictures) {
        AgentHomeScreen(
            name = agents.firstOrNull { it.id == id }?.name.orEmpty(),
            feed = feed,
            status = status,
            accounts = rememberAccountMenu(graph),
            actions = actions,
            profileRequired = agents.firstOrNull { it.id == id }?.profileRequired == true,
            link = link,
        )
    }
}
