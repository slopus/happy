package com.slopus.happy.ui.calendar

import android.content.res.Resources
import androidx.compose.runtime.Immutable
import com.slopus.happy.R
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.calendar.CalendarEvent
import com.slopus.happy.calendar.CalendarRecurrence
import com.slopus.happy.calendar.CalendarEnd
import com.slopus.happy.calendar.CalendarTiming
import com.slopus.happy.calendar.CalendarWindow
import com.slopus.happy.calendar.calendarAgenda
import com.slopus.happy.calendar.calendarBars
import com.slopus.happy.calendar.calendarBarsFit
import com.slopus.happy.calendar.calendarTimedPieces
import com.slopus.happy.calendar.CalendarTimedPiece
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

@Immutable
internal data class AgendaLine(val item: CalendarItem, val title: String, val subtitle: String)
@Immutable
internal data class CalendarMonthPlan(val weekdays: List<String> = emptyList(), val weeks: List<MonthWeek> = emptyList(),
    val agendaTitle: String = "", val agenda: List<AgendaLine> = emptyList())

@Immutable
internal data class WeekEvent(val piece: CalendarTimedPiece, val title: String, val description: String)
@Immutable
internal data class CalendarWeekPlan(val days: List<MonthDay> = emptyList(), val bars: List<MonthLine> = emptyList(),
    val hidden: List<Int> = List(7) { 0 }, val events: List<WeekEvent> = emptyList(), val hours: List<String> = emptyList(),
    val barItems: Map<String, CalendarItem> = emptyMap())

internal fun calendarWeekPlan(items: List<CalendarItem>, window: CalendarWindow, zone: ZoneId, words: Resources): CalendarWeekPlan {
    val locale = words.configuration.locales[0]
    val dayFormat = DateTimeFormatter.ofPattern("EEE d", locale)
    val fullDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(locale)
    val timeFormat = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)
    fun title(item: CalendarItem) = item.event.title.takeIf { it.isNotBlank() } ?: words.getString(R.string.calendar_no_title)
    fun description(item: CalendarItem) = "${title(item)}, ${calendarTimingWords(item.occurrence.timing, zone, locale, words)}"
    val bars = calendarBarsFit(calendarBars(items, window.firstDate, zone, barsOnly = true), 3)
    return CalendarWeekPlan(List(7) { column ->
        val date = window.firstDate.plusDays(column.toLong())
        MonthDay(date, date.format(dayFormat), date.format(fullDate), 0)
    }, bars.shown.map { bar -> MonthLine(bar.item.occurrence.key, bar.startColumn, bar.endColumn, bar.lane,
        title(bar.item), description(bar.item), true) }, bars.hidden,
        calendarTimedPieces(items, window.firstDate, 7, zone).map { WeekEvent(it, title(it.item), description(it.item)) },
        List(24) { hour -> window.firstDate.atTime(hour, 0).format(timeFormat) }, bars.shown.associate { it.item.occurrence.key to it.item })
}

/** Desktop range/bar rules, prepared with locale strings and time formatting off Main. */
internal fun calendarMonthPlan(items: List<CalendarItem>, window: CalendarWindow, chosen: LocalDate, zone: ZoneId, words: Resources): CalendarMonthPlan {
    val locale = words.configuration.locales[0]
    val dateLabel = DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(locale)
    val shortTime = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).withZone(zone)
    fun title(item: CalendarItem) = item.event.title.takeIf { it.isNotBlank() } ?: words.getString(R.string.calendar_no_title)
    val weeks = List(window.days / 7) { week ->
        val first = window.firstDate.plusDays(week * 7L)
        val bars = calendarBars(items, first, zone)
        val fit = calendarBarsFit(bars, 2)
        MonthWeek(List(7) { column ->
            val date = first.plusDays(column.toLong())
            val count = bars.count { column in it.startColumn until it.endColumn }
            MonthDay(date, date.dayOfMonth.toString(), "${date.format(dateLabel)}, ${words.getQuantityString(R.plurals.calendar_event_count, count, count)}", count)
        }, fit.shown.map { bar ->
            val timing = bar.item.occurrence.timing
            val label = title(bar.item)
            val time = if (timing is CalendarTiming.Timed && !bar.bar) shortTime.format(Instant.ofEpochMilli(timing.start)) else null
            MonthLine("${bar.item.occurrence.key}:$week", bar.startColumn, bar.endColumn, bar.lane, if (time == null) label else "$time $label",
                "$label, ${calendarTimingWords(timing, zone, locale, words)}", bar.bar)
        }, fit.hidden)
    }
    val agenda = calendarAgenda(items, chosen, zone).map { item -> AgendaLine(item, title(item), listOfNotNull(
        calendarTimingWords(item.occurrence.timing, zone, locale, words), item.event.location).joinToString(" · ")) }
    return CalendarMonthPlan(DayOfWeek.entries.map { it.getDisplayName(TextStyle.SHORT_STANDALONE, locale) }, weeks, chosen.format(dateLabel), agenda)
}

internal fun calendarTimingWords(timing: CalendarTiming, zone: ZoneId, locale: Locale, words: Resources, includeDates: Boolean = false): String = when (timing) {
    is CalendarTiming.AllDay -> {
        val allDay = words.getString(R.string.calendar_all_day)
        if (timing.startDate.plusDays(1) == timing.endDate) {
            if (includeDates) "$allDay · ${timing.startDate.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))}" else allDay
        } else {
            val format = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)
            "$allDay · ${timing.startDate.format(format)} – ${timing.endDate.minusDays(1).format(format)}"
        }
    }
    is CalendarTiming.Timed -> {
        val from = Instant.ofEpochMilli(timing.start).atZone(zone)
        val to = Instant.ofEpochMilli(timing.end).atZone(zone)
        val format = (if (!includeDates && from.toLocalDate() == to.toLocalDate()) DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
            else DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT)).withLocale(locale)
        "${from.format(format)} – ${to.format(format)}"
    }
}

/** A conflict has no selected-day context: show authoritative dates, zone and rule explicitly. */
internal fun calendarEventDetails(event: CalendarEvent, viewerZone: ZoneId, locale: Locale, words: Resources): String {
    val timing = event.timing
    val zone = (timing as? CalendarTiming.Timed)?.let { ZoneId.of(it.timeZone) } ?: viewerZone
    val whenText = calendarTimingWords(timing, zone, locale, words, includeDates = true) +
        (if (timing is CalendarTiming.Timed) " · ${timing.timeZone}" else "")
    val repeat = CalendarRecurrence.parse(event.recurrence)?.let { rule ->
        val ending = when (val end = rule.end) {
            CalendarEnd.Never -> "${words.getString(R.string.calendar_repeat_end)}: ${words.getString(R.string.calendar_repeat_forever)}"
            is CalendarEnd.Until -> "${words.getString(R.string.calendar_repeat_until)}: ${end.date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))}"
            is CalendarEnd.Count -> "${words.getString(R.string.calendar_repeat_count)}: ${end.count}"
        }
        "${words.getString(R.string.calendar_repeat)}: " + listOfNotNull(words.getString(frequencyWord(rule.frequency)),
            "${words.getString(R.string.calendar_repeat_interval)} ${rule.interval}",
            rule.weekdays?.sortedBy { it.value }?.joinToString(", ") { it.getDisplayName(TextStyle.SHORT, locale) }, ending).joinToString(" · ")
    }
    return listOfNotNull(event.title.takeIf { it.isNotBlank() } ?: words.getString(R.string.calendar_no_title), whenText,
        event.location, event.notes, repeat).joinToString("\n")
}