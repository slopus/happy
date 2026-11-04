package com.slopus.happy.ui.surfaces

import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.ui.page
import kotlinx.serialization.Serializable

/** One Surface of an agent connection; [name] titles the bar until the catalog has it. */
@Serializable data class SurfaceRoute(val connectionId: String, val surfaceId: String, val name: String = "")

/** The Surface screens. Registered once, from the agent connection routes. */
fun NavGraphBuilder.surfaceRoutes(graph: AppGraph, nav: NavHostController) {
    page<SurfaceRoute> { entry ->
        val route = entry.toRoute<SurfaceRoute>()
        SurfaceScreens(graph, route, onBack = { nav.popBackStack() }, open = { nav.navigate(it) })
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
