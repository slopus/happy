package com.slopus.happy.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

class CalendarDraftTest {
    private val date = LocalDate.of(2026, 10, 20)
    private val zone = ZoneId.of("Europe/Berlin")

    @Test fun nativeDraftKeepsExclusiveAllDayEndsAndAllowsAnEmptyTitle() {
        val draft = CalendarDraft.new(date, zone).copy(allDay = true, endDate = date.plusDays(1))
        assertTrue(draft.valid)
        assertEquals(CalendarTiming.AllDay(date, date.plusDays(1)), draft.timing)
        assertEquals("null", draft.json()["notes"].toString())
        assertFalse(draft.copy(endDate = date).valid)
        assertFalse(draft.copy(endDate = date.plusDays(367)).valid)
    }

    @Test fun wallTimesUseCompatibleDaylightSavingResolutionAndRejectOffsets() {
        val date = LocalDate.of(2026, 3, 29)
        val draft = CalendarDraft.new(date, zone).copy(startTime = LocalTime.of(2, 30), endTime = LocalTime.of(4, 0))
        assertEquals(date.atTime(3, 30).atZone(zone).toInstant().toEpochMilli(), (draft.timing as CalendarTiming.Timed).start)
        assertNull(draft.copy(timeZone = "+02:00").timing)
        assertFalse(draft.copy(endTime = LocalTime.of(1, 0)).valid)
    }

    @Test fun weeklyRulesRoundTripInMondayOrderWithOnlyOneEnding() {
        val recurrence = CalendarRecurrence(CalendarFrequency.Weekly, 2, setOf(DayOfWeek.FRIDAY, DayOfWeek.MONDAY), CalendarEnd.Count(10))
        assertEquals("[\"monday\",\"friday\"]", recurrence.json()["weekdays"].toString())
        assertEquals(recurrence, CalendarRecurrence.parse(recurrence.json()))
        assertTrue(recurrence.valid(date))
        assertFalse(recurrence.copy(interval = 0).valid(date))
        assertFalse(recurrence.copy(frequency = CalendarFrequency.Daily).valid(date))
        assertFalse(recurrence.copy(end = CalendarEnd.Until(date.minusDays(1))).valid(date))
        assertFalse(recurrence.copy(end = CalendarEnd.Count(10_001)).valid(date))
    }

    @Test fun draftsEditTheSeriesTimingAndRetainItsFullRecurrence() {
        val timing = CalendarTiming.AllDay(date.minusMonths(1), date.minusMonths(1).plusDays(1))
        val recurrence = CalendarRecurrence(CalendarFrequency.Monthly)
        val event = CalendarEvent("one", "team", "  Review  ", timing, "v1", "Notes\nline", "Room 4", recurrence.json())
        val draft = CalendarDraft.of(event, zone)
        assertEquals(timing, draft.timing)
        assertEquals("  Review  ", draft.title)
        assertEquals(recurrence, draft.recurrence)
        assertTrue(draft.valid)
        assertFalse(draft.copy(title = "bad\u0001title").valid)
        assertFalse(draft.copy(notes = "a".repeat(10_001)).valid)
    }

    @Test fun changingStartKeepsWallClockDurationAndAllDayKeepsTheVisibleLastDate() {
        val draft = CalendarDraft.new(date, zone).copy(startTime = LocalTime.of(23, 0), endDate = date.plusDays(1), endTime = LocalTime.of(1, 30))
        val moved = draft.startTime(LocalTime.of(22, 0))
        assertEquals(date.plusDays(1), moved.endDate)
        assertEquals(LocalTime.of(0, 30), moved.endTime)
        assertEquals(date.plusDays(4), moved.startDate(date.plusDays(3)).endDate)
        assertEquals(draft, draft.allDay(true).allDay(false))
        assertEquals(date.plusDays(2), draft.allDay(true).endDate)
    }

    @Test fun movingLaterWeeklyOccurrenceTurnsTheWholeSeriesAndItsEnding() {
        val recurrence = CalendarRecurrence(CalendarFrequency.Weekly, weekdays = setOf(DayOfWeek.TUESDAY, DayOfWeek.FRIDAY), end = CalendarEnd.Until(date.plusMonths(2)))
        val base = CalendarDraft.new(date, zone).copy(recurrence = recurrence)
        val event = CalendarEvent("one", "team", "Review", base.timing!!, "v1", recurrence = recurrence.json())
        val occurrence = base.startDate(date.plusWeeks(2)).timing!!
        val edit = CalendarDraft.of(event.copy(timing = occurrence), zone).startDate(date.plusWeeks(2).plusDays(2)).startTime(LocalTime.of(11, 0))
        val series = edit.forSeries(event, occurrence, zone)
        assertEquals(date.plusDays(2), series.startDate)
        assertEquals(LocalTime.of(11, 0), series.startTime)
        assertEquals(LocalTime.NOON, series.endTime)
        assertEquals(setOf(DayOfWeek.THURSDAY, DayOfWeek.SUNDAY), series.recurrence?.weekdays)
        assertEquals(CalendarEnd.Until(date.plusMonths(2).plusDays(2)), series.recurrence?.end)
        assertTrue(series.valid)
        val explicit = edit.copy(recurrence = CalendarRecurrence(CalendarFrequency.Daily)).forSeries(event, occurrence, zone)
        assertEquals(CalendarFrequency.Daily, explicit.recurrence?.frequency)
    }

    @Test fun textOnlyEditOfLaterOccurrenceKeepsBaseDateAndPreciseInstants() {
        val base = CalendarDraft.new(date, zone)
        val timing = (base.timing as CalendarTiming.Timed).let { it.copy(start = it.start + 12_345, end = it.end + 12_345) }
        val event = CalendarEvent("one", "team", "Review", timing, "v1")
        val occurrence = timing.copy(start = timing.start + 7 * CalendarTiming.DAY_MS, end = timing.end + 7 * CalendarTiming.DAY_MS)
        val edit = CalendarDraft.of(event.copy(timing = occurrence), zone).copy(title = "Renamed")
        assertEquals(timing, edit.forSeries(event, occurrence, zone).timing)
        assertEquals("Renamed", edit.forSeries(event, occurrence, zone).title)
    }
}