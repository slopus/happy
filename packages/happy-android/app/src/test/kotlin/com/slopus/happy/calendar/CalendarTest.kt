package com.slopus.happy.calendar

import com.slopus.happy.agent.AgentClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

class CalendarTest {
    private val berlin = ZoneId.of("Europe/Berlin")
    private fun json(text: String) = AgentClient.json.parseToJsonElement(text)

    @Test fun timingKeepsAllDayDatesIndependentOfTheViewersZone() {
        val timing = CalendarTiming.parse(json("""{"kind":"allDay","startDate":"2026-03-29","endDate":"2026-03-30"}"""))!!
        assertEquals(LocalDate.of(2026, 3, 29) to LocalDate.of(2026, 3, 30), timing.days(ZoneId.of("Pacific/Honolulu")))
        val span = timing.span(berlin)
        assertEquals(23 * 3_600_000L, span.last - span.first + 1)
        assertTrue(timing.spansDays)
    }

    @Test fun aTimedEventEndingAtMidnightDoesNotAppearOnTheNextDate() {
        val start = ZonedDateTime.of(2026, 10, 24, 23, 0, 0, 0, berlin).toInstant().toEpochMilli()
        val end = ZonedDateTime.of(2026, 10, 25, 0, 0, 0, 0, berlin).toInstant().toEpochMilli()
        val timing = CalendarTiming.Timed(start, end, "Europe/Berlin")
        assertEquals(LocalDate.of(2026, 10, 24) to LocalDate.of(2026, 10, 25), timing.days(berlin))
        assertTrue(!timing.spansDays)
    }

    @Test fun invalidDatesOffsetsAndExcessiveDurationsAreRejected() {
        assertNull(CalendarTiming.parse(json("""{"kind":"allDay","startDate":"2026-02-30","endDate":"2026-03-01"}""")))
        assertNull(CalendarTiming.parse(json("""{"kind":"allDay","startDate":"2026-01-01","endDate":"2027-01-03"}""")))
        assertNull(CalendarTiming.parse(json("""{"kind":"timed","start":10,"end":20,"timeZone":"+02:00"}""")))
        assertNull(CalendarTiming.parse(json("""{"kind":"timed","start":10,"end":10,"timeZone":"UTC"}""")))
        assertTrue(CalendarTiming.parse(json("""{"kind":"timed","start":10,"end":20,"timeZone":"US/Eastern"}""")) is CalendarTiming.Timed)
    }

    @Test fun rangesHonorTheServerLimitAndEscapeTheSurfaceAndZone() {
        val range = CalendarRange("team/calendar", 1, 2, "Europe/Berlin")
        assertEquals("/v0/surfaces/calendar/team%2Fcalendar?from=1&to=2&timeZone=Europe%2FBerlin", range.path)
        assertThrows(IllegalArgumentException::class.java) { CalendarRange("team", 0, 100 * CalendarTiming.DAY_MS + 1, "UTC") }
        assertThrows(IllegalArgumentException::class.java) { CalendarRange("team", 10, 10, "UTC") }
        assertNotEquals(CalendarRange("team", 1, 2, "Etc/GMT+2").key.filter(Char::isLetterOrDigit),
            CalendarRange("team", 1, 2, "Etc/GMT-2").key.filter(Char::isLetterOrDigit))
    }

    private val event = """{"id":"sync","surfaceId":"team","title":"  ","status":"active","version":"v1","recurrence":{"frequency":"weekly","interval":1,"weekdays":["monday"],"until":null,"count":10},"timing":{"kind":"timed","start":100,"end":200,"timeZone":"UTC"}}"""
    private val occurrence = """{"eventId":"sync","index":3,"timing":{"kind":"timed","start":300,"end":400,"timeZone":"UTC"}}"""

    @Test fun rangeReadsUseExpandedOccurrencesAndKeepTheSeriesMetadata() {
        val page = CalendarPage.parse(json("""{"events":[$event],"occurrences":[$occurrence],"truncated":true,"cursor":"cursor"}"""), "team")!!
        assertEquals("sync:3", page.items.single().occurrence.key)
        assertEquals(300L, (page.items.single().occurrence.timing as CalendarTiming.Timed).start)
        assertEquals("  ", page.items.single().event.title)
        assertEquals("weekly", page.items.single().event.recurrence!!["frequency"].toString().trim('"'))
        assertTrue(page.truncated)
    }

    @Test fun occurrencesCannotAttachToAnUnknownOrAnotherCalendarsEvent() {
        assertNull(CalendarPage.parse(json("""{"events":[],"occurrences":[$occurrence],"truncated":false,"cursor":"c"}"""), "team"))
        assertNull(CalendarPage.parse(json("""{"events":[$event],"occurrences":[$occurrence],"truncated":false,"cursor":"c"}"""), "other"))
        assertNull(CalendarPage.parse(json("""{"events":[$event],"occurrences":[$occurrence,$occurrence],"truncated":false,"cursor":"c"}"""), "team"))
    }
}