package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.remember
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.Surface
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.agent.string
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.documents.DocumentHistoryScreen
import com.slopus.happy.ui.documents.DocumentVersionScreen
import com.slopus.happy.ui.page
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

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
        else com.slopus.happy.ui.feed.WithPictures(graph, route.connectionId) {
            DocumentHistoryScreen(session, route.surfaceId, onBack = { nav.popBackStack() }) { seq, title ->
                nav.navigate(DocumentVersionRoute(route.connectionId, route.surfaceId, seq, title))
            }
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
    val surface = session?.surfaces?.value?.get(surfaceId)
    // An artifact, bot or task kept here opens where it always does (desktop's `surfaceTargetOpen`), joined on the way too.
    surface?.let { surfaceTarget(connectionId, it, session.catalog.value) }?.let {
        session.joinSurface(surfaceId)
        navigate(it)
        return
    }
    navigate(SurfaceRoute(connectionId, surfaceId, surface?.name.orEmpty()))
}

/**
 * Where a reference Surface's target opens (desktop's `surfaceTargetOpen`):
 * the artifact viewer, or the bot's or task's own chat. Null for any other
 * kind, and for a target this reader can't see or the phone doesn't hold.
 */
fun surfaceTarget(connectionId: String, surface: Surface, catalog: AgentCatalog): Any? {
    val target = surface.target?.takeIf { it.available } ?: return null
    val id = target.id ?: return null
    fun chat(owner: JsonObject?) = (owner?.get("agent") as? JsonObject)?.string("id")?.let { ConversationRoute(connectionId, it) }
    return when (surface.type) {
        SurfaceType.ARTIFACT -> ArtifactRoute(connectionId, id, title = target.name.orEmpty())
        SurfaceType.BOT -> chat(catalog.bots[id])
        SurfaceType.TASK -> chat(catalog.tasks[id])
        else -> null
    }
}
