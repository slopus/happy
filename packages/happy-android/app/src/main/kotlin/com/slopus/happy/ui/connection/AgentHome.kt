package com.slopus.happy.ui.connection

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.HeaderIconButton
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.HomeSpec
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
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

/**
 * Home while an agent connection is open (AGENTS.md, design decisions:
 * Home's top bar): the account menu and the agent's name on the left,
 * search, settings and compose on the right; while the link isn't up its
 * state shows under the name. No composer. Then the conversations
 * ([AgentHomeList]), or the spinner, the offline page or the empty state
 * while there are none to show. Search keeps the bar's height: the field
 * takes the name's place, and the results lie over home in a panel of
 * their own ([AgentSearchResults]), so opening and closing it moves
 * nothing and home keeps its scroll.
 */
@Composable
fun AgentHomeScreen(
    name: String,
    feed: AgentFeed,
    status: AgentLinkStatus,
    accounts: AccountMenu,
    actions: AgentHomeActions,
    now: Long = System.currentTimeMillis(),
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
            Header(
                alignment = TitleAlignment.Start,
                background = colors.surface,
                left = { HeaderBackButton(onClick = closeSearch) },
                titleContent = { AgentSearchField(query, { query = it }) },
                right = {
                    if (query.isNotEmpty()) {
                        Box(Modifier.testTag(AgentSearchTags.CLEAR)) {
                            HeaderIconButton(Ionicon.CloseCircle, stringResource(R.string.agent_search_clear), { query = "" }, iconSize = 20.dp, buttonSize = HomeSpec.actionButton)
                        }
                    }
                },
            )
        } else {
            Header(
                alignment = TitleAlignment.Start,
                background = colors.surface,
                left = { AccountMenuButton(accounts, actions.onSwitchAccount, actions.onAdd) },
                titleContent = { HeaderTitle(name, status) },
                right = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        HeaderAction(AgentHomeTags.SEARCH, Ionicon.SearchOutline, stringResource(R.string.agent_search_open)) { searching = true }
                        HeaderAction(AgentHomeTags.SETTINGS, Ionicon.SettingsOutline, stringResource(R.string.settings_title), actions.onSettings)
                        HeaderAction(AgentHomeTags.COMPOSE, Ionicon.CreateOutline, stringResource(R.string.home_compose), actions.onCompose)
                    }
                },
            )
        }
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                !feed.loaded && status == AgentLinkStatus.Connecting -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.textSecondary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp).testTag(AgentHomeTags.SPINNER))
                }
                !feed.loaded -> Message(
                    tag = AgentHomeTags.OFFLINE,
                    title = when (status) {
                        AgentLinkStatus.Revoked -> null
                        AgentLinkStatus.UpdateRequired -> null
                        else -> stringResource(R.string.agent_home_offline_title, name)
                    },
                    body = statusMessage(status) ?: stringResource(R.string.agent_home_offline_body),
                )
                items.isEmpty() -> Message(
                    tag = AgentHomeTags.EMPTY,
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
                    contentPadding = PaddingValues(top = HomeSpec.contentTop),
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
                        .background(colors.text.copy(alpha = if (colors.dark) 0.16f else 0.12f))
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

@Composable
private fun HeaderAction(tag: String, icon: Ionicon, label: String, onClick: () -> Unit) {
    Box(modifier = Modifier.testTag(tag)) {
        HeaderIconButton(icon = icon, contentDescription = label, onClick = onClick, iconSize = HomeSpec.actionIcon, buttonSize = HomeSpec.actionButton)
    }
}

/** The agent's name; under it, while the link isn't up, how it stands. */
@Composable
private fun HeaderTitle(name: String, status: AgentLinkStatus) {
    val colors = HappyTheme.colors
    Column(modifier = Modifier.wrapContentHeight(unbounded = true)) {
        Text(
            name,
            style = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold),
            color = colors.header.tint,
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        )
        if (status != AgentLinkStatus.Connected) {
            val color = when (status) {
                AgentLinkStatus.Connecting -> colors.status.connecting
                AgentLinkStatus.Offline -> colors.status.disconnected
                else -> colors.status.error
            }
            Row(modifier = Modifier.testTag(AgentHomeTags.STATUS), verticalAlignment = Alignment.CenterVertically) {
                StatusDot(color = color, pulsing = status == AgentLinkStatus.Connecting, size = HomeSpec.statusDot)
                Spacer(Modifier.width(HomeSpec.statusDotGap))
                Text(
                    stringResource(
                        when (status) {
                            AgentLinkStatus.Connecting -> R.string.status_connecting
                            AgentLinkStatus.Offline -> R.string.agent_home_status_offline
                            AgentLinkStatus.Revoked -> R.string.agent_home_status_revoked
                            else -> R.string.agent_home_status_update
                        },
                    ),
                    style = HomeSpec.status,
                    color = color,
                    maxLines = 1,
                )
            }
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
    val colors = HappyTheme.colors
    Text(
        text,
        style = happyTextStyle(fontSize = 14, lineHeight = 20),
        color = colors.textDestructive,
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.surface)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .testTag(AgentHomeTags.BANNER),
    )
}

@Composable
private fun Message(tag: String, title: String?, body: String, action: Pair<String, () -> Unit>? = null) {
    val colors = HappyTheme.colors
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .contentMaxWidth(LocalWindowLayout.current)
                .fillMaxWidth()
                .padding(horizontal = 32.dp, vertical = 72.dp)
                .testTag(tag),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (title != null) {
                Text(title, style = happyTextStyle(fontSize = 20, lineHeight = 26, weight = FontWeight.SemiBold), color = colors.text, textAlign = TextAlign.Center)
            }
            Text(body, style = happyTextStyle(fontSize = 15, lineHeight = 21), color = colors.textSecondary, textAlign = TextAlign.Center)
            if (action != null) {
                Spacer(Modifier.size(16.dp))
                RoundButton(title = action.first, onClick = action.second)
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
    onAppearance: () -> Unit,
) {
    val session = remember(id) { graph.agentSessions.session(id) } ?: return
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val feed by session.feed.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
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
    )
}
