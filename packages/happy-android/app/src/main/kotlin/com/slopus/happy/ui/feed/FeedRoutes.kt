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
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedRow
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.feed.FeedTarget
import com.slopus.happy.ui.artifacts.openArtifact
import com.slopus.happy.ui.connection.AgentSurfaceRoute
import com.slopus.happy.ui.conversation.openConversation
import com.slopus.happy.ui.page
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

/** The Feed's screen. AgentConnectionRoutes registers it with the agent's other places. */
fun NavGraphBuilder.feedRoutes(graph: AppGraph, nav: NavHostController) {
    page<AgentFeedRoute> { entry -> AgentFeed(graph, nav, entry.toRoute()) }
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
    // The newest page each time the Feed opens; what entries name that the catalog doesn't hold, as they come.
    LaunchedEffect(library) { library.refresh() }
    LaunchedEffect(state.items) { lookups.want(state.items) }
    val rows by produceState(emptyList<FeedRow>(), state, catalog, found) {
        value = withContext(Dispatchers.Default) { FeedRows.make(state.items, state::isUnread, catalog, found, route.connectionId) }
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
                    when (val target = row.target) {
                        is FeedTarget.Chat -> nav.openConversation(route.connectionId, target.agentId)
                        is FeedTarget.Surface -> nav.navigate(AgentSurfaceRoute(route.connectionId, target.id, target.type, target.name))
                        is FeedTarget.Artifact -> nav.openArtifact(route.connectionId, target.ref)
                        null -> Unit
                    }
                },
                onRefresh = library::refresh,
                onLoadMore = library::loadMore,
                onReadAll = { scope.launch { library.readAll() } },
                onReadFollowing = following::read,
                onFollow = following::follow,
                onRefusalSeen = following::refusalSeen,
            )
        },
    )
}
