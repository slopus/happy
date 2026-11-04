package com.slopus.happy.calendar

import java.time.Instant
import java.time.ZoneId

/** Desktop WeekView: move in viewer wall time; resize in absolute quarter hours. */
internal fun calendarMove(timing: CalendarTiming, zone: ZoneId, days: Int, minutes: Int = 0, resize: Boolean = false): CalendarTiming? {
    val moved = when (timing) {
        is CalendarTiming.AllDay -> if (resize) return null else
            CalendarTiming.AllDay(timing.startDate.plusDays(days.toLong()), timing.endDate.plusDays(days.toLong()))
        is CalendarTiming.Timed -> if (resize) {
            timing.copy(end = maxOf(timing.start + 15 * 60_000, timing.end + (days * 1440L + minutes) * 60_000))
        } else {
            val start = Instant.ofEpochMilli(timing.start).atZone(zone).toLocalDateTime()
                .plusDays(days.toLong()).plusMinutes(minutes.toLong()).atZone(zone).toInstant().toEpochMilli()
            timing.copy(start = start, end = start + timing.end - timing.start)
        }
    }
    return moved.takeIf { CalendarTiming.parse(it.json()) != null }
}