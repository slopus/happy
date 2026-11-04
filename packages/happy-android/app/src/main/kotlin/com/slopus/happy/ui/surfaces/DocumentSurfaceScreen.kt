package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.ui.connection.ReadSurface

/** A document Surface ([SurfaceScreens]' `document` slot): its Markdown, read whole. */
@Composable
fun DocumentSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    ReadSurface(session, surfaceId, SurfaceType.DOCUMENT, onBack)
}
