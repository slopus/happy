package com.slopus.happy.calendar

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.security.MessageDigest

/**
 * Calendar API timing is either instants in the event's IANA zone, or
 * dates without a zone. Ends are exclusive in both cases. The daemon
 * expands recurrence; the phone only places its returned occurrences.
 */
@Immutable
sealed interface CalendarTiming {
    data class Timed(val start: Long, val end: Long, val timeZone: String) : CalendarTiming
    data class AllDay(val startDate: LocalDate, val endDate: LocalDate) : CalendarTiming

    fun span(zone: ZoneId): LongRange = when (this) {
        is Timed -> start until end
        is AllDay -> startDate.atStartOfDay(zone).toInstant().toEpochMilli() until endDate.atStartOfDay(zone).toInstant().toEpochMilli()
    }

    /** Desktop calendarTimingDays: an event ending at midnight excludes that date. */
    fun days(zone: ZoneId): Pair<LocalDate, LocalDate> = when (this) {
        is AllDay -> startDate to endDate
        is Timed -> Instant.ofEpochMilli(start).atZone(zone).toLocalDate() to Instant.ofEpochMilli(end - 1).atZone(zone).toLocalDate().plusDays(1)
    }

    /** Desktop draws timed events lasting at least 24 hours across the all-day strip. */
    val spansDays: Boolean get() = this is AllDay || (this is Timed && end - start >= DAY_MS)

    companion object {
        const val DAY_MS = 86_400_000L
        const val INSTANT_LIMIT = 253_402_300_800_000L

        internal fun date(text: String?): LocalDate? {
            if (text == null || !Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(text)) return null
            return runCatching { LocalDate.parse(text) }.getOrNull()?.takeIf { it.year in 1970..9999 }
        }

        fun parse(value: JsonElement?): CalendarTiming? {
            val data = value.obj ?: return null
            return when (data["kind"].str) {
                "timed" -> {
                    val start = (data["start"] as? JsonPrimitive)?.longOrNull ?: return null
                    val end = (data["end"] as? JsonPrimitive)?.longOrNull ?: return null
                    val zone = data["timeZone"].str ?: return null
                    if (start < 0 || end >= INSTANT_LIMIT || start >= end || end - start > 366 * DAY_MS || zone !in ZoneId.getAvailableZoneIds()) return null
                    Timed(start, end, zone)
                }
                "allDay" -> {
                    val start = date(data["startDate"].str) ?: return null
                    val end = date(data["endDate"].str) ?: return null
                    if (!end.isAfter(start) || end.toEpochDay() - start.toEpochDay() > 366) return null
                    AllDay(start, end)
                }
                else -> null
            }
        }
    }
}

@Immutable
data class CalendarEvent(
    val id: String,
    val surfaceId: String,
    val title: String,
    val timing: CalendarTiming,
    val version: String,
    val notes: String? = null,
    val location: String? = null,
    val recurrence: JsonObject? = null,
    val authorUserId: String? = null,
) {
    companion object {
        fun parse(value: JsonElement?): CalendarEvent? {
            val data = value.obj ?: return null
            if (data["status"].str != "active") return null
            return CalendarEvent(data["id"].str ?: return null, data["surfaceId"].str ?: return null, data["title"].str ?: return null,
                CalendarTiming.parse(data["timing"]) ?: return null, data["version"].str ?: return null,
                data["notes"].str, data["location"].str, data["recurrence"].obj, data["authorUserId"].str)
        }
    }
}

@Immutable
data class CalendarOccurrence(val eventId: String, val index: Long, val timing: CalendarTiming) {
    val key: String get() = "$eventId:$index"
}

@Immutable
data class CalendarItem(val event: CalendarEvent, val occurrence: CalendarOccurrence)

/** A range is always [from, to), no longer than the API's 100 days. */
@Immutable
data class CalendarRange(val surfaceId: String, val from: Long, val to: Long, val timeZone: String) {
    init {
        require(from >= 0 && to <= CalendarTiming.INSTANT_LIMIT && from < to && to - from <= 100 * CalendarTiming.DAY_MS)
        require(timeZone in ZoneId.getAvailableZoneIds())
    }
    val zone: ZoneId get() = ZoneId.of(timeZone)
    // Session resource filenames remove punctuation. Hash the whole range so
    // IANA names such as Etc/GMT+2 and Etc/GMT-2 cannot share one kept page.
    val key: String = "calendar:" + MessageDigest.getInstance("SHA-256")
        .digest("$surfaceId\n$from\n$to\n$timeZone".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    val path: String get() = "/v0/surfaces/calendar/${AgentClient.escape(surfaceId)}?from=$from&to=$to&timeZone=${AgentClient.escape(timeZone)}"
}

@Immutable
data class CalendarPage(val items: List<CalendarItem>, val truncated: Boolean, val cursor: String) {
    companion object {
        /** Reject a broken range response rather than attach occurrences to the wrong event. */
        fun parse(value: JsonElement?, surfaceId: String): CalendarPage? {
            val data = value.obj ?: return null
            val rawEvents = data["events"].arr ?: return null
            val rawOccurrences = data["occurrences"].arr ?: return null
            val events = LinkedHashMap<String, CalendarEvent>()
            for (raw in rawEvents) {
                val event = CalendarEvent.parse(raw)?.takeIf { it.surfaceId == surfaceId } ?: return null
                if (events.put(event.id, event) != null) return null
            }
            val keys = HashSet<String>()
            val items = ArrayList<CalendarItem>()
            for (raw in rawOccurrences) {
                val occurrence = raw.obj ?: return null
                val eventId = occurrence["eventId"].str ?: return null
                val index = (occurrence["index"] as? JsonPrimitive)?.longOrNull?.takeIf { it >= 0 } ?: return null
                val timing = CalendarTiming.parse(occurrence["timing"]) ?: return null
                val event = events[eventId] ?: return null
                val item = CalendarOccurrence(eventId, index, timing)
                if (!keys.add(item.key)) return null
                items += CalendarItem(event, item)
            }
            return CalendarPage(items, data["truncated"].bool ?: return null, data["cursor"].str ?: return null)
        }
    }
}