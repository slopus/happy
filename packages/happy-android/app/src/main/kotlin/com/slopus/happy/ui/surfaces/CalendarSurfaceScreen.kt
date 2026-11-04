package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.ui.calendar.CalendarModel
import com.slopus.happy.ui.calendar.CalendarScreen
import com.slopus.happy.ui.calendar.calendarTimingWords
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
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
    CalendarScreen(state, surfaceTitle(session, surface?.name.orEmpty()), zone, onRange = { model.feed.show(it.range(surfaceId, zone)) },
        onBack = onBack, onEvent = { selected = it }) { SurfaceMenu(session, surfaceId, onBack) }
    selected?.let { item ->
        val locale = LocalConfiguration.current.locales[0]
        val words = LocalContext.current.resources
        HappyAlert(Alert(item.event.title.ifBlank { stringResource(R.string.calendar_no_title) }, listOfNotNull(
            calendarTimingWords(item.occurrence.timing, zone, locale, words), item.event.location, item.event.notes).joinToString("\n"),
            listOf(AlertButton(stringResource(R.string.common_ok)))), { selected = null })
    }
}
