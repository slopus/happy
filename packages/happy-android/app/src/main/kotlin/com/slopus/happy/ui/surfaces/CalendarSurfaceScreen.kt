package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.agent.AgentSession

/** A calendar Surface ([SurfaceScreens]' `calendar` slot); until it has a screen, open it on the computer. */
@Composable
fun CalendarSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    val surface by session.surface(surfaceId).collectAsStateWithLifecycle(null)
    SurfaceElsewhere(surface?.name.orEmpty(), onBack) { SurfaceMenu(session, surfaceId, onBack) }
}
