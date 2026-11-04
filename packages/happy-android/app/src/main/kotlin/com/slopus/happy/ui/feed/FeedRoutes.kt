package com.slopus.happy.ui.feed

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.feed.FeedCluster
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedRow
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.feed.FeedTarget
import com.slopus.happy.ui.artifacts.openArtifact
import com.slopus.happy.ui.conversation.openConversation
import com.slopus.happy.ui.page
import com.slopus.happy.ui.surfaces.openSurface
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** The person's Feed on one agent connection, home's Feed row. */
@Serializable data class AgentFeedRoute(val connectionId: String)

/** One place's newest entries, a place tapped in Following. */
@Serializable data class AgentFeedPeekRoute(val connectionId: String, val cluster: String, val kind: String) {
    val feedCluster: FeedCluster get() = FeedCluster(cluster, kind)
}

/** The Feed's screen. AgentConnectionRoutes registers it with the agent's other places. */
fun NavGraphBuilder.feedRoutes(graph: AppGraph, nav: NavHostController) {
    page<AgentFeedRoute> { entry ->
        val route = entry.toRoute<AgentFeedRoute>()
        WithPictures(graph, route.connectionId) { AgentFeed(graph, nav, route) }
    }
    page<AgentFeedPeekRoute> { entry ->
        val route = entry.toRoute<AgentFeedPeekRoute>()
        WithPictures(graph, route.connectionId) { AgentFeedPeek(graph, nav, route) }
    }
}

/** The connection's pictures for the faces drawn under [content] (a bot's avatar, a member's photo): without them only their ThumbHashes show. */
@Composable
internal fun WithPictures(graph: AppGraph, connectionId: String, content: @Composable () -> Unit) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.connection.LocalAgentPictures provides session?.pictures, content = content)
}

/**
 * Following's places, read from the computer each time it shows, as
 * desktop's are (iOS `FeedViewController.readClusters`), and a follow or
 * mute sent from it.
 */
internal class FeedFollowing(private val scope: CoroutineScope, private val library: FeedLibrary) {
    private val stateFlow = MutableStateFlow(FeedFollowingState())
    val state: StateFlow<FeedFollowingState> = stateFlow.asStateFlow()
    private var reading: Job? = null

