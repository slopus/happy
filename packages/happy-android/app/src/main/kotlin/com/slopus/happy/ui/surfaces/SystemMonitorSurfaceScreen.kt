package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.monitor.MonitorModel
import com.slopus.happy.ui.monitor.MonitorScreen

/** Visible and foreground only: poll the host, keep its latest readings, and pause beneath another page. */
@Composable
fun SystemMonitorSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(null)
    val model = viewModel(key = "monitor:${session.connectionId}:$surfaceId") { MonitorModel(session, surfaceId) }
    val state by model.feed.state.collectAsStateWithLifecycle()
    LifecycleResumeEffect(model) { model.resume(); onPauseOrDispose { model.pause() } }
    MonitorScreen(state, surfaceTitle(session, surface?.name.orEmpty()), onBack) { SurfaceMenu(session, surfaceId, onBack) }
}
