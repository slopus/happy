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
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.pipelines.ClusterPipelines
import com.slopus.happy.pipelines.PipelinesList
import com.slopus.happy.pipelines.PipelinesSource
import com.slopus.happy.ui.page
import kotlinx.serialization.Serializable

/** A Happy Cloud server's pipelines and every run of them, home's Pipelines row. */
@Serializable data class PipelinesRoute(val connectionId: String)

fun NavGraphBuilder.pipelineRoutes(graph: AppGraph, nav: NavHostController) = pipelineRoutes(nav) { connectionId -> rememberPipelines(graph, connectionId) }

/** The pipeline pages, each reading its connection's pipelines through [pipelines] (a debug fixture passes its own). */
fun NavGraphBuilder.pipelineRoutes(nav: NavHostController, pipelines: @Composable (connectionId: String) -> PagePipelines) {
    page<PipelinesRoute> { entry ->
        PipelinesPage(pipelines(entry.toRoute<PipelinesRoute>().connectionId), nav)
    }
}

/** A page's pipelines and the names of the agents that start runs; [source] null where the connection is gone. */
class PagePipelines(val source: PipelinesSource?, val agents: AgentNames)

/** One page's view of the connection's pipelines, for as long as the page is on the stack. */
internal class PipelinesHolder(session: AgentSession?) : ViewModel() {
    val source: PipelinesSource? = session?.let { PipelinesSource(ClusterPipelines(it.client), it.events, viewModelScope) }
}

@Composable
private fun rememberPipelines(graph: AppGraph, connectionId: String): PagePipelines {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val holder = viewModel { PipelinesHolder(session) }
    // Agents by the names home shows them by, as they are when a row draws.
    return remember(holder, session) { PagePipelines(holder.source, AgentNames { id -> session?.feed?.value?.title(id) }) }
}

@Composable
private fun PipelinesPage(pipelines: PagePipelines, nav: NavHostController) {
    val source = pipelines.source
        ?: return PipelinesScreen(PipelinesList(loading = false, failed = true), pipelines.agents, onRetry = {}, onMore = {}, onBack = { nav.popBackStack() })
    val state by source.state.collectAsStateWithLifecycle()
    PipelinesScreen(state, pipelines.agents, onRetry = source::refresh, onMore = source::more, onBack = { nav.popBackStack() })
}
