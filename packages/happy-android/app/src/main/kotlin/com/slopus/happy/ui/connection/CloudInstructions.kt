package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.PolicyDocument
import com.slopus.happy.agent.Surface
import com.slopus.happy.agent.SurfaceCatalog
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.ui.surfaces.SurfaceMissing
import com.slopus.happy.ui.surfaces.SurfaceRoute
import com.slopus.happy.ui.surfaces.SurfaceScreens
import kotlinx.serialization.Serializable

/** A Cloud instructions link opens the server's Instructions in its settings, or where it has none yet, its Policy vault ([instructionsPlace]). */
@Serializable data class CloudInstructionsRoute(val connectionId: String)

/** The authoritative marker, never the name or the reader's access level. */
internal fun policyVault(catalog: SurfaceCatalog): Surface? =
    catalog.surfaces.singleOrNull { it.type == SurfaceType.VAULT && it.policyVault }

/** Uses the existing vault layout and standard missing/loading page, with their normal back behavior. */
@Composable
internal fun CloudInstructions(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val connection = graph.agentConnections.accounts.collectAsStateWithLifecycle().value.firstOrNull { it.id == connectionId }
    val cloud = graph.cloudAccount != null && HappyCloud.isServer(connection?.server)
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val title = stringResource(R.string.tool_section_instructions)
    val back = { nav.popBackStack(); Unit }
    if (!cloud || session == null) {
        SurfaceMissing(title, loading = false, back)
        return
    }
    val catalog by session.surfaces.collectAsStateWithLifecycle()
    val permissions by session.permissions.collectAsStateWithLifecycle()
    when (val place = instructionsPlace(permissions, catalog)) {
        InstructionsPlace.Document -> PolicyDocumentPage(graph, nav, connectionId, PolicyDocument.Instructions)
        is InstructionsPlace.Vault -> SurfaceScreens(graph, SurfaceRoute(connectionId, place.surface.id, place.surface.name), back) { nav.navigate(it) }
        is InstructionsPlace.Missing -> SurfaceMissing(title, loading = place.loading, back)
    }
}