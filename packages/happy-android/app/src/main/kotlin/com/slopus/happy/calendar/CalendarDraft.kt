package com.slopus.happy.calendar

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

enum class CalendarFrequency(val wire: String) { Daily("daily"), Weekly("weekly"), Monthly("monthly"), Yearly("yearly") }

sealed interface CalendarEnd {
    data object Never : CalendarEnd
    data class Until(val date: LocalDate) : CalendarEnd
    data class Count(val count: Int) : CalendarEnd
}

/** The API's complete recurrence rule. There are no occurrence exceptions. */
data class CalendarRecurrence(val frequency: CalendarFrequency, val interval: Int = 1,
    val weekdays: Set<DayOfWeek>? = null, val end: CalendarEnd = CalendarEnd.Never) {
    fun valid(start: LocalDate): Boolean = interval in 1..1000 &&
        (weekdays == null || frequency == CalendarFrequency.Weekly && weekdays.isNotEmpty()) && when (end) {
            CalendarEnd.Never -> true
            is CalendarEnd.Until -> end.date >= start && end.date.year in 1970..9999
            is CalendarEnd.Count -> end.count in 1..10_000
        }

    fun json(): JsonObject = buildJsonObject {
        put("frequency", frequency.wire)
        put("interval", interval)
        put("weekdays", weekdays?.let { days -> JsonArray(DayOfWeek.entries.filter { it in days }.map { JsonPrimitive(it.name.lowercase(java.util.Locale.ROOT)) }) } ?: JsonNull)
        put("until", (end as? CalendarEnd.Until)?.date?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
        put("count", (end as? CalendarEnd.Count)?.count?.let(::JsonPrimitive) ?: JsonNull)
    }

    companion object {
        fun parse(value: JsonObject?): CalendarRecurrence? {
            if (value == null) return null
            val frequency = CalendarFrequency.entries.firstOrNull { it.wire == (value["frequency"] as? JsonPrimitive)?.content } ?: return null
            val interval = (value["interval"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 1
            val days = (value["weekdays"] as? JsonArray)?.mapNotNull { day -> DayOfWeek.entries.firstOrNull { it.name.equals((day as? JsonPrimitive)?.content, ignoreCase = true) } }?.toSet()
            val until = CalendarTiming.date((value["until"] as? JsonPrimitive)?.content)
            val count = (value["count"] as? JsonPrimitive)?.content?.toIntOrNull()
            return CalendarRecurrence(frequency, interval, days, when { until != null -> CalendarEnd.Until(until); count != null -> CalendarEnd.Count(count); else -> CalendarEnd.Never })
        }
    }
}

/** Native date/time pickers keep dates typed; the zone remains an editable IANA name. */
data class CalendarDraft(val title: String = "", val notes: String = "", val location: String = "", val allDay: Boolean = false,
    val startDate: LocalDate, val startTime: LocalTime = LocalTime.of(9, 0), val endDate: LocalDate,
    val endTime: LocalTime = LocalTime.of(10, 0), val timeZone: String, val recurrence: CalendarRecurrence? = null) {
    val timing: CalendarTiming? get() {
        val value = if (allDay) CalendarTiming.AllDay(startDate, endDate) else {
            if (timeZone !in ZoneId.getAvailableZoneIds()) return null
            val zone = ZoneId.of(timeZone)
            // java.time's gap/overlap resolution matches Temporal compatible:
            // a missing wall time moves forward and an overlap takes the earlier instant.
            CalendarTiming.Timed(startDate.atTime(startTime).atZone(zone).toInstant().toEpochMilli(),
                endDate.atTime(endTime).atZone(zone).toInstant().toEpochMilli(), timeZone)
        }
        return value.takeIf { CalendarTiming.parse(it.json()) != null }
    }
    val valid: Boolean get() = title.length <= 1024 && title.none(::control) && notes.length <= 10_000 &&
        notes.none { control(it) && it != '\n' && it != '\t' } && location.length <= 1024 && location.none(::control) &&
        timing != null && (recurrence?.valid(startDate) != false)

    /** Desktop keeps the visible last day and wall-clock duration while changing fields. */
    fun allDay(value: Boolean): CalendarDraft = if (value == allDay) this else
        copy(allDay = value, endDate = endDate.plusDays(if (value) 1 else -1))

    fun startDate(value: LocalDate): CalendarDraft = copy(startDate = value,
        endDate = endDate.plusDays(value.toEpochDay() - startDate.toEpochDay()))

    fun startTime(value: LocalTime): CalendarDraft {
        val duration = Duration.between(startDate.atTime(startTime), endDate.atTime(endTime))
        val end = startDate.atTime(value).plus(duration)
        return copy(startTime = value, endDate = end.toLocalDate(), endTime = end.toLocalTime())
    }

    fun json(): JsonObject = buildJsonObject {
        put("title", title)
        put("notes", notes.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
        put("location", location.takeIf { it.isNotBlank() }?.let(::JsonPrimitive) ?: JsonNull)
        put("timing", requireNotNull(timing).json())
        put("recurrence", recurrence?.json() ?: JsonNull)
    }

    companion object {
        private fun control(char: Char) = char.code < 32 || char.code == 127
        fun new(date: LocalDate, zone: ZoneId) = CalendarDraft(startDate = date, endDate = date, timeZone = zone.id)
        fun of(event: CalendarEvent, viewerZone: ZoneId): CalendarDraft = when (val timing = event.timing) {
            is CalendarTiming.AllDay -> CalendarDraft(event.title, event.notes.orEmpty(), event.location.orEmpty(), true,
                timing.startDate, endDate = timing.endDate, timeZone = viewerZone.id, recurrence = CalendarRecurrence.parse(event.recurrence))
            is CalendarTiming.Timed -> {
                val zone = ZoneId.of(timing.timeZone)
                val from = Instant.ofEpochMilli(timing.start).atZone(zone)
                val to = Instant.ofEpochMilli(timing.end).atZone(zone)
                CalendarDraft(event.title, event.notes.orEmpty(), event.location.orEmpty(), false, from.toLocalDate(), from.toLocalTime(),
                    to.toLocalDate(), to.toLocalTime(), zone.id, CalendarRecurrence.parse(event.recurrence))
            }
        }
    }
}

/**
 * Desktop surfaceCalendarStore.seriesChange: editing an occurrence retimes the
 * base event by local days and start time. Duration is absolute across DST;
 * existing sub-minute precision survives a move. An unchanged recurrence turns
 * its named weekdays and inclusive end with the series.
 */
internal fun CalendarDraft.forSeries(event: CalendarEvent, occurrence: CalendarTiming, viewerZone: ZoneId): CalendarDraft {
    val to = timing ?: return this
    if (to == occurrence) return CalendarDraft.of(event, viewerZone).copy(title = title, notes = notes, location = location, recurrence = recurrence)
    val days = to.localDate().toEpochDay() - occurrence.localDate().toEpochDay()
    val baseDate = event.timing.localDate().plusDays(days)
    val moved = when (to) {
        is CalendarTiming.AllDay -> CalendarTiming.AllDay(baseDate, baseDate.plusDays(to.endDate.toEpochDay() - to.startDate.toEpochDay()))
        is CalendarTiming.Timed -> {
            val zone = ZoneId.of(to.timeZone)
            val time = Instant.ofEpochMilli(to.start).atZone(zone).toLocalTime().withSecond(0).withNano(0)
            val extra = (event.timing as? CalendarTiming.Timed)?.start?.let { Math.floorMod(it, 60_000L) } ?: 0L
            val start = baseDate.atTime(time).atZone(zone).toInstant().toEpochMilli() + extra
            CalendarTiming.Timed(start, start + to.end - to.start, to.timeZone)
        }
    }
    val original = CalendarRecurrence.parse(event.recurrence)
    val rule = if (recurrence == original && days != 0L) original?.copy(
        weekdays = original.weekdays?.map { it.plus(days) }?.toSet(),
        end = (original.end as? CalendarEnd.Until)?.let { CalendarEnd.Until(it.date.plusDays(days)) } ?: original.end) else recurrence
    return CalendarDraft.of(event.copy(timing = moved), viewerZone).copy(title = title, notes = notes, location = location, recurrence = rule)
}

private fun CalendarTiming.localDate(): LocalDate = when (this) {
    is CalendarTiming.AllDay -> startDate
    is CalendarTiming.Timed -> Instant.ofEpochMilli(start).atZone(ZoneId.of(timeZone)).toLocalDate()
}

fun CalendarTiming.json(): JsonObject = buildJsonObject {
    when (val timing = this@json) {
        is CalendarTiming.AllDay -> { put("kind", "allDay"); put("startDate", timing.startDate.toString()); put("endDate", timing.endDate.toString()) }
        is CalendarTiming.Timed -> { put("kind", "timed"); put("start", timing.start); put("end", timing.end); put("timeZone", timing.timeZone) }
    }
}