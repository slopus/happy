package com.slopus.happy.ui.surfaces

import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import androidx.compose.runtime.remember
import com.slopus.happy.AppGraph
import com.slopus.happy.ui.documents.DocumentHistoryScreen
import com.slopus.happy.ui.documents.DocumentVersionScreen
import com.slopus.happy.ui.page
import kotlinx.serialization.Serializable

/** One Surface of an agent connection; [name] titles the bar until the catalog has it. */
@Serializable data class SurfaceRoute(val connectionId: String, val surfaceId: String, val name: String = "")

/** A document's history, newest first. */
@Serializable data class DocumentHistoryRoute(val connectionId: String, val surfaceId: String)

/** A document as it stood after change [seq], made by [title]. */
@Serializable data class DocumentVersionRoute(val connectionId: String, val surfaceId: String, val seq: Int, val title: String = "")

/** The Surface screens. Registered once, from the agent connection routes. */
fun NavGraphBuilder.surfaceRoutes(graph: AppGraph, nav: NavHostController) {
    page<SurfaceRoute> { entry ->
        val route = entry.toRoute<SurfaceRoute>()
        SurfaceScreens(graph, route, onBack = { nav.popBackStack() }, open = { nav.navigate(it) })
    }
    page<DocumentHistoryRoute> { entry ->
        val route = entry.toRoute<DocumentHistoryRoute>()
        val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
        if (session == null) SurfaceElsewhere("", onBack = { nav.popBackStack() })
        else DocumentHistoryScreen(session, route.surfaceId, onBack = { nav.popBackStack() }) { seq, title ->
            nav.navigate(DocumentVersionRoute(route.connectionId, route.surfaceId, seq, title))
        }
    }
    page<DocumentVersionRoute> { entry ->
        val route = entry.toRoute<DocumentVersionRoute>()
        val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
        if (session == null) SurfaceElsewhere("", onBack = { nav.popBackStack() })
        else DocumentVersionScreen(session, route.surfaceId, route.seq, route.title, onBack = { nav.popBackStack() })
    }
}

/**
 * Opens a Surface, from wherever it is named (home's row, a Surfaces list,
 * a `happy://surfaces/<id>` link): the screen at once, and a Surface the
 * person isn't in joined on the way (desktop de78af49's
 * `happyAgentRouterSurfaceOpen`), so it takes its place in their list. A
 * refused join is said on the Surface, which stays open.
 */
fun NavHostController.openSurface(graph: AppGraph, connectionId: String, surfaceId: String) {
    val session = graph.agentSessions.session(connectionId)
    val name = session?.surfaces?.value?.get(surfaceId)?.name.orEmpty()
    navigate(SurfaceRoute(connectionId, surfaceId, name))
}
