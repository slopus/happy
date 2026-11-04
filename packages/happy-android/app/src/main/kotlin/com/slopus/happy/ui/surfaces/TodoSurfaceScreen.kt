package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.ui.connection.ReadSurface

/** A todo list Surface ([SurfaceScreens]' `todo` slot): its todos, read whole, and a field to add one. */
@Composable
fun TodoSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    ReadSurface(session, surfaceId, SurfaceType.TODO, onBack)
}
