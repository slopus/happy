package com.slopus.happy.ui.calendar

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.text.format.DateFormat
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.calendar.CalendarDraft
import com.slopus.happy.calendar.CalendarEnd
import com.slopus.happy.calendar.CalendarEvent
import com.slopus.happy.calendar.CalendarFrequency
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.calendar.CalendarRecurrence
import com.slopus.happy.calendar.CalendarRoutes
import com.slopus.happy.calendar.forSeries
import com.slopus.happy.chat.obj
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle

/** Desktop EventPopover as a native sheet. Existing events are saved against their displayed version. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CalendarEventEditor(session: AgentSession, surfaceId: String, target: CalendarItem?, date: LocalDate,
    zone: ZoneId, onDismiss: () -> Unit, onChanged: () -> Unit) {
    var event by remember { mutableStateOf(target?.event) }
    var occurrence by remember { mutableStateOf(target?.occurrence?.timing) }
    var draft by remember { mutableStateOf(target?.let { CalendarDraft.of(it.event.copy(timing = it.occurrence.timing), zone) } ?: CalendarDraft.new(date, zone)) }
    val id = remember { AgentClient.newId() }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var conflict by remember { mutableStateOf<CalendarEvent?>(null) }
    var deletedElsewhere by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val routes = remember(session) { CalendarRoutes(session.client) }
    val scope = rememberCoroutineScope()
    fun mutate(delete: Boolean) {
        if (busy || !delete && !draft.valid) return
        busy = true
        failed = false
        scope.launch {
            try {
                if (delete) event?.let { routes.delete(it) } else {
                    val fields = event?.let { draft.forSeries(it, requireNotNull(occurrence), zone) } ?: draft
                    routes.save(surfaceId, event, id, fields)
                }
                onChanged()
                onDismiss()
            } catch (error: CancellationException) { throw error }
            catch (error: AgentApiException) {
                if (error.status == 409) {
                    val current = CalendarEvent.parse(error.body.obj?.get("event"))
                    if (current == null) deletedElsewhere = true else conflict = current
                    onChanged()
                } else failed = true
            } catch (_: Exception) { failed = true }
            finally { busy = false }
        }
    }
    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        sheetMaxWidth = ContentTokens.sheetMaxWidth, containerColor = HappyTheme.colors.surface, modifier = Modifier.testTag("calendar.editor")) {
        CalendarEventForm(draft, { draft = it }, event != null, busy, failed, onSave = { mutate(false) },
            onDelete = { deleting = true }, onCancel = { if (!busy) onDismiss() }, series = event?.recurrence != null)
    }
    if (deleting) HappyAlert(Alert(stringResource(R.string.calendar_delete_event), stringResource(if (event?.recurrence != null) R.string.calendar_series_delete else R.string.calendar_delete_message),
        listOf(AlertButton(stringResource(R.string.common_cancel)), AlertButton(stringResource(R.string.common_delete)) { deleting = false; mutate(true) })), { deleting = false })
    conflict?.let { current ->
        val locale = LocalConfiguration.current.locales[0]
        val words = LocalContext.current.resources
        HappyAlert(Alert(stringResource(R.string.calendar_conflict), listOf(current.title.ifBlank { stringResource(R.string.calendar_no_title) },
            calendarTimingWords(current.timing, zone, locale, words), current.location, current.notes).filterNotNull().joinToString("\n"),
            listOf(AlertButton(stringResource(R.string.common_cancel)), AlertButton(stringResource(R.string.calendar_use_updated)) {
                event = current; occurrence = current.timing; draft = CalendarDraft.of(current, zone); conflict = null
            })), { conflict = null })
    }
    if (deletedElsewhere) HappyAlert(Alert(stringResource(R.string.calendar_conflict), stringResource(R.string.calendar_deleted_elsewhere),
        listOf(AlertButton(stringResource(R.string.common_ok)) { deletedElsewhere = false; onDismiss() })), { deletedElsewhere = false; onDismiss() })
}

/** Native field spacing is 12dp, sheet inset 24dp. Fields and buttons grow with uncapped text. */
@Composable
internal fun CalendarEventForm(draft: CalendarDraft, onDraft: (CalendarDraft) -> Unit, existing: Boolean, busy: Boolean, failed: Boolean,
    onSave: () -> Unit, onDelete: () -> Unit, onCancel: () -> Unit, series: Boolean) {
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState())
        .padding(horizontal = 24.dp).padding(bottom = 24.dp).testTag("calendar.editor.form"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(if (existing) R.string.calendar_event else R.string.calendar_new_event), style = happyTextStyle(20, 26), color = colors.text)
        if (series) Text(stringResource(R.string.calendar_series_edit), style = happyTextStyle(13, 18), color = colors.textSecondary)
        OutlinedTextField(draft.title, { onDraft(draft.copy(title = it.take(1024))) }, label = { Text(stringResource(R.string.tool_field_title)) },
            enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("calendar.editor.title"))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.calendar_all_day), modifier = Modifier.weight(1f), color = colors.text)
            val allDayLabel = stringResource(R.string.calendar_all_day)
            Switch(draft.allDay, { onDraft(draft.allDay(it)) }, enabled = !busy,
                modifier = Modifier.testTag("calendar.editor.allDay").semantics { contentDescription = allDayLabel })
        }
        CalendarDateTimeField(stringResource(R.string.calendar_starts), draft.startDate, if (draft.allDay) null else draft.startTime, busy,
            onDate = { date ->
                onDraft(draft.startDate(date))
            }, onTime = { onDraft(draft.startTime(it)) }, tag = "start")
        CalendarDateTimeField(stringResource(R.string.calendar_ends), if (draft.allDay) draft.endDate.minusDays(1) else draft.endDate,
            if (draft.allDay) null else draft.endTime, busy,
            onDate = { onDraft(draft.copy(endDate = if (draft.allDay) it.plusDays(1) else it)) }, onTime = { onDraft(draft.copy(endTime = it)) }, tag = "end")
        if (!draft.allDay) OutlinedTextField(draft.timeZone, { onDraft(draft.copy(timeZone = it)) }, label = { Text(stringResource(R.string.calendar_time_zone)) },
            singleLine = true, enabled = !busy, isError = draft.timeZone !in ZoneId.getAvailableZoneIds(), modifier = Modifier.fillMaxWidth().testTag("calendar.editor.zone"))
        OutlinedTextField(draft.location, { onDraft(draft.copy(location = it.take(1024))) }, label = { Text(stringResource(R.string.calendar_location)) }, enabled = !busy,
            modifier = Modifier.fillMaxWidth().testTag("calendar.editor.location"))
        OutlinedTextField(draft.notes, { onDraft(draft.copy(notes = it.take(10_000))) }, label = { Text(stringResource(R.string.calendar_notes)) }, minLines = 2, enabled = !busy,
            modifier = Modifier.fillMaxWidth().testTag("calendar.editor.notes"))
        CalendarRepeatFields(draft, onDraft, busy)
        if (!draft.valid) Text(stringResource(R.string.calendar_invalid), style = happyTextStyle(13, 18), color = colors.textDestructive, modifier = Modifier.testTag("calendar.editor.invalid"))
        if (failed) Text(stringResource(R.string.calendar_save_failed), style = happyTextStyle(13, 18), color = colors.textDestructive)
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            if (existing) TextButton(onDelete, enabled = !busy, modifier = Modifier.testTag("calendar.editor.delete")) { Text(stringResource(R.string.common_delete), color = colors.textDestructive) }
            TextButton(onCancel, enabled = !busy, modifier = Modifier.testTag("calendar.editor.cancel")) { Text(stringResource(R.string.common_cancel)) }
            TextButton(onSave, enabled = !busy && draft.valid, modifier = Modifier.testTag("calendar.editor.save")) { Text(stringResource(R.string.common_save)) }
        }
    }
}

