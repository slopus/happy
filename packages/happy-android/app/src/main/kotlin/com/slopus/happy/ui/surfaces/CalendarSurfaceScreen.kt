package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.R
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.calendar.CalendarEvent
import com.slopus.happy.calendar.CalendarDraft
import com.slopus.happy.calendar.CalendarRoutes
import com.slopus.happy.calendar.forSeries
import com.slopus.happy.chat.obj
import com.slopus.happy.ui.calendar.CalendarModel
import com.slopus.happy.ui.calendar.CalendarScreen
import com.slopus.happy.ui.calendar.CalendarEventEditor
import com.slopus.happy.ui.calendar.calendarEventDetails
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

/** Desktop range reader on the app's shared Surface route; journal reads pause beneath another page. */
@Composable
fun CalendarSurfaceScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit, open: (Any) -> Unit = {}) {
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(null)
    val model = viewModel(key = "calendar:${session.connectionId}:$surfaceId") { CalendarModel(session) }
    val state by model.feed.state.collectAsStateWithLifecycle()
    val zone = ZoneId.systemDefault()
    LifecycleResumeEffect(model) { model.resume(); onPauseOrDispose { model.pause() } }
    var selected by remember { mutableStateOf<CalendarItem?>(null) }
    var date by remember { mutableStateOf<LocalDate?>(null) }
    var moving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var conflicted by remember { mutableStateOf(false) }
    var current by remember { mutableStateOf<CalendarEvent?>(null) }
    val scope = rememberCoroutineScope()
    val routes = remember(session) { CalendarRoutes(session.client) }
    CalendarScreen(state, surfaceTitle(session, surface?.name.orEmpty()), zone, onRange = { model.feed.show(it.range(surfaceId, zone)) },
        onBack = onBack, onEvent = { if (!moving) { selected = it; date = LocalDate.now(zone) } }, onNewEvent = { if (!moving) { selected = null; date = it } },
        onMove = if (moving) null else { item, timing ->
            moving = true
            scope.launch {
                try {
                    val draft = CalendarDraft.of(item.event.copy(timing = timing), zone).forSeries(item.event, item.occurrence.timing, zone)
                    routes.save(surfaceId, item.event, AgentClient.newId(), draft)
                } catch (error: CancellationException) { throw error }
                catch (error: AgentApiException) {
                    if (error.status == 409) { current = CalendarEvent.parse(error.body.obj?.get("event")); conflicted = true }
                    else failed = true
                } catch (_: Exception) { failed = true }
                finally { moving = false; model.feed.invalidate() }
            }
        }) { SurfaceMenu(session, surfaceId, onBack, open = open) }
    date?.let { day -> CalendarEventEditor(session, surfaceId, selected, day, zone,
        onDismiss = { date = null; selected = null }, onChanged = { model.feed.invalidate() }) }
    if (failed) HappyAlert(Alert(stringResource(R.string.calendar_save_failed), buttons = listOf(AlertButton(stringResource(R.string.common_ok)))), { failed = false })
    if (conflicted) {
        val locale = LocalConfiguration.current.locales[0]
        val words = LocalContext.current.resources
        val details = current?.let { calendarEventDetails(it, zone, locale, words) } ?: stringResource(R.string.calendar_deleted_elsewhere)
        HappyAlert(Alert(stringResource(R.string.calendar_conflict), details, listOf(AlertButton(stringResource(R.string.common_ok)))), { conflicted = false; current = null })
    }
}
