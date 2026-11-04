package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.feed.FeedSubject
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert

/**
 * The screen each kind of Surface opens on the phone (iOS's
 * `SurfaceScreens`): home's rows, the Surfaces lists and links all open
 * through [openSurface] and land here, so a kind's screen is chosen in one
 * place. Each kind's screen takes the session, the Surface's id and back;
 * a kind the phone doesn't open says to open it on the computer.
 */
@Composable
fun SurfaceScreens(graph: AppGraph, route: SurfaceRoute, onBack: () -> Unit) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    if (session == null) {
        SurfaceElsewhere(route.name, onBack)
        return
    }
    val catalog by session.surfaces.collectAsStateWithLifecycle()
    val surface = catalog[route.surfaceId]
    // Opened: its Feed entry is seen (iOS 2916385ad `SurfaceScreens.make`).
    LaunchedEffect(session, route.surfaceId) { session.feedLibrary.seen(FeedSubject.surface(route.surfaceId)) }
    LaunchedEffect(session, route.surfaceId, catalog.loaded) {
        if (catalog.loaded) session.joinSurface(route.surfaceId)
    }
    val name = surface?.name ?: route.name
    when (surface?.type) {
        null -> SurfaceMissing(name, loading = !catalog.loaded, onBack)
        SurfaceType.DOCUMENT -> DocumentSurfaceScreen(session, route.surfaceId, onBack)
        SurfaceType.TODO -> TodoSurfaceScreen(session, route.surfaceId, onBack)
        SurfaceType.SYSTEM_MONITOR -> SystemMonitorSurfaceScreen(session, route.surfaceId, onBack)
        SurfaceType.CALENDAR -> CalendarSurfaceScreen(session, route.surfaceId, onBack)
        else -> SurfaceElsewhere(name, onBack) { SurfaceMenu(session, route.surfaceId, onBack) }
    }
    JoinRefusal(session, route.surfaceId, name)
}

/** A join the computer refused, said over the Surface, which stays open (desktop's "Could not join “…”. reason"). */
@Composable
private fun JoinRefusal(session: AgentSession, surfaceId: String, name: String) {
    val refusals by session.joinRefusals.collectAsStateWithLifecycle()
    val reason = refusals[surfaceId] ?: return
    HappyAlert(
        Alert(
            title = stringResource(R.string.surface_join_failed, name),
            message = reason.ifEmpty { stringResource(R.string.surface_leave_no_answer) },
            buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
        ),
        onDismiss = { session.dismissJoinRefusal(surfaceId) },
    )
}
