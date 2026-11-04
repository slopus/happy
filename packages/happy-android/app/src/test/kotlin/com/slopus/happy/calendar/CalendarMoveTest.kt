package com.slopus.happy.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class CalendarMoveTest {
    private val zone = ZoneId.of("Europe/Berlin")
    @Test fun movingAcrossDaylightSavingKeepsWallTimePrecisionAndAbsoluteDuration() {
        val from = LocalDate.of(2026, 3, 28).atTime(9, 0, 12, 345_000_000).atZone(zone).toInstant().toEpochMilli()
        val original = CalendarTiming.Timed(from, from + 90 * 60_000, zone.id)
        val moved = calendarMove(original, zone, 1, 15) as CalendarTiming.Timed
        assertEquals(from + 23 * 3_600_000L + 15 * 60_000, moved.start)
        assertEquals(90 * 60_000L, moved.end - moved.start)
        assertEquals(original.copy(start = moved.start, end = moved.end), moved)
    }
    @Test fun resizeNeverEndsBeforeTheFirstQuarterHourAndRejectsTooLong() {
        val timing = CalendarTiming.Timed(100_000_000, 103_600_000, "UTC")
        assertEquals(timing.start + 15 * 60_000, (calendarMove(timing, zone, 0, -120, true) as CalendarTiming.Timed).end)
        assertNull(calendarMove(timing, zone, 367, resize = true))
        assertNull(calendarMove(timing, zone, -100))
    }
    @Test fun allDayMovesUseWholeDatesWithoutAttachingAZone() {
        val date = LocalDate.of(2026, 10, 24)
        val timing = CalendarTiming.AllDay(date, date.plusDays(3))
        assertEquals(CalendarTiming.AllDay(date.plusDays(2), date.plusDays(5)), calendarMove(timing, zone, 2))
        assertNull(calendarMove(timing, zone, 1, resize = true))
    }
}