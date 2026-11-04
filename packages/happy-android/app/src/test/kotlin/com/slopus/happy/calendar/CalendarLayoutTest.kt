package com.slopus.happy.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId

class CalendarLayoutTest {
    private val utc = ZoneId.of("UTC")
    private val monday = LocalDate.of(2026, 10, 19)
    private fun item(id: String, timing: CalendarTiming) = CalendarItem(CalendarEvent(id, "team", id, timing, "v1"), CalendarOccurrence(id, 0, timing))
    private fun timed(id: String, start: String, end: String, date: LocalDate = monday) = item(id, CalendarTiming.Timed(
        date.atTime(LocalTime.parse(start)).atZone(utc).toInstant().toEpochMilli(), date.atTime(LocalTime.parse(end)).atZone(utc).toInstant().toEpochMilli(), "UTC"))
    private fun allDay(id: String, from: Int, to: Int) = item(id, CalendarTiming.AllDay(monday.plusDays(from.toLong()), monday.plusDays(to.toLong())))

    @Test fun monthGridsContainOnlyTheWholeWeeksNeeded() {
        assertEquals(28, CalendarWindow.month(YearMonth.of(2021, 2)).days)
        assertEquals(35, CalendarWindow.month(YearMonth.of(2026, 2)).days)
        assertEquals(42, CalendarWindow.month(YearMonth.of(2026, 8)).days)
        assertEquals(LocalDate.of(2026, 7, 27), CalendarWindow.month(YearMonth.of(2026, 8)).firstDate)
    }

    @Test fun rangeMidnightsFollowDaylightSavingRatherThanAddingFixedDays() {
        val zone = ZoneId.of("Europe/Berlin")
        val spring = CalendarWindow.month(YearMonth.of(2026, 3)).range("team", zone)
        val autumn = CalendarWindow.month(YearMonth.of(2026, 10)).range("team", zone)
        assertEquals(42 * CalendarTiming.DAY_MS - 3_600_000, spring.to - spring.from)
        assertEquals(35 * CalendarTiming.DAY_MS + 3_600_000, autumn.to - autumn.from)
    }

    @Test fun barsKeepOneLaneThroughTheirWholeWeekAndMarkContinuations() {
        val bars = calendarBars(listOf(allDay("short", 1, 2), allDay("long", -2, 9), allDay("after", 3, 4)), monday, utc)
        assertEquals("long", bars.first().item.event.id)
        assertEquals(0, bars.first().lane)
        assertTrue(bars.first().continuesBefore && bars.first().continuesAfter)
        assertEquals(listOf(0, 1, 1), bars.map { it.lane })
    }

    @Test fun overflowReservesTheLastLineForTheHiddenCountAcrossABar() {
        val bars = calendarBars(listOf(allDay("long", 0, 4), allDay("medium", 0, 3), allDay("short", 1, 2)), monday, utc)
        val fit = calendarBarsFit(bars, 2)
        assertEquals(listOf("long"), fit.shown.map { it.item.event.id })
        assertEquals(listOf(1, 2, 1, 0, 0, 0, 0), fit.hidden)
    }

    @Test fun overlapGroupsShareWidthAndReleaseItForTheNextGroup() {
        val pieces = calendarTimedPieces(listOf(timed("a", "09:00", "10:00"), timed("b", "09:30", "10:30"), timed("c", "10:15", "11:00"), timed("d", "11:00", "12:00")), monday, 7, utc)
        assertEquals(listOf(0, 1, 0, 0), pieces.map { it.lane })
        assertEquals(listOf(2, 2, 2, 1), pieces.map { it.lanes })
    }

    @Test fun tinyEventsReserveTheirMinimumDrawnHeight() {
        val pieces = calendarTimedPieces(listOf(timed("a", "09:00", "09:05"), timed("b", "09:15", "09:30")), monday, 7, utc)
        assertEquals(listOf(0, 1), pieces.map { it.lane })
        assertEquals(listOf(2, 2), pieces.map { it.lanes })
    }

    @Test fun crossingMidnightSplitsThePieceButAnExclusiveMidnightDoesNot() {
        val start = monday.atTime(23, 0).atZone(utc).toInstant().toEpochMilli()
        val midnight = monday.plusDays(1).atStartOfDay(utc).toInstant().toEpochMilli()
        val crossing = item("crossing", CalendarTiming.Timed(start, midnight + 3_600_000, "UTC"))
        val exact = item("exact", CalendarTiming.Timed(start, midnight, "UTC"))
        val pieces = calendarTimedPieces(listOf(crossing, exact), monday, 7, utc)
        assertEquals(2, pieces.count { it.item.event.id == "crossing" })
        assertEquals(1, pieces.count { it.item.event.id == "exact" })
        assertEquals(listOf("crossing"), calendarAgenda(listOf(crossing, exact), monday.plusDays(1), utc).map { it.event.id })
    }
}