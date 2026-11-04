package com.slopus.happy.ui.calendar

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.calendar.CalendarFeed
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.calendar.CalendarWindow
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.cards.CardHeading
import com.slopus.happy.ui.cards.CardNote
import com.slopus.happy.ui.cards.CardRow
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Desktop calendar controls in the native grouped-card screen, with a chosen-day agenda on phones. */
@Composable
internal fun CalendarScreen(state: CalendarFeed.State, name: String, zone: ZoneId, onRange: (CalendarWindow) -> Unit,
    onBack: () -> Unit, onEvent: (CalendarItem) -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    var chosenDay by rememberSaveable { mutableStateOf(LocalDate.now(zone).toEpochDay()) }
    var week by rememberSaveable { mutableStateOf(false) }
    val chosen = LocalDate.ofEpochDay(chosenDay)
    val window = remember(chosen, week) { if (week) CalendarWindow.week(chosen) else CalendarWindow.month(YearMonth.from(chosen)) }
    LaunchedEffect(window) { onRange(window) }
    val now by produceState(ZonedDateTime.now(zone), zone) {
        while (true) { value = ZonedDateTime.now(zone); delay(60_000 - System.currentTimeMillis() % 60_000) }
    }
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val words = remember(context, configuration) { context.createConfigurationContext(configuration).resources }
    val items = state.page?.items.orEmpty()
    val monthPlan by produceState(CalendarMonthPlan(), items, window, chosen, zone, words) {
        value = withContext(Dispatchers.Default) { calendarMonthPlan(items, window, chosen, zone, words) }
    }
    val weekPlan by produceState(CalendarWeekPlan(), items, window, zone, words, week) {
        if (week) value = withContext(Dispatchers.Default) { calendarWeekPlan(items, window, zone, words) }
    }
    val period = remember(window, week, words) {
        val format = DateTimeFormatter.ofPattern(if (week) "d MMM" else "LLLL yyyy", words.configuration.locales[0])
        if (week) "${window.firstDate.format(format)} – ${window.firstDate.plusDays(6).format(format)}" else chosen.format(format)
    }
    PlaceScaffold(name, onBack, tag = "calendar.screen", actions = {
        CalendarViewMenu(week) { week = it }
        actions()
    }) {
        LazyColumn(Modifier.fillMaxSize().navigationBarsPadding().testTag("calendar.rows"), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
            item("controls") {
                CalendarControls(period, onPrevious = { chosenDay = (if (week) chosen.minusWeeks(1) else chosen.minusMonths(1)).toEpochDay() },
                    onNext = { chosenDay = (if (week) chosen.plusWeeks(1) else chosen.plusMonths(1)).toEpochDay() }, onToday = { chosenDay = now.toLocalDate().toEpochDay() })
                Spacer(Modifier.height(14.dp))
            }
            val note = when (state.status) {
                CalendarFeed.Status.Missing -> R.string.calendar_missing
                CalendarFeed.Status.Unsupported -> R.string.calendar_unsupported
                CalendarFeed.Status.Loading -> if (state.page == null) R.string.calendar_loading else null
                CalendarFeed.Status.Ready -> if (state.error != null) R.string.calendar_retrying else null
            }
            if (note != null) item("status") { CardNote(stringResource(note)) }
            if (state.status != CalendarFeed.Status.Missing && state.status != CalendarFeed.Status.Unsupported) {
                item("grid") {
                    if (week && weekPlan.days.size == 7) CalendarWeekGrid(weekPlan, now, { chosenDay = it.toEpochDay() }, onEvent)
                    else if (!week && monthPlan.weeks.isNotEmpty()) CalendarMonthGrid(chosen.monthValue, monthPlan.weekdays, monthPlan.weeks, now.toLocalDate(), chosen) { chosenDay = it.toEpochDay() }
                }
                if (state.page?.truncated == true) item("truncated") { CardNote(stringResource(R.string.calendar_truncated)) }
                item("agenda.title") { CardHeading(monthPlan.agendaTitle, afterCard = true) }
                if (monthPlan.agenda.isEmpty()) item("agenda.empty") { CardNote(stringResource(R.string.calendar_no_events)) }
                itemsIndexed(monthPlan.agenda, key = { _, line -> "agenda.${line.item.occurrence.key}" }) { index, line ->
                    CardRow(HomeCardPlace(index == 0, index == monthPlan.agenda.lastIndex), line.title, subtitle = line.subtitle,
                        onClick = { onEvent(line.item) }, tag = "calendar.agenda.${line.item.occurrence.key}")
                }
            }
        }
    }
}

/** 48dp previous/next targets, growing period label and native Today button on the shared column. */
@Composable
internal fun CalendarControls(period: String, onPrevious: () -> Unit, onNext: () -> Unit, onToday: () -> Unit) {
    CardBlock(HomeCardPlace(true, true), tag = "calendar.controls") {
        Row(Modifier.heightIn(min = 48.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            BarIconButton(Ionicon.ChevronBack, stringResource(R.string.calendar_previous), onPrevious, Modifier.testTag("calendar.previous"))
            Text(period, style = happyTextStyle(15, 20, weight = FontWeight.Medium), color = HappyTheme.colors.text, maxLines = 2,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).testTag("calendar.period"))
            BarIconButton(Ionicon.ChevronForward, stringResource(R.string.calendar_next), onNext, Modifier.testTag("calendar.next"))
            TextButton(onToday, Modifier.testTag("calendar.today")) { Text(stringResource(R.string.session_history_today)) }
        }
    }
}

@Composable
private fun CalendarViewMenu(week: Boolean, onView: (Boolean) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        BarIconButton(Ionicon.CalendarOutline, stringResource(R.string.calendar_view), { expanded = true }, Modifier.testTag("calendar.view"))
        DropdownMenu(expanded, { expanded = false }) {
            listOf(false to R.string.calendar_month, true to R.string.agent_input_usage_popup_week).forEach { (value, label) ->
                DropdownMenuItem(text = { Text(stringResource(label) + if (week == value) " ✓" else "") }, onClick = { onView(value); expanded = false }, modifier = Modifier.testTag(if (value) "calendar.view.week" else "calendar.view.month"))
            }
        }
    }
}