package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.ui.calendar.CalendarModel
import com.slopus.happy.ui.calendar.CalendarScreen
import com.slopus.happy.ui.calendar.CalendarEventEditor
import java.time.LocalDate
import java.time.ZoneId

/** Desktop range reader on the app's shared Surface route; journal reads pause beneath another page. */
@Composable
fun CalendarSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(null)
    val model = viewModel(key = "calendar:${session.connectionId}:$surfaceId") { CalendarModel(session) }
    val state by model.feed.state.collectAsStateWithLifecycle()
    val zone = ZoneId.systemDefault()
    LifecycleResumeEffect(model) { model.resume(); onPauseOrDispose { model.pause() } }
    var selected by remember { mutableStateOf<CalendarItem?>(null) }
    var date by remember { mutableStateOf<LocalDate?>(null) }
    CalendarScreen(state, surfaceTitle(session, surface?.name.orEmpty()), zone, onRange = { model.feed.show(it.range(surfaceId, zone)) },
        onBack = onBack, onEvent = { selected = it; date = LocalDate.now(zone) }, onNewEvent = { selected = null; date = it }) { SurfaceMenu(session, surfaceId, onBack) }
    date?.let { day -> CalendarEventEditor(session, surfaceId, selected, day, zone,
        onDismiss = { date = null; selected = null }, onChanged = { model.feed.invalidate() }) }
}
