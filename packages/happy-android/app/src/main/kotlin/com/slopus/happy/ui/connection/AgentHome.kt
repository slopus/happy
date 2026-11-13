package com.slopus.happy.ui.connection

import com.slopus.happy.ui.conversation.refusalText
import androidx.compose.ui.platform.LocalResources
import com.slopus.happy.ui.call.voiceTouch
import com.slopus.happy.ui.call.rememberVoiceTouchSource
import com.slopus.happy.call.CallControl
import androidx.compose.material3.FloatingActionButtonDefaults
import com.slopus.happy.BuildConfig
import androidx.compose.ui.platform.LocalContext
import com.slopus.happy.ui.voice.rememberMicrophonePermission
import com.slopus.happy.ui.call.CallFixtures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.slopus.happy.ui.call.VoiceGlyph
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.height
import androidx.compose.ui.graphics.graphicsLayer
import com.slopus.happy.ui.tablet.LocalSidebarHome
import com.slopus.happy.ui.tablet.SidebarFootBar
import com.slopus.happy.ui.tablet.SidebarSearchField
import com.slopus.happy.ui.tablet.SidebarSpec
import com.slopus.happy.ui.rememberHomeAccountSwitch
import com.slopus.happy.ui.components.PageBackHandler as BackHandler
import androidx.activity.compose.ReportDrawnWhen
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyListState
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
import androidx.compose.runtime.produceState
import com.slopus.happy.search.SearchAnswer
import com.slopus.happy.search.SearchClient
import com.slopus.happy.search.SearchHit
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.RememberObserver
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
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import androidx.compose.ui.text.style.TextOverflow
import androidx.navigation.NavHostController
import androidx.navigation.NavDestination.Companion.hasRoute
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.ui.HomeRoute
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import com.slopus.happy.R
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.conversation.HeldConversations
import com.slopus.happy.ui.conversation.makeConversation
import com.slopus.happy.ui.conversation.Typesetter
import com.slopus.happy.ui.conversation.ProsePalette
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.decode
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.DisposableEffect
import com.slopus.happy.ui.chat.MessageLiftSpec
import androidx.compose.ui.platform.LocalDensity
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.TeamUser
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

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
    /** Opens the agent's artifacts, one Surface, and one artifact. */
    val onOpenArtifacts: () -> Unit = {},
    val onOpenSurface: (AgentFeedRow.Surface) -> Unit = {},
    val onOpenArtifact: (ArtifactRef) -> Unit = {},
    /** Opens the person's Feed on this computer. */
    val onOpenFeed: () -> Unit = {},
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
    val onOpenTodos: () -> Unit = {},
    val onOpenPlugins: () -> Unit = {},
    /** Starts a voice call on this connection ([com.slopus.happy.call.CallController]); null shows no voice button. */
    val onVoice: (() -> Unit)? = null,
    /** Opens a vault's folder ([folder]) or file that search found. */
    val onOpenVaultItem: (surfaceId: String, itemId: String, folder: Boolean, name: String) -> Unit = { _, _, _, _ -> },
    /** The person's role starts work: compose, its picture and the voice call show; a viewer's home has none of them. */
    val canCompose: Boolean = true,
    /** The person's role writes to the Chief of Staff, so settings' asks of it are found by search. */
    val canAskChief: Boolean = true,
    /** Projects belong to self-hosted connections, never Cloud. */
    val projectsAvailable: Boolean = true,
    val notificationsAvailable: Boolean = false,
    /** Opens a team member's profile; null where there are none (any server but Happy Cloud's), and search finds no people. */
    val onOpenPerson: ((userId: String) -> Unit)? = null,
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
 * search bar of the same height, and the results fade in over home on its
 * own ground ([AgentSearchResults]), so opening and closing it moves
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
    /** The computer's refusal of something done here, for a few seconds ([com.slopus.happy.agent.AgentSession.notice]). */
    notice: String? = null,
    /** A held conversation row's preview card inside ([ChatPreviewTranscript]); null holds nothing (iOS bf177c134). */
    preview: (@Composable (AgentFeedRow.Conversation) -> Unit)? = null,
    /** Home's list; [AgentHome] keeps its place across the tablet's breakpoint and the sidebar's hiding ([rememberAgentHomeListState]). */
    listState: LazyListState = rememberLazyListState(),
    /** What search finds beyond home's rows, read while it is open ([AgentSearchSources.read]), with what [searchReads] read. */
    searchSources: suspend (read: Map<String, JsonObject>) -> AgentSearchSources = { AgentSearchSources.None },
    /** What search reads from the computer as it opens that the phone hasn't kept ([AgentSearchSources.reads]). */
    searchReads: suspend () -> Map<String, JsonObject> = { emptyMap() },
    /** Search's daemon half for a query ([AgentSession.search]); null, or answering null, searches the phone alone. */
    search: (suspend (String) -> SearchAnswer?)? = null,
    /** The team members read so far ([com.slopus.happy.agent.TeamDirectory]), whose pictures search's People wear. */
    people: Map<String, TeamUser> = emptyMap(),
    /** Reads the members search found that [people] lacks. */
    wantPeople: (Collection<String>) -> Unit = {},
) {
    val colors = HappyTheme.colors
    val reduceMotion = rememberReduceMotion()
    // As the tablet's sidebar, home wears its chrome (iOS f3ac778cb): search is a field at the top of the list,
    // settings and compose a bar at its foot, and the bar holds the account and its name alone.
    val sidebar = LocalSidebarHome.current
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
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

    val bannerText = noticeMessage(status, profileRequired, notice)
    val atStart = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
    LaunchedEffect(bannerText) {
        // Inserting the notice above a full list otherwise preserves its first
        // keyed row and puts the notice offscreen. Readers at the top see it;
        // readers further down keep their current anchor.
        if (atStart) listState.scrollToItem(0)
    }

    val items = remember(feed) { agentHomeItems(feed) }
    // New work takes the screen, so the search gives it back first (iOS); everything else leaves it for coming back.
    val compose = {
        closeSearch()
        actions.onCompose()
    }
    val searchEntries = rememberSearchEntries(actions, closeSearch)
    val untitled = stringResource(R.string.session_new_chat)
    val artifacts = stringResource(R.string.artifacts_title)
    val feedTitle = stringResource(R.string.feed_title)
    val todos = stringResource(R.string.agent_search_todos)
    val plugins = stringResource(R.string.plugins_title)
    val words = rememberAgentSearchWords()
    // What the phone hasn't kept, read once as search opens; then the sources, again as home changes under it.
    val read by produceState(emptyMap<String, JsonObject>(), searching) {
        value = if (searching) searchReads() else emptyMap()
    }
    val sources by produceState(AgentSearchSources.None, searching, feed, read) {
        if (searching) value = searchSources(read)
    }
    // The daemon's half, asked a moment after the typing stops; a new query cancels the one in flight.
    val remote by produceState<SearchAnswer?>(null, searching, query, search) {
        val asked = query.trim()
        if (!searching || asked.isEmpty() || search == null) {
            value = null
            return@produceState
        }
        delay(SEARCH_DEBOUNCE_MS)
        value = try {
            search(asked)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline or refused: the phone's results alone.
            null
        }
    }
    val results = remember(feed, query, searchEntries, sources, remote) {
        val label = { row: AgentFeedRow ->
            when (row) {
                is AgentFeedRow.Conversation -> row.title ?: untitled
                is AgentFeedRow.Folder -> row.name
                is AgentFeedRow.Surface -> row.name
                AgentFeedRow.Artifacts -> artifacts
                AgentFeedRow.Plugins -> plugins
                is AgentFeedRow.Feed -> feedTitle
                AgentFeedRow.Todos -> todos
                is AgentFeedRow.Section -> null
            }
        }
        // Only the answer to what is typed now joins in; an earlier query's would bring in what no longer answers.
        val answer = remote?.takeIf { it.query == query.trim().take(SearchClient.MAX_QUERY) }
        agentSearchResults(feed, query, label, words, searchEntries.first, searchEntries.second, sources, answer, people = actions.onOpenPerson != null)
    }
    LaunchedEffect(results) {
        val found = results.mapNotNull { (it as? AgentSearchResult.Person)?.userId }
        if (found.isNotEmpty()) wantPeople(found)
    }

    // One ground under the bar and the page, the chat's own (surface), light and dark; the cards sit on it, as on iOS.
    // The bar is glass over the page: the cards scroll on under it, softened.
    val ground = colors.surface
    val phase = when {
        // Nothing read yet: it loads while the link is on its way, which it always is unless something
        // other than the network keeps it away (a pairing to redo, an update, a sign-in), which says so.
        !feed.loaded && !status.needsAction -> HomePhase.Loading
        !feed.loaded -> HomePhase.Unavailable
        // Fixed places alone are no home yet: the first chat is.
        feed.rows.all { it is AgentFeedRow.Section || it == AgentFeedRow.Artifacts || it == AgentFeedRow.Plugins || it is AgentFeedRow.Feed || it == AgentFeedRow.Todos } -> HomePhase.Empty
        else -> HomePhase.List
    }
    val chatPreview = remember { ChatPreview() }
    val previewBlur = with(LocalDensity.current) { MessageLiftSpec.blur.toPx() }
    Box(Modifier.fillMaxSize()) {
        GlassBarLayout(
            modifier = Modifier.fillMaxSize().chatPreviewBackdrop(chatPreview, previewBlur).background(ground),
            ground = ground,
            // Only the list runs under the bar. The other states, and search's results hanging from the bar, are held
            // below its foot, with no feather over them.
            feathered = phase == HomePhase.List && !searching,
            bar = {
                if (searching && sidebar == null) {
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
                            if (sidebar == null) {
                                BarIconButton(Ionicon.SearchOutline, stringResource(R.string.tools_names_search), { searching = true }, Modifier.testTag(AgentHomeTags.SEARCH))
                                BarIconButton(Ionicon.SettingsOutline, stringResource(R.string.settings_title), actions.onSettings, Modifier.testTag(AgentHomeTags.SETTINGS))
                            }
                        },
                        inset = HomeCardSpec.inset,
                    )
                }
            },
        ) { top ->
            Box(modifier = Modifier.fillMaxSize()) {
                val barFoot = top - GlassSpec.feather
                // The sidebar's results start under its search field's rest; the list fades from under them.
                val resultsTop = if (sidebar != null) top + SidebarSpec.searchTop + SidebarSpec.searchHeight + SidebarSpec.searchGap else barFoot
                val listFaded = sidebar != null && searching
                val listAlpha by animateFloatAsState(if (listFaded) 0f else 1f, tween(AgentSearchSpec.FADE_MS, easing = EaseOut), label = "sidebarSearch")
                // The loader fades into what comes, and every state into the next.
                Crossfade(phase, label = "agentHome") { shown ->
                    when (shown) {
                        HomePhase.Loading -> LoadingIndicator(Modifier.padding(top = barFoot).testTag(AgentHomeTags.SPINNER))
                        // Removed keeps a plain glyph, as desktop's errors do.
                        HomePhase.Unavailable -> StatePage(
                            tag = AgentHomeTags.UNAVAILABLE,
                            icon = Ionicon.AlertCircleOutline,
                            title = null,
                            body = statusMessage(status, profileRequired),
                            action = signInAction(status, actions, profileRequired),
                            modifier = Modifier.padding(top = barFoot),
                        )
                        // Desktop's wand beside the button that makes the first chat.
                        HomePhase.Empty -> StatePage(
                            tag = AgentHomeTags.EMPTY,
                            art = if (statusMessage(status, profileRequired) == null) StateArt.Make else null,
                            title = stringResource(R.string.agent_home_empty_title),
                            body = statusMessage(status, profileRequired) ?: stringResource(R.string.agent_home_empty_body),
                            action = signInAction(status, actions, profileRequired) ?: (stringResource(R.string.session_new_chat) to actions.onCompose).takeIf { actions.canCompose },
                            modifier = Modifier.padding(top = barFoot),
                        )
                        HomePhase.List -> AgentHomeList(
                            items = items,
                            state = listState,
                            modifier = if (sidebar != null) Modifier.graphicsLayer { alpha = listAlpha } else Modifier,
                            selected = sidebar?.selected,
                            onOpen = actions.onOpenConversation,
                            onOpenArtifacts = actions.onOpenArtifacts,
                            onOpenFeed = actions.onOpenFeed,
                            onOpenTodos = actions.onOpenTodos,
                            onOpenPlugins = actions.onOpenPlugins,
                            onOpenSurface = actions.onOpenSurface,
                            onLeaveSurface = actions.onLeaveSurface?.let { { surface: AgentFeedRow.Surface -> confirmingLeave = surface } },
                            onHold = preview?.let { { row, source -> chatPreview.open(row, source) } },
                            // The list starts under the glass bar and scrolls on beneath it.
                            contentPadding = PaddingValues(top = top),
                            // The notice is the list's first row (iOS ba0d7da0e): it comes and goes as a row does, the rows it
                            // pushes sliding with it, and a reader further down keeps their place.
                            header = run {
                                val banner = bannerText
                                val action = signInAction(status, actions, profileRequired)
                                val header: LazyListScope.() -> Unit = {
                                    // The sidebar's search at rest: the list's first row, scrolling with it under the bar.
                                    if (sidebar != null) item(key = "search", contentType = "search") {
                                        SidebarSearchField(
                                            open = false,
                                            query = "",
                                            onQueryChange = {},
                                            onOpen = { searching = true },
                                            onCancel = {},
                                            modifier = Modifier
                                                .padding(top = SidebarSpec.searchTop, bottom = SidebarSpec.searchGap)
                                                .graphicsLayer { alpha = if (searching) 0f else 1f },
                                        )
                                    }
                                    if (banner != null) item(key = "banner", contentType = "banner") {
                                        Banner(banner, action, if (reduceMotion) Modifier else Modifier.animateItem(BANNER_FADE_IN, BANNER_PLACEMENT, BANNER_FADE_OUT))
                                    }
                                }
                                header
                            },
                            // Room for the last card to scroll clear of the compose button, or the sidebar's foot.
                            bottom = {
                                if (sidebar != null) Spacer(Modifier.height(SidebarSpec.listClearance()))
                                else Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = AgentHomeSpec.fabClearance))
                            },
                        )
                    }
                }
                if (sidebar == null && feed.loaded && !searching && actions.canCompose) {
                    ComposeFab(actions.onCompose, AgentHomeTags.COMPOSE, stringResource(R.string.agent_search_new_task), onVoice = actions.onVoice)
                }
                // While search is open the sidebar's field holds still at its rest, Cancel beside it, whatever the list did.
                if (sidebar != null && searching) {
                    SidebarSearchField(
                        open = true,
                        query = query,
                        onQueryChange = { query = it },
                        onOpen = {},
                        onCancel = closeSearch,
                        modifier = Modifier.padding(top = top + SidebarSpec.searchTop),
                    )
                }
                // The results fade in over home, which stays exactly as it was under them, and fade away again.
                AnimatedVisibility(
                    visible = searching,
                    enter = fadeIn(tween(AgentSearchSpec.FADE_MS, easing = EaseOut)),
                    exit = fadeOut(tween(AgentSearchSpec.FADE_MS, easing = EaseOut)),
                    modifier = Modifier.padding(top = resultsTop),
                ) {
                    // What a result opens leaves the search as it was, for coming back; only the keyboard goes.
                    AgentSearchResults(
                        query = query,
                        results = results,
                        onOpenConversation = { id ->
                            focus.clearFocus()
                            actions.onOpenConversation(id)
                        },
                        onOpenArtifacts = {
                            focus.clearFocus()
                            actions.onOpenArtifacts()
                        },
                        onOpenFeed = {
                            focus.clearFocus()
                            actions.onOpenFeed()
                        },
                        onOpenTodos = {
                            focus.clearFocus()
                            actions.onOpenTodos()
                        },
                        onOpenPlugins = {
                            focus.clearFocus()
                            actions.onOpenPlugins()
                        },
                        onOpenSurface = { surface ->
                            focus.clearFocus()
                            actions.onOpenSurface(surface)
                        },
                        onOpenArtifact = { artifact ->
                            focus.clearFocus()
                            actions.onOpenArtifact(artifact)
                        },
                        onOpenHit = { hit -> openHit(hit, actions)?.let { open -> { focus.clearFocus(); open() } } },
                        people = people,
                        onOpenPerson = { userId ->
                            focus.clearFocus()
                            actions.onOpenPerson?.invoke(userId)
                        },
                        onPull = { focus.clearFocus() },
                        onClose = closeSearch,
                        selected = sidebar?.selected,
                        bottomClearance = if (sidebar != null) SidebarSpec.listClearance() else 0.dp,
                    )
                }
                // The sidebar's foot stands over home and search's results alike.
                if (sidebar != null) {
                    SidebarFootBar(if (feed.loaded && actions.canCompose) stringResource(R.string.agent_search_new_task) else null, actions.onSettings, compose, onVoice = actions.onVoice)
                }
            }
        }
        // Over the bar too: the whole screen blurs under a held row's preview.
        if (preview != null) ChatPreviewOverlay(chatPreview, actions.onOpenConversation, preview)
    }
    val refusals = LocalResources.current
    LeaveSurfaceDialogs(
        confirming = confirmingLeave,
        refused = leaveRefused,
        onConfirm = { surface ->
            actions.onLeaveSurface?.let { leave ->
                scope.launch { leave(surface)?.let { reason -> leaveRefused = surface.name to refusals.refusalText(reason) } }
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
private enum class HomePhase { Loading, Unavailable, Empty, List }

/** How long the typing rests before the daemon is asked (the design's ~120 ms). */
private const val SEARCH_DEBOUNCE_MS = 120L

/**
 * What a result the daemon found opens, as the phone's own row of the
 * same thing would: its conversation (a message's too), Surface, todo's
 * list, event's calendar, artifact or vault item. A project or worktree opens nothing,
 * as on home.
 */
private fun openHit(hit: SearchHit, actions: AgentHomeActions): (() -> Unit)? = when (hit) {
    is SearchHit.Agent -> { { actions.onOpenConversation(hit.agentId) } }
    is SearchHit.Message -> { { actions.onOpenConversation(hit.agentId) } }
    is SearchHit.Document -> { { actions.onOpenSurface(AgentFeedRow.Surface(hit.surfaceId, hit.name, SurfaceReader.DOCUMENT)) } }
    is SearchHit.Surface -> { { actions.onOpenSurface(AgentFeedRow.Surface(hit.surfaceId, hit.name, hit.surfaceType)) } }
    is SearchHit.Todo -> { { actions.onOpenSurface(AgentFeedRow.Surface(hit.surfaceId, "", SurfaceReader.TODO)) } }
    is SearchHit.CalendarEvent -> { { actions.onOpenSurface(AgentFeedRow.Surface(hit.surfaceId, "", "calendar")) } }
    is SearchHit.Artifact -> { { actions.onOpenArtifact(ArtifactRef(hit.artifactId, 1, hit.artifactType, hit.title, followsLatest = true)) } }
    is SearchHit.VaultFile -> { { actions.onOpenVaultItem(hit.surfaceId, hit.fileId, false, hit.name) } }
    is SearchHit.VaultFolder -> { { actions.onOpenVaultItem(hit.surfaceId, hit.folderId, true, hit.name) } }
    is SearchHit.User -> actions.onOpenPerson?.let { open -> { open(hit.userId) } }
    is SearchHit.Project, is SearchHit.Workspace -> null
}

/** Search's section headings and the kinds' names, in the person's language. */
@Composable
private fun rememberAgentSearchWords(): AgentSearchWords {
    val resources = LocalContext.current.resources
    val configuration = LocalConfiguration.current
    return remember(resources, configuration) {
        AgentSearchWords(
            actions = resources.getString(R.string.agent_search_actions),
            settings = resources.getString(R.string.settings_title),
            surfaceType = { type -> resources.getString(surfaceTypeName(type)) },
            artifactType = { type -> resources.getString(artifactTypeName(type)) },
            task = resources.getString(R.string.new_work_task),
            subtask = resources.getString(R.string.agent_page_subtask),
            bot = resources.getString(R.string.new_work_bot),
            chat = resources.getString(R.string.agent_search_kind_chat),
            shared = resources.getString(R.string.agent_search_kind_shared),
            done = resources.getString(R.string.todo_done),
            agent = resources.getString(R.string.agent_search_by_agent),
            people = resources.getString(R.string.agent_search_people),
            notJoined = resources.getString(R.string.agent_search_not_joined),
            taskNotJoined = resources.getString(R.string.agent_search_task_not_joined),
            openTodos = { count -> resources.getQuantityString(R.plurals.agent_search_open_todos, count, count) },
        )
    }
}

/** A Surface kind's name (desktop's `surfaceTypeLabel`), which a query finds it by too. */
private fun surfaceTypeName(type: String): Int = when (type) {
    SurfaceReader.TODO -> R.string.agent_search_kind_todo
    "calendar" -> R.string.agent_search_kind_calendar
    "system_monitor" -> R.string.agent_search_kind_system_monitor
    "vault" -> R.string.vaults_kind
    "chat" -> R.string.agent_search_kind_chat
    else -> R.string.agent_search_kind_document
}

/** An artifact type's name (desktop's `happyAgentArtifactTypeLabel`). */
private fun artifactTypeName(type: String): Int = when (type) {
    "markdown" -> R.string.agent_search_kind_markdown
    "html" -> R.string.agent_search_kind_web_page
    "image" -> R.string.agent_search_kind_image
    "image_series" -> R.string.agent_search_kind_image_series
    "video" -> R.string.agent_search_kind_video
    "document" -> R.string.agent_search_kind_document
    "gen_ui" -> R.string.artifact_kind_gen_ui
    else -> R.string.agent_search_kind_artifact
}

/**
 * The quick actions and settings search offers, and where each goes. The
 * settings are the connection's settings rows ([agentSettingsIndex], iOS's
 * `SettingsIndex.computer`): one opens its page at the row, flashing it.
 */
@Composable
private fun rememberSearchEntries(actions: AgentHomeActions, endSearch: () -> Unit): Pair<List<AgentSearchEntry>, List<AgentSearchEntry>> {
    val end by rememberUpdatedState(endSearch)
    val newTask = stringResource(R.string.agent_search_new_task)
    val newTaskPicture = stringResource(R.string.agent_search_new_task_picture)
    val connect = stringResource(R.string.agent_search_connect_agent)
    val scan = stringResource(R.string.onboarding_scan_button)
    val openSettings = stringResource(R.string.agent_search_open_settings)
    val index = agentSettingsIndex(projectsAvailable = actions.projectsAvailable, notificationsAvailable = actions.notificationsAvailable)
    return remember(actions, newTask, newTaskPicture, connect, scan, openSettings, index) {
        // happy-ios HomeViewController.quickActions (7a605f6ce). Connect and Scan both open the
        // scanner here: Android's one Add scanner takes a computer's, a terminal's or an agent's code.
        listOfNotNull(
            // New work takes the screen, so the search gives it back first.
            AgentSearchEntry("new-work", newTask, Ionicon.CreateOutline) { end(); actions.onCompose() }.takeIf { actions.canCompose },
            AgentSearchEntry("new-work-picture", newTaskPicture, Ionicon.ImageOutline) { end(); actions.onComposeWithPicture() }.takeIf { actions.canCompose },
            AgentSearchEntry("connect-agent", connect, Ionicon.LaptopOutline, actions.onAdd),
            AgentSearchEntry("scan", scan, Ionicon.QrCodeOutline, actions.onAdd),
            AgentSearchEntry("settings", openSettings, Ionicon.SettingsOutline, actions.onSettings),
        ) to index.filter { it.place != AgentSettingsPlace.Ask || actions.canAskChief }.map { row -> AgentSearchEntry(row.id, row.title, row.icon) { actions.onSettingsRow(row) } }
    }
}

/**
 * A home's compose: a floating button at the bottom end of the content
 * column (so on a tablet it stays with the rows), clear of the navigation
 * bar. Put it last in a box over the page. With [onVoice], an agent
 * connection's home has the voice call's button immediately left of it,
 * the same size, [AgentHomeSpec.fabGap] apart (iOS's toolbar item beside
 * compose), wearing the three bars ([VoiceGlyph]).
 */
@Composable
internal fun BoxScope.ComposeFab(onClick: () -> Unit, tag: String, label: String = stringResource(R.string.session_new_chat), onVoice: (() -> Unit)? = null) {
    Box(Modifier.align(Alignment.BottomCenter).contentMaxWidth(LocalWindowLayout.current)) {
        Row(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(AgentHomeSpec.fabMargin),
            horizontalArrangement = Arrangement.spacedBy(AgentHomeSpec.fabGap),
        ) {
            if (onVoice != null) {
                val voiceLabel = stringResource(R.string.call_start)
                FloatingActionButton(onClick = onVoice, modifier = Modifier.testTag(AgentHomeTags.VOICE).semantics { contentDescription = voiceLabel }) {
                    VoiceGlyph(24.dp, LocalContentColor.current)
                }
            }
            // The call's press of compose ([VoiceTouch]): its light inside the button, and the button's own press.
            val voice = rememberVoiceTouchSource()
            val shape = FloatingActionButtonDefaults.shape
            FloatingActionButton(onClick = onClick, modifier = Modifier.testTag(tag), shape = shape, interactionSource = voice) {
                Box(Modifier.size(56.dp).voiceTouch(CallControl.Compose, shape, voice), contentAlignment = Alignment.Center) {
                    Icon(Ionicon.CreateOutline, 24.dp, LocalContentColor.current, contentDescription = label)
                }
            }
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
 * The notice heading home's list: why the agent can't be reached until
 * something is done, or the computer's refusal of something done here (iOS
 * SyncEngine's `notice`). A link that is only on its way says so in the
 * title alone ([BarTitle]).
 */
@Composable
private fun noticeMessage(status: AgentLinkStatus, profileRequired: Boolean, refusal: String?): String? =
    statusMessage(status, profileRequired) ?: refusal?.takeIf { it.isNotBlank() }?.let { LocalResources.current.refusalText(it) }

/** Kept away by something other than the network, which [statusMessage] says: the link waits on the person. */
private val AgentLinkStatus.needsAction: Boolean
    get() = this == AgentLinkStatus.Revoked || this == AgentLinkStatus.UpdateRequired || this == AgentLinkStatus.SignInRequired

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
    onOpenArtifact: (ArtifactRef) -> Unit = {},
    onOpenFeed: () -> Unit = {},
    /** Signs the team server at [server] in again ([AgentConnection.server]). */
    onSignIn: (server: String) -> Unit = {},
    onOpenTodos: () -> Unit = {},
    onOpenPlugins: () -> Unit = {},
    onOpenVaultItem: (surfaceId: String, itemId: String, folder: Boolean, name: String) -> Unit = { _, _, _, _ -> },
    /** Opens a team member's profile, which only a Happy Cloud server has. */
    onOpenPerson: (userId: String) -> Unit = {},
) {
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val connection = agents.firstOrNull { it.id == id } ?: return
    // A team server whose session ended shows its Sign in and nothing else; signed in again, a new session opens.
    if (connection.sessionEnded) {
        val add = LocalAddFlow.current
        AgentSignedOutHome(
            name = connection.name.takeIf { it.isNotBlank() } ?: stringResource(R.string.account_kind_agent),
            accounts = rememberAccountMenu(graph),
            onSwitchAccount = rememberHomeAccountSwitch(graph),
            onAdd = { add?.scan() },
            onSignIn = { connection.server?.let(onSignIn) },
        )
        return
    }
    SignedInAgentHome(graph, id, agents, onOpenConversation, onCompose, onSettings, onSettingsRow, onComposeWithPicture, onOpenArtifacts, onOpenSurface, onOpenArtifact, onOpenFeed, onSignIn, onOpenTodos, onOpenPlugins, onOpenVaultItem, onOpenPerson)
}

/**
 * Home for a team server whose session ended ([AgentConnection.sessionEnded]):
 * the account menu to go elsewhere, the server's name, and Sign in again.
 * Nothing of the server shows, as nothing of it is kept.
 */
@Composable
fun AgentSignedOutHome(
    name: String,
    accounts: AccountMenu,
    onSwitchAccount: (String) -> Unit,
    onAdd: () -> Unit,
    onSignIn: () -> Unit,
) {
    val ground = HappyTheme.colors.surface
    GlassBarLayout(
        modifier = Modifier.fillMaxSize().background(ground),
        ground = ground,
        feathered = false,
        bar = {
            AgentTopBar(
                tag = AgentHomeTags.BAR,
                container = ground,
                navigationIcon = { AccountMenuButton(accounts, onSwitchAccount, onAdd) },
                title = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(AgentHomeTags.TITLE)) },
                inset = HomeCardSpec.inset,
            )
        },
    ) { top ->
        StatePage(
            tag = AgentHomeTags.SIGNED_OUT,
            icon = Ionicon.LogIn,
            title = null,
            body = stringResource(R.string.team_server_error_sign_in_required),
            action = stringResource(R.string.team_server_sign_in_again) to onSignIn,
            modifier = Modifier.padding(top = top - GlassSpec.feather),
        )
    }
}

/**
 * Back to home when the open connection [connectionId]'s team server
 * session ends with a page of it over home: none stays up, as nothing of
 * it is kept. Only on the change, so a sign-in under way stays.
 */
@Composable
internal fun SessionEndedEffect(graph: AppGraph, nav: NavHostController, connectionId: String?) {
    if (connectionId == null) return
    LaunchedEffect(graph, nav, connectionId) {
        graph.agentConnections.accounts
            .map { list -> list.firstOrNull { it.id == connectionId }?.sessionEnded == true }
            .distinctUntilChanged()
            .drop(1)
            .collect { ended ->
                if (ended && nav.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == false) nav.popBackStack<HomeRoute>(inclusive = false)
            }
    }
}

@Composable
private fun SignedInAgentHome(
    graph: AppGraph,
    id: String,
    agents: List<AgentConnection>,
    onOpenConversation: (agentId: String) -> Unit,
    onCompose: () -> Unit,
    onSettings: () -> Unit,
    onSettingsRow: (AgentSettingsRow) -> Unit,
    onComposeWithPicture: () -> Unit,
    onOpenArtifacts: () -> Unit,
    onOpenSurface: (AgentFeedRow.Surface) -> Unit,
    onOpenArtifact: (ArtifactRef) -> Unit,
    onOpenFeed: () -> Unit,
    onSignIn: (server: String) -> Unit,
    onOpenTodos: () -> Unit,
    onOpenPlugins: () -> Unit,
    onOpenVaultItem: (surfaceId: String, itemId: String, folder: Boolean, name: String) -> Unit,
    onOpenPerson: (userId: String) -> Unit,
) {
    val session = remember(id) { graph.agentSessions.session(id) } ?: return
    val people by session.team.users.collectAsStateWithLifecycle()
    val feed by session.feed.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    val notice by session.notice.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val link = rememberShownLinkState(status.linkState(syncing, rememberNetworkPath()))
    // Fully drawn (cold start's timeToFullDisplay, research/cold-start.md): home past its loader.
    ReportDrawnWhen { feed.loaded || status != AgentLinkStatus.Connecting }
    val add = LocalAddFlow.current
    val switchAccount = rememberHomeAccountSwitch(graph)
    val microphone = rememberMicrophonePermission()
    val voice = remember(graph, id, microphone) { { graph.calls.start(id) { microphone.request().granted } } }
    if (BuildConfig.DEBUG) CallLaunchHooks(graph, voice)
    val permissions by session.permissions.collectAsStateWithLifecycle()
    val canCompose = permissions.canWrite
    val canAskChief = permissions.allows(com.slopus.happy.agent.Permission.BOTS_MANAGE)
    val actions = remember(graph, session, onOpenConversation, onCompose, onComposeWithPicture, onSettings, onSettingsRow, onOpenArtifacts, onOpenSurface, onOpenArtifact, onOpenFeed, add, switchAccount, onSignIn, onOpenTodos, onOpenPlugins, voice, onOpenVaultItem, onOpenPerson, canCompose, canAskChief) {
        AgentHomeActions(
            onOpenConversation = onOpenConversation,
            onCompose = onCompose,
            onComposeWithPicture = onComposeWithPicture,
            onSettings = onSettings,
            onSettingsRow = onSettingsRow,
            onSwitchAccount = switchAccount,
            onAdd = { add?.scan() },
            onOpenArtifacts = onOpenArtifacts,
            onOpenTodos = onOpenTodos,
            onOpenPlugins = onOpenPlugins,
            onOpenSurface = onOpenSurface,
            onOpenArtifact = onOpenArtifact,
            onOpenFeed = onOpenFeed,
            onLeaveSurface = { session.leaveSurface(it.id) },
            onSignIn = { graph.agentConnections.accounts.value.firstOrNull { it.id == id }?.server?.let(onSignIn) },
            onVoice = voice.takeIf { canCompose },
            onOpenVaultItem = onOpenVaultItem,
            canCompose = canCompose,
            canAskChief = canAskChief,
            projectsAvailable = !session.client.cloud,
            notificationsAvailable = session.client.cloud,
            onOpenPerson = onOpenPerson.takeIf { session.client.cloud },
        )
    }
    CompositionLocalProvider(LocalAgentPictures provides session.pictures) {
        AgentHomeScreen(
            name = agents.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.account_kind_agent),
            feed = feed,
            status = status,
            accounts = rememberAccountMenu(graph),
            actions = actions,
            profileRequired = agents.firstOrNull { it.id == id }?.profileRequired == true,
            link = link,
            notice = notice,
            preview = { row -> ConversationPreview(session, row, settings.userMessageBubbleColor) },
            listState = rememberAgentHomeListState(graph, id),
            searchSources = remember(session) {
                { read -> withContext(Dispatchers.IO) { AgentSearchSources.read(session.catalog.value, session.feed.value, { key -> session.cachedResource(key) ?: read[key] }, session.intents.pending.value) } }
            },
            searchReads = remember(session) {
                { withContext(Dispatchers.IO) { AgentSearchSources.reads(session.feed.value, session::cachedResource) { path -> session.client.decode<JsonObject>("GET", path) } } }
            },
            search = remember(session) { { query -> session.search(query) } },
            people = people,
            wantPeople = remember(session) { { ids -> session.team.want(ids) } },
        )
    }
}

/**
 * A held row's conversation for its preview card: the kept history at
 * once, then the computer's, read only. Never shown as visible, so it
 * marks nothing read (iOS: "A preview is only looked at").
 */
@Composable
private fun ConversationPreview(session: AgentSession, row: AgentFeedRow.Conversation, bubbleColor: String?) {
    val colors = HappyTheme.colors
    val typesetter = Typesetter.of(LocalContext.current)
    typesetter.reportPalette(ProsePalette.of(colors))
    // The agent's one conversation, the one its screen or a call may hold too: never shown, so never marked read from here.
    val conversation = remember(session, row.agentId) {
        PreviewHold(session.conversations.hold(row.agentId) { session.makeConversation(row.agentId, typesetter) })
    }.hold.conversation
    val state by conversation.state.collectAsStateWithLifecycle()
    val actions = remember(conversation) { ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = conversation::media) }
    ChatPreviewTranscript(row.title ?: stringResource(R.string.session_new_chat), state, userMessageBubblePalette(bubbleColor, colors.dark), actions)
}

/**
 * The preview's hold, taken as it composes and let go however that ends:
 * forgotten when the preview goes, or abandoned by a composition that never
 * applied, so it never outlives the preview.
 */
internal class PreviewHold(val hold: HeldConversations.Hold) : RememberObserver {
    override fun onRemembered() {}
    override fun onForgotten() = hold.release()
    override fun onAbandoned() = hold.release()
}

/**
 * Where each agent connection's home list sits (first item, offset), out
 * here because the tablet shell swaps the phone's home for the sidebar's at
 * the breakpoint, and the sidebar leaves while hidden, which throws the list
 * away (iOS 50f34ed9f keeps its rows in place). Keyed by connection, so one
 * never opens on another's place; as legacy home's
 * [com.slopus.happy.ui.home.HomeServices.homeListOffsets].
 */
private val agentHomePlaces = WeakHashMap<AppGraph, ConcurrentHashMap<String, Pair<Int, Int>>>()

internal fun agentHomePlaces(graph: AppGraph): ConcurrentHashMap<String, Pair<Int, Int>> =
    synchronized(agentHomePlaces) { agentHomePlaces.getOrPut(graph) { ConcurrentHashMap() } }

/** Home's list for connection [id], rebuilt where it last was and recording where it goes. */
@Composable
internal fun rememberAgentHomeListState(graph: AppGraph, id: String): LazyListState {
    val places = remember(graph) { agentHomePlaces(graph) }
    val state = remember(id) {
        val saved = places[id]
        LazyListState(saved?.first ?: 0, saved?.second ?: 0)
    }
    LaunchedEffect(state, id) {
        snapshotFlow { state.firstVisibleItemIndex to state.firstVisibleItemScrollOffset }
            .distinctUntilChanged()
            .collect { places[id] = it }
    }
    return state
}

/**
 * Debug builds only, for screenshots and test runs: an intent's
 * `happy.call.fixture` draws the call's bar in one state from a script (no
 * microphone, provider or grant), `happy.call.tap` presses the voice button
 * once, for real. `happy.call.intro` (`due`, `seen`), `happy.call.used`
 * and `happy.call.offer` (a price) set voice's sheets up
 * ([CallController.applyTestEnvironment]); `happy.call.steps` then presses
 * what a person would, one step every 3 s: `tap` the voice button,
 * `session` or `close` on voice's sheet. Each step logs what is up
 * (`call-steps`).
 */
@Composable
private fun CallLaunchHooks(graph: AppGraph, voice: () -> Unit) {
    val intent = (LocalContext.current as? android.app.Activity)?.intent ?: return
    LaunchedEffect(intent) {
        val delayMillis = intent.getLongExtra("happy.call.delay", 0L)
        val fixture = intent.getStringExtra("happy.call.fixture")
        val tap = intent.getBooleanExtra("happy.call.tap", false)
        val steps = intent.getStringExtra("happy.call.steps")?.split(",")
        graph.calls.applyTestEnvironment(intent.getStringExtra("happy.call.intro"), intent.getBooleanExtra("happy.call.used", false), intent.getStringExtra("happy.call.offer"))
        for (extra in listOf("happy.call.fixture", "happy.call.tap", "happy.call.steps", "happy.call.intro", "happy.call.used", "happy.call.offer")) intent.removeExtra(extra)
        if (fixture == null && !tap && steps == null) return@LaunchedEffect
        kotlinx.coroutines.delay(delayMillis)
        if (fixture != null) CallFixtures.show(graph.calls, fixture)
        if (tap) voice()
        for (step in steps.orEmpty()) {
            kotlinx.coroutines.delay(3_000)
            when (step) {
                "tap" -> voice()
                "session" -> graph.offers.start()
                "close" -> graph.offers.dismiss()
            }
            kotlinx.coroutines.delay(1_000)
            android.util.Log.i("call-steps", "$step -> ${graph.calls.testSummary}")
        }
        if (steps != null) android.util.Log.i("call-steps", "done")
    }
}
