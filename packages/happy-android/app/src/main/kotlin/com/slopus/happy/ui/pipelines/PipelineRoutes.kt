package com.slopus.happy.ui.pipelines

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.pipelines.ClusterPipelines
import com.slopus.happy.pipelines.PipelineNodeLog
import com.slopus.happy.pipelines.PipelineNodeLogSource
import com.slopus.happy.pipelines.PipelineRunSource
import com.slopus.happy.pipelines.PipelineRunView
import com.slopus.happy.pipelines.PipelinesBackend
import com.slopus.happy.pipelines.PipelinesList
import com.slopus.happy.pipelines.PipelinesSource
import com.slopus.happy.ui.page
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.Serializable

/** A Happy Cloud server's pipelines and every run of them, home's Pipelines row. */
@Serializable data class PipelinesRoute(val connectionId: String)

/** One run, live; [pipelineName] is what the page that opened it called its pipeline, until the server says. */
@Serializable data class PipelineRunRoute(val connectionId: String, val runId: String, val pipelineName: String? = null)

/** One node of a run, with its log. */
@Serializable data class PipelineNodeRoute(val connectionId: String, val runId: String, val nodeId: String)

fun NavGraphBuilder.pipelineRoutes(graph: AppGraph, nav: NavHostController) = pipelineRoutes(nav) { connectionId -> rememberPipelines(graph, connectionId) }

/** The pipeline pages, each reading its connection's pipelines through [pipelines] (a debug fixture passes its own). */
fun NavGraphBuilder.pipelineRoutes(nav: NavHostController, pipelines: @Composable (connectionId: String) -> PagePipelines) {
    page<PipelinesRoute> { entry ->
        val connectionId = entry.toRoute<PipelinesRoute>().connectionId
        PipelinesPage(pipelines(connectionId), nav, connectionId)
    }
    page<PipelineRunRoute> { entry ->
        val route = entry.toRoute<PipelineRunRoute>()
        PipelineRunPage(pipelines(route.connectionId), nav, route)
    }
    page<PipelineNodeRoute> { entry ->
        val route = entry.toRoute<PipelineNodeRoute>()
        PipelineNodePage(pipelines(route.connectionId), nav, route)
    }
}

/**
 * A connection's pipelines as the pages read them: the server ([backend]
 * null where the connection is gone), the events that say what to read
 * again, and the names of the agents that start runs.
 */
class PagePipelines(val backend: PipelinesBackend?, val events: SharedFlow<AgentEvent>, val agents: AgentNames)

/** The list page's pipelines and runs, for as long as the page is on the stack. */
internal class PipelinesHolder(pipelines: PagePipelines) : ViewModel() {
    val source: PipelinesSource? = pipelines.backend?.let { PipelinesSource(it, pipelines.events, viewModelScope) }
}

/** A run page's run, followed for as long as the page is on the stack. */
internal class PipelineRunHolder(pipelines: PagePipelines, route: PipelineRunRoute) : ViewModel() {
    val source: PipelineRunSource? = pipelines.backend?.let { PipelineRunSource(it, route.runId, route.pipelineName, pipelines.events, viewModelScope) }
}

/** A node page's run and the node's log. */
internal class PipelineNodeHolder(pipelines: PagePipelines, route: PipelineNodeRoute) : ViewModel() {
    val run: PipelineRunSource? = pipelines.backend?.let { PipelineRunSource(it, route.runId, null, pipelines.events, viewModelScope) }
    val log: PipelineNodeLogSource? = pipelines.backend?.let { PipelineNodeLogSource(it, route.runId, route.nodeId, pipelines.events, viewModelScope) }
}

@Composable
private fun rememberPipelines(graph: AppGraph, connectionId: String): PagePipelines {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    // Agents by the names home shows them by, as they are when a row draws.
    return remember(session) {
        PagePipelines(session?.let { ClusterPipelines(it.client) }, session?.events ?: MutableSharedFlow(), AgentNames { id -> session?.feed?.value?.title(id) })
    }
}

@Composable
private fun PipelinesPage(pipelines: PagePipelines, nav: NavHostController, connectionId: String) {
    val holder = viewModel { PipelinesHolder(pipelines) }
    val source = holder.source
        ?: return PipelinesScreen(PipelinesList(loading = false, failed = true), pipelines.agents, onRetry = {}, onMore = {}, onBack = { nav.popBackStack() })
    val state by source.state.collectAsStateWithLifecycle()
    PipelinesScreen(
        state, pipelines.agents,
        onRetry = source::refresh,
        onMore = source::more,
        onBack = { nav.popBackStack() },
        onOpenRun = { runId -> nav.navigate(PipelineRunRoute(connectionId, runId, state.runs.entries.firstOrNull { it.id == runId }?.pipelineName)) },
    )
}

@Composable
private fun PipelineRunPage(pipelines: PagePipelines, nav: NavHostController, route: PipelineRunRoute) {
    val holder = viewModel { PipelineRunHolder(pipelines, route) }
    val source = holder.source
    val state = source?.state?.collectAsStateWithLifecycle()?.value ?: PipelineRunView(loading = false, failed = true, pipelineName = route.pipelineName)
    PipelineRunScreen(
        state, pipelines.agents,
        onRetry = { source?.refresh() },
        onAbort = { source?.abort() },
        onBack = { nav.popBackStack() },
        onOpenNode = { nodeId -> nav.navigate(PipelineNodeRoute(route.connectionId, route.runId, nodeId)) },
        onOpenRun = { runId -> nav.navigate(PipelineRunRoute(route.connectionId, runId, state.relatives[runId]?.pipelineName)) },
    )
}

@Composable
private fun PipelineNodePage(pipelines: PagePipelines, nav: NavHostController, route: PipelineNodeRoute) {
    val holder = viewModel { PipelineNodeHolder(pipelines, route) }
    val state = holder.run?.state?.collectAsStateWithLifecycle()?.value ?: PipelineRunView(loading = false, failed = true)
    val log = holder.log?.state?.collectAsStateWithLifecycle()?.value ?: PipelineNodeLog(loading = false)
    PipelineNodeScreen(
        state, route.nodeId, log,
        onRetry = {
            holder.run?.refresh()
            holder.log?.refresh()
        },
        onBack = { nav.popBackStack() },
        onOpenRun = { runId -> nav.navigate(PipelineRunRoute(route.connectionId, runId, state.relatives[runId]?.pipelineName)) },
    )
}