    fun read() {
        reading?.cancel()
        reading = scope.launch {
            try {
                val clusters = library.clusters()
                stateFlow.update { it.copy(clusters = clusters, loaded = true, failed = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // What was read stays; with nothing read, it says why.
                stateFlow.update { it.copy(loaded = true, failed = it.clusters.isEmpty()) }
            }
        }
    }

    fun follow(cluster: String, follows: Boolean) {
        if (cluster in stateFlow.value.pending) return
        stateFlow.update { it.copy(pending = it.pending + cluster) }
        scope.launch {
            try {
                val changed = library.follow(cluster, follows)
                stateFlow.update { now -> now.copy(clusters = now.clusters.map { if (it.cluster == changed.cluster) changed else it }, pending = now.pending - cluster) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stateFlow.update { it.copy(pending = it.pending - cluster, refused = e.message.orEmpty()) }
            }
        }
    }

    fun refusalSeen() = stateFlow.update { it.copy(refused = null) }
}

/** A peek at [cluster], read from the computer each time it is asked (iOS `FeedPeekViewController.read`). */
internal class FeedPeeking(private val scope: CoroutineScope, private val library: FeedLibrary, private val cluster: String) {
    private val stateFlow = MutableStateFlow(FeedPeekState())
    val state: StateFlow<FeedPeekState> = stateFlow.asStateFlow()
    private var reading: Job? = null

    fun read() {
        reading?.cancel()
        stateFlow.update { it.copy(refreshing = true) }
        reading = scope.launch {
            try {
                val items = library.peek(cluster)
                stateFlow.value = FeedPeekState(items, loaded = true)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // What was read stays; with nothing read, it says why.
                stateFlow.update { it.copy(loaded = true, failed = it.items.isEmpty(), refreshing = false) }
            }
        }
    }
}

private class FeedHolder(session: AgentSession?) : ViewModel() {
    val following: FeedFollowing? = session?.let { FeedFollowing(viewModelScope, it.feedLibrary) }
}

@Composable
private fun AgentFeed(graph: AppGraph, nav: NavHostController, route: AgentFeedRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val holder = viewModel { FeedHolder(session) }
    val following = holder.following
    if (session == null || following == null) {
        FeedScreen(FeedLibrary.State(available = false, loaded = true), emptyList(), AgentCatalog(loaded = true), FeedFollowingState(loaded = true), FeedActions(onBack = { nav.popBackStack() }))
        return
    }
    val library = session.feedLibrary
    val lookups = session.feedLookups
    val state by library.state.collectAsStateWithLifecycle()
    val catalog by session.catalog.collectAsStateWithLifecycle()
    val found by lookups.found.collectAsStateWithLifecycle()
    val places by following.state.collectAsStateWithLifecycle()
    val photo = rememberProfilePhoto(session)
    val users by session.team.users.collectAsStateWithLifecycle()
    // The newest page each time the Feed opens; what entries name that the catalog doesn't hold, as they come.
    LaunchedEffect(library) { library.refresh() }
    LaunchedEffect(state.items) { lookups.want(state.items) }
    LaunchedEffect(state.items, catalog.userId) { session.team.want(FeedRows.people(state.items, catalog)) }
    val rows by produceState(emptyList<FeedRow>(), state, catalog, found, photo, users) {
        value = withContext(Dispatchers.Default) { FeedRows.make(state.items, state::isUnread, catalog, found, route.connectionId, photo, users) }
    }
    val scope = holder.viewModelScope
    FeedScreen(
        state = state,
        rows = rows,
        catalog = catalog,
        following = places,
        actions = remember(library, following, nav) {
            FeedActions(
                onBack = { nav.popBackStack() },
                onOpen = { row ->
                    library.state.value.items.firstOrNull { it.id == row.id }?.let { scope.launch { library.open(it) } }
                    nav.openFeedTarget(graph, route.connectionId, row.target)
                },
                onRefresh = library::refresh,
                onLoadMore = library::loadMore,
                onReadAll = { scope.launch { library.readAll() } },
                onReadFollowing = following::read,
                onFollow = following::follow,
                onPeek = { cluster -> nav.navigate(AgentFeedPeekRoute(route.connectionId, cluster.cluster, cluster.kind)) },
                onRefusalSeen = following::refusalSeen,
            )
        },
    )
}

/** The person's profile photo's ThumbHash, read and then followed, for their face on the Feed. */
@Composable
private fun rememberProfilePhoto(session: AgentSession): String? {
    LaunchedEffect(session) { session.profile.refresh() }
    val profile by session.profile.state.collectAsStateWithLifecycle()
    return profile.thumbhash
}

/**
 * Where a Feed row goes (iOS `FeedOpening`): a task's or bot's chat, a
 * Surface's screen, an artifact's viewer. Chats count themselves read;
 * Surfaces and artifacts tell the Feed they were opened.
 */
private fun NavHostController.openFeedTarget(graph: AppGraph, connectionId: String, target: FeedTarget?) {
    when (target) {
        is FeedTarget.Chat -> openConversation(connectionId, target.agentId)
        is FeedTarget.Surface -> openSurface(graph, connectionId, target.id)
        is FeedTarget.Artifact -> openArtifact(connectionId, target.ref)
        null -> Unit
    }
}

private class FeedPeekHolder(session: AgentSession?, cluster: String) : ViewModel() {
    val peeking: FeedPeeking? = session?.let { FeedPeeking(viewModelScope, it.feedLibrary, cluster).also(FeedPeeking::read) }
}

@Composable
private fun AgentFeedPeek(graph: AppGraph, nav: NavHostController, route: AgentFeedPeekRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val holder = viewModel { FeedPeekHolder(session, route.cluster) }
    val peeking = holder.peeking
    val words = rememberFeedWords()
    if (session == null || peeking == null) {
        FeedPeekScreen("", FeedPeekState(loaded = true, failed = true), emptyList(), AgentCatalog(loaded = true), FeedActions(onBack = { nav.popBackStack() }))
        return
    }
    val lookups = session.feedLookups
    val peek by peeking.state.collectAsStateWithLifecycle()
    val catalog by session.catalog.collectAsStateWithLifecycle()
    val found by lookups.found.collectAsStateWithLifecycle()
    val photo = rememberProfilePhoto(session)
    val users by session.team.users.collectAsStateWithLifecycle()
    LaunchedEffect(peek.items) { lookups.want(peek.items) }
    LaunchedEffect(peek.items, catalog.userId) { session.team.want(FeedRows.people(peek.items, catalog)) }
    // None carries the dot: a peek reads nothing.
    val rows by produceState(emptyList<FeedRow>(), peek, catalog, found, photo, users) {
        value = withContext(Dispatchers.Default) { FeedRows.make(peek.items, { false }, catalog, found, route.connectionId, photo, users) }
    }
    // The place's own name, as it is now.
    val title = remember(catalog, words) { FeedPlace.of(route.feedCluster, catalog, words)?.name.orEmpty() }
    FeedPeekScreen(
        title = title,
        peek = peek,
        rows = rows,
        catalog = catalog,
        actions = remember(peeking, nav) {
            FeedActions(
                onBack = { nav.popBackStack() },
                onOpen = { row -> nav.openFeedTarget(graph, route.connectionId, row.target) },
                onRefresh = peeking::read,
            )
        },
    )
}
