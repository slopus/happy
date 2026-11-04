package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.documents.DocumentScreen

/** A document Surface ([SurfaceScreens]' `document` slot): edited live with the computer and whoever else has it open. */
@Composable
fun DocumentSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    DocumentScreen(session, surfaceId, onBack)
}