@Composable
private fun CalendarDateTimeField(label: String, date: LocalDate, time: LocalTime?, busy: Boolean, onDate: (LocalDate) -> Unit, onTime: (LocalTime) -> Unit, tag: String) {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    Column {
        Text(label, style = happyTextStyle(13, 18), color = HappyTheme.colors.textSecondary)
        FlowRow(verticalArrangement = Arrangement.Center) {
            TextButton(onClick = {
                DatePickerDialog(context, { _, year, month, day -> onDate(LocalDate.of(year, month + 1, day)) }, date.year, date.monthValue - 1, date.dayOfMonth).apply {
                    datePicker.minDate = 0
                    show()
                }
            }, enabled = !busy, modifier = Modifier.testTag("calendar.editor.$tag.date")) { Text(date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))) }
            if (time != null) TextButton(onClick = {
                TimePickerDialog(context, { _, hour, minute -> onTime(LocalTime.of(hour, minute)) }, time.hour, time.minute, DateFormat.is24HourFormat(context)).show()
            }, enabled = !busy, modifier = Modifier.testTag("calendar.editor.$tag.time")) { Text(time.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))) }
        }
    }
}

@Composable
private fun CalendarRepeatFields(draft: CalendarDraft, onDraft: (CalendarDraft) -> Unit, busy: Boolean) {
    val recurrence = draft.recurrence
    CalendarChoice(stringResource(R.string.calendar_repeat), recurrence?.frequency?.let { stringResource(frequencyWord(it)) } ?: stringResource(R.string.calendar_repeat_none), busy, "repeat") { close ->
        HappyMenuItem(stringResource(R.string.calendar_repeat_none), onClick = { onDraft(draft.copy(recurrence = null)); close() })
        CalendarFrequency.entries.forEach { frequency -> HappyMenuItem(stringResource(frequencyWord(frequency)), onClick = {
            onDraft(draft.copy(recurrence = (recurrence ?: CalendarRecurrence(frequency)).copy(frequency = frequency, weekdays = if (frequency == CalendarFrequency.Weekly) recurrence?.weekdays else null))); close()
        }) }
    }
    if (recurrence == null) return
    OutlinedTextField(recurrence.interval.takeIf { it != 0 }?.toString().orEmpty(), { text -> if (text.all(Char::isDigit) && text.length <= 4) onDraft(draft.copy(recurrence = recurrence.copy(interval = text.toIntOrNull() ?: 0))) },
        label = { Text(stringResource(R.string.calendar_repeat_interval)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = !busy,
        modifier = Modifier.fillMaxWidth().testTag("calendar.editor.interval"))
    if (recurrence.frequency == CalendarFrequency.Weekly) {
        val locale = LocalConfiguration.current.locales[0]
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            DayOfWeek.entries.forEach { day ->
                val selected = day in (recurrence.weekdays ?: setOf(draft.startDate.dayOfWeek))
                FilterChip(selected, onClick = {
                    val days = recurrence.weekdays ?: setOf(draft.startDate.dayOfWeek)
                    val next = if (selected) days - day else days + day
                    if (next.isNotEmpty()) onDraft(draft.copy(recurrence = recurrence.copy(weekdays = next)))
                }, enabled = !busy, label = { Text(day.getDisplayName(TextStyle.NARROW_STANDALONE, locale)) }, modifier = Modifier.testTag("calendar.editor.weekday.${day.value}").semantics { contentDescription = day.getDisplayName(TextStyle.FULL, locale) })
            }
        }
    }
    CalendarChoice(stringResource(R.string.calendar_repeat_end), stringResource(when (recurrence.end) { CalendarEnd.Never -> R.string.calendar_repeat_forever; is CalendarEnd.Until -> R.string.calendar_repeat_until; is CalendarEnd.Count -> R.string.calendar_repeat_count }), busy, "end") { close ->
        listOf(CalendarEnd.Never to R.string.calendar_repeat_forever, CalendarEnd.Until(draft.startDate.plusDays(28)) to R.string.calendar_repeat_until,
            CalendarEnd.Count(10) to R.string.calendar_repeat_count).forEach { (end, label) ->
            HappyMenuItem(stringResource(label), onClick = { onDraft(draft.copy(recurrence = recurrence.copy(end = end))); close() })
        }
    }
    when (val end = recurrence.end) {
        is CalendarEnd.Until -> CalendarDateTimeField(stringResource(R.string.calendar_repeat_until), end.date, null, busy,
            onDate = { onDraft(draft.copy(recurrence = recurrence.copy(end = CalendarEnd.Until(it)))) }, onTime = {}, tag = "until")
        is CalendarEnd.Count -> OutlinedTextField(end.count.takeIf { it != 0 }?.toString().orEmpty(), { text -> if (text.all(Char::isDigit) && text.length <= 5) onDraft(draft.copy(recurrence = recurrence.copy(end = CalendarEnd.Count(text.toIntOrNull() ?: 0)))) },
            label = { Text(stringResource(R.string.calendar_repeat_count)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = !busy, modifier = Modifier.fillMaxWidth())
        CalendarEnd.Never -> Unit
    }
}

@Composable
private fun CalendarChoice(label: String, value: String, busy: Boolean, tag: String, options: @Composable androidx.compose.foundation.layout.ColumnScope.(close: () -> Unit) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        TextButton({ expanded = true }, enabled = !busy, modifier = Modifier.testTag("calendar.editor.$tag")) { Text("$label: $value") }
        HappyDropdownMenu(expanded, { expanded = false }) { options { expanded = false } }
    }
}

private fun frequencyWord(frequency: CalendarFrequency) = when (frequency) {
    CalendarFrequency.Daily -> R.string.calendar_repeat_daily
    CalendarFrequency.Weekly -> R.string.calendar_repeat_weekly
    CalendarFrequency.Monthly -> R.string.calendar_repeat_monthly
    CalendarFrequency.Yearly -> R.string.calendar_repeat_yearly
}