package com.slopus.happy.ui.connection

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.TitleWithStatus
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay

/** Everything an agent connection's home asks of the app. */
@Immutable
class AgentHomeActions(
    /** Opens the conversation [agentId] of this connection. */
    val onOpenConversation: (agentId: String) -> Unit,
    /** Opens an empty new chat. */
    val onCompose: () -> Unit,
    val onSettings: () -> Unit,
    val onAppearance: () -> Unit,
    val onSwitchAccount: (String) -> Unit,
    /** Scans a code and adds the Happy account or agent connection it is for. */
    val onAdd: () -> Unit,
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
 * content width is the window ([ContentWidth]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentTopBar(
    tag: String,
    container: Color,
    navigationIcon: @Composable () -> Unit,
    title: @Composable () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val layout = LocalWindowLayout.current
    Box(Modifier.fillMaxWidth().background(container)) {
        TopAppBar(
            modifier = Modifier.contentMaxWidth(layout).testTag(tag),
            colors = agentBarColors(Color.Transparent),
            navigationIcon = navigationIcon,
            title = title,
            actions = actions,
        )
    }
}

/**
 * Home while an agent connection is open: a Material top app bar with the
 * account menu as its navigation, the agent's name and connection status
 * as its title, and search, settings and new chat
 * as its actions. No composer. Then the conversations ([AgentHomeList]),
 * or a state page while there are none to show. Search swaps the bar for a
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
    now: Long = System.currentTimeMillis(),
    syncing: Boolean = false,
) {
    val colors = HappyTheme.colors
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var expanded by rememberSaveable { mutableStateOf(listOf<String>()) }
    val listState = rememberLazyListState()
    val focus = LocalFocusManager.current
    val closeSearch = {
        focus.clearFocus()
        searching = false
        query = ""
    }
    BackHandler(enabled = searching, onBack = closeSearch)

    val items = remember(feed, expanded) { agentHomeItems(feed, expanded.toSet()) }
    val searchEntries = rememberSearchEntries(actions)
    val untitled = stringResource(R.string.session_new_chat)
    val headings = Triple(
        stringResource(R.string.agent_search_conversations),
        stringResource(R.string.agent_search_actions),
        stringResource(R.string.agent_search_settings),
    )
    val results = remember(feed, query, searchEntries) {
        agentSearchResults(feed, query, untitled, headings, searchEntries.first, searchEntries.second)
    }

    // One surface under the bar and the page, the chat's own (surface), light and dark.
    Column(modifier = Modifier.fillMaxSize().background(colors.surface)) {
        if (searching) {
            AgentTopBar(
                tag = AgentHomeTags.BAR,
                container = colors.surface,
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
                container = colors.surface,
                navigationIcon = {
                    Box(Modifier.padding(horizontal = 4.dp)) { AccountMenuButton(accounts, actions.onSwitchAccount, actions.onAdd) }
                },
                title = { BarTitle(name, status, syncing || !feed.loaded) },
                actions = {
                    BarIconButton(Ionicon.SearchOutline, stringResource(R.string.agent_search_open), { searching = true }, Modifier.testTag(AgentHomeTags.SEARCH))
                    BarIconButton(Ionicon.SettingsOutline, stringResource(R.string.settings_title), actions.onSettings, Modifier.testTag(AgentHomeTags.SETTINGS))
                    BarIconButton(Ionicon.CreateOutline, stringResource(R.string.home_compose), actions.onCompose, Modifier.testTag(AgentHomeTags.COMPOSE))
                },
            )
        }
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                // Desktop's pictures: the snail while it is read, the wand beside the button that makes the first chat;
                // offline and removed keep a plain glyph, as desktop's errors do.
                !feed.loaded && status == AgentLinkStatus.Connecting -> StatePage(
                    tag = AgentHomeTags.SPINNER,
                    art = StateArt.Waiting,
                    title = null,
                    body = stringResource(R.string.agent_home_connecting, name),
                )
                !feed.loaded -> StatePage(
                    tag = AgentHomeTags.OFFLINE,
                    icon = if (status == AgentLinkStatus.Offline) Ionicon.CloudOfflineOutline else Ionicon.AlertCircleOutline,
                    title = when (status) {
                        AgentLinkStatus.Revoked -> null
                        AgentLinkStatus.UpdateRequired -> null
                        else -> stringResource(R.string.agent_home_offline_title, name)
                    },
                    body = statusMessage(status) ?: stringResource(R.string.agent_home_offline_body),
                )
                items.isEmpty() -> StatePage(
                    tag = AgentHomeTags.EMPTY,
                    art = if (statusMessage(status) == null) StateArt.Make else null,
                    title = stringResource(R.string.agent_home_empty_title),
                    body = statusMessage(status) ?: stringResource(R.string.agent_home_empty_body),
                    action = stringResource(R.string.home_compose) to actions.onCompose,
                )
                else -> AgentHomeList(
                    items = items,
                    state = listState,
                    now = now,
                    onOpen = actions.onOpenConversation,
                    onToggle = { id -> expanded = if (id in expanded) expanded - id else expanded + id },
                    contentPadding = PaddingValues(top = 4.dp),
                    header = statusMessage(status)?.let { text ->
                        { item(key = "banner", contentType = "banner") { Banner(text) } }
                    },
                    bottom = { Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = 24.dp)) },
                )
            }
            if (searching && query.isNotBlank()) {
                // Home dims under the results, and a tap on it ends the search; it stays as it was underneath.
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f))
                        .clickable(interactionSource = null, indication = null, onClick = closeSearch)
                        .testTag(AgentSearchTags.SCRIM),
                )
            }
            if (searching) {
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
}

/** The quick actions and settings search offers, and where each goes. */
@Composable
private fun rememberSearchEntries(actions: AgentHomeActions): Pair<List<AgentSearchEntry>, List<AgentSearchEntry>> {
    val newChat = stringResource(R.string.agent_search_new_chat)
    val add = stringResource(R.string.agent_search_add)
    val openSettings = stringResource(R.string.agent_search_open_settings)
    val appearance = stringResource(R.string.settings_appearance)
    val status = stringResource(R.string.agent_settings_status)
    val remove = stringResource(R.string.agent_settings_remove)
    return remember(actions, newChat, add, openSettings, appearance, status, remove) {
        listOf(
            AgentSearchEntry("new-chat", newChat, Ionicon.CreateOutline, actions.onCompose),
            AgentSearchEntry("add", add, Ionicon.QrCodeOutline, actions.onAdd),
            AgentSearchEntry("settings", openSettings, Ionicon.SettingsOutline, actions.onSettings),
        ) to listOf(
            AgentSearchEntry("appearance", appearance, Ionicon.ColorPaletteOutline, actions.onAppearance),
            AgentSearchEntry("status", status, Ionicon.LaptopOutline, actions.onSettings),
            // Opens settings, where removing asks first; search never removes anything itself.
            AgentSearchEntry("remove", remove, Ionicon.TrashOutline, actions.onSettings),
        )
    }
}

/**
 * The agent's name, the bar's title; under it, how the connection
 * stands. The line is always there, so the name holds still as
 * the link drops and comes back.
 */
@Composable
private fun BarTitle(name: String, status: AgentLinkStatus, syncing: Boolean) {
    val colors = HappyTheme.colors
    val style = MaterialTheme.typography.labelMedium
    TitleWithStatus(
        status = status to syncing,
        statusStyle = style,
        title = {
            Text(name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(AgentHomeTags.TITLE))
        },
    ) { (shown, catchingUp) ->
        val color = when (shown) {
            AgentLinkStatus.Connected -> if (catchingUp) colors.status.connecting else colors.status.connected
            AgentLinkStatus.Connecting -> colors.status.connecting
            AgentLinkStatus.Offline -> colors.status.disconnected
            else -> colors.status.error
        }
        Row(modifier = Modifier.testTag(AgentHomeTags.STATUS), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(color = color, pulsing = shown == AgentLinkStatus.Connecting || (shown == AgentLinkStatus.Connected && catchingUp), size = 6.dp)
            Spacer(Modifier.width(6.dp))
            Text(
                stringResource(
                    when (shown) {
                        AgentLinkStatus.Connected -> if (catchingUp) R.string.status_syncing else R.string.status_online
                        AgentLinkStatus.Connecting -> R.string.status_connecting
                        AgentLinkStatus.Offline -> R.string.status_offline
                        AgentLinkStatus.Revoked -> R.string.agent_home_status_revoked
                        else -> R.string.agent_home_status_update
                    },
                ),
                style = style,
                color = color,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun statusMessage(status: AgentLinkStatus): String? = when (status) {
    AgentLinkStatus.Revoked -> stringResource(R.string.agent_home_revoked)
    AgentLinkStatus.UpdateRequired -> stringResource(R.string.agent_home_update_required)
    else -> null
}

/** Above the rows: why the agent can't be reached for good (removed, or too new). */
@Composable
private fun Banner(text: String) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .background(scheme.errorContainer, MaterialTheme.shapes.medium)
            .padding(16.dp)
            .testTag(AgentHomeTags.BANNER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.AlertCircleOutline, 24.dp, scheme.onErrorContainer)
        Spacer(Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = scheme.onErrorContainer)
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
    onAppearance: () -> Unit,
) {
    val session = remember(id) { graph.agentSessions.session(id) } ?: return
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val feed by session.feed.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    // The times in the corners move on once a minute; nothing else does.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000 - now % 60_000)
            now = System.currentTimeMillis()
        }
    }
    val add = LocalAddFlow.current
    val actions = remember(graph, onOpenConversation, onCompose, onSettings, onAppearance, add) {
        AgentHomeActions(
            onOpenConversation = onOpenConversation,
            onCompose = onCompose,
            onSettings = onSettings,
            onAppearance = onAppearance,
            onSwitchAccount = { graph.open(it) },
            onAdd = { add?.scan() },
        )
    }
    AgentHomeScreen(
        name = agents.firstOrNull { it.id == id }?.name.orEmpty(),
        feed = feed,
        status = status,
        accounts = rememberAccountMenu(graph),
        actions = actions,
        now = now,
        syncing = syncing,
    )
}
