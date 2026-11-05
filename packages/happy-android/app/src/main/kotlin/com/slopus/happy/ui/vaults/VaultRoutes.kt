package com.slopus.happy.ui.vaults

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.page
import com.slopus.happy.ui.surfaces.SurfaceElsewhere
import kotlinx.serialization.Serializable

/** A folder of a vault below its root (the root is the Surface's own page); [name] titles it until read. */
@Serializable data class VaultFolderRoute(val connectionId: String, val surfaceId: String, val folderId: String, val name: String = "")

/** A file or an artifact entry shown: its latest version, or [version]. */
@Serializable data class VaultFileRoute(val connectionId: String, val surfaceId: String, val itemId: String, val version: Int? = null, val name: String = "")

/** An entry's versions and activity. */
@Serializable data class VaultHistoryRoute(val connectionId: String, val surfaceId: String, val itemId: String, val folder: Boolean = false, val name: String = "")

@Serializable data class VaultTrashRoute(val connectionId: String, val surfaceId: String)

@Serializable data class VaultSettingsRoute(val connectionId: String, val surfaceId: String)

@Serializable data class VaultSearchRoute(val connectionId: String, val surfaceId: String)

/** The vault screens below a vault's root. Registered once, beside the Surface routes. */
fun NavGraphBuilder.vaultRoutes(graph: AppGraph, nav: NavHostController) {
    val back = { nav.popBackStack(); Unit }
    val open: (Any) -> Unit = { nav.navigate(it) }
    page<VaultFolderRoute> { entry ->
        val route = entry.toRoute<VaultFolderRoute>()
        WithSession(graph, route.connectionId, back) { VaultFolderScreen(it, route.surfaceId, route.folderId, route.name, back, open) }
    }
    page<VaultFileRoute> { entry ->
        val route = entry.toRoute<VaultFileRoute>()
        val computer = com.slopus.happy.ui.artifacts.computerName(graph, route.connectionId)
        WithSession(graph, route.connectionId, back) { VaultFileScreen(it, route.surfaceId, route.itemId, route.version, route.name, computer, back, open) }
    }
    page<VaultHistoryRoute> { entry ->
        val route = entry.toRoute<VaultHistoryRoute>()
        WithSession(graph, route.connectionId, back) { VaultHistoryScreen(it, route.surfaceId, route.itemId, route.folder, route.name, back, open) }
    }
    page<VaultTrashRoute> { entry ->
        val route = entry.toRoute<VaultTrashRoute>()
        WithSession(graph, route.connectionId, back) { VaultTrashScreen(it, route.surfaceId, back, open) }
    }
    page<VaultSettingsRoute> { entry ->
        val route = entry.toRoute<VaultSettingsRoute>()
        WithSession(graph, route.connectionId, back) { VaultSettingsScreen(it, route.surfaceId, back) }
    }
    page<VaultSearchRoute> { entry ->
        val route = entry.toRoute<VaultSearchRoute>()
        WithSession(graph, route.connectionId, back) { VaultSearchScreen(it, route.surfaceId, back, open) }
    }
}

/** The open connection's session, or the Surface's "open it on the computer" page once it is gone. */
@Composable
private fun WithSession(graph: AppGraph, connectionId: String, onBack: () -> Unit, content: @Composable (AgentSession) -> Unit) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    if (session == null) SurfaceElsewhere("", onBack) else content(session)
}
