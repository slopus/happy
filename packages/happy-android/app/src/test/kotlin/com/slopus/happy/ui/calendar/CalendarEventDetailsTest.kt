package com.slopus.happy.ui.calendar

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.calendar.CalendarEnd
import com.slopus.happy.calendar.CalendarEvent
import com.slopus.happy.calendar.CalendarFrequency
import com.slopus.happy.calendar.CalendarRecurrence
import com.slopus.happy.calendar.CalendarTiming
import com.slopus.happy.ui.PHONE
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CalendarEventDetailsTest {
    private val words get() = ApplicationProvider.getApplicationContext<Context>().resources
    private val date = LocalDate.of(2026, 11, 5)
    @Test fun allDayConflictIncludesItsDateAndFullRecurrenceRatherThanOnlyAllDay() {
        val rule = CalendarRecurrence(CalendarFrequency.Weekly, 2, setOf(DayOfWeek.THURSDAY), CalendarEnd.Count(3))
        val event = CalendarEvent("one", "team", "Theirs", CalendarTiming.AllDay(date, date.plusDays(1)), "v2", "Bring notes", "Room 7", rule.json())
        val details = calendarEventDetails(event, ZoneId.of("UTC"), Locale.US, words)
        listOf("Theirs", "Nov 5, 2026", "Weekly", "Every 2", "Thu", "Number of events: 3", "Room 7", "Bring notes").forEach { assertTrue(details, it in details) }
    }
    @Test fun timedConflictIncludesDateAndItsOwnZoneEvenWhenViewerUsesAnotherZone() {
        val zone = ZoneId.of("America/New_York")
        val start = date.atTime(9, 0).atZone(zone).toInstant().toEpochMilli()
        val event = CalendarEvent("one", "team", "Theirs", CalendarTiming.Timed(start, start + 3_600_000, zone.id), "v2")
        val details = calendarEventDetails(event, ZoneId.of("Asia/Tokyo"), Locale.US, words)
        assertTrue(details, "11/5/26" in details)
        assertTrue(details, "9:00" in details)
        assertTrue(details, "America/New_York" in details)
    }
}