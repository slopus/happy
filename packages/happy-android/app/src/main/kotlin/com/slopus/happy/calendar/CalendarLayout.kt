package com.slopus.happy.calendar

import androidx.compose.runtime.Immutable
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/** Desktop surfaceCalendarStore: Monday-first whole weeks, 28–42 days per month. */
@Immutable
data class CalendarWindow(val firstDate: LocalDate, val days: Int) {
    fun range(surfaceId: String, zone: ZoneId) = CalendarRange(surfaceId,
        firstDate.atStartOfDay(zone).toInstant().toEpochMilli(), firstDate.plusDays(days.toLong()).atStartOfDay(zone).toInstant().toEpochMilli(), zone.id)

    companion object {
        fun week(date: LocalDate) = CalendarWindow(date.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)), 7)
        fun month(month: YearMonth): CalendarWindow {
            val first = week(month.atDay(1)).firstDate
            val end = month.plusMonths(1).atDay(1).with(TemporalAdjusters.nextOrSame(DayOfWeek.MONDAY))
            return CalendarWindow(first, (end.toEpochDay() - first.toEpochDay()).toInt())
        }
    }
}

/** One occurrence in a week row; [endColumn] is exclusive. */
@Immutable
data class CalendarBar(val item: CalendarItem, val startColumn: Int, val endColumn: Int, val continuesBefore: Boolean, val continuesAfter: Boolean, val bar: Boolean, val lane: Int)

@Immutable
data class CalendarBarFit(val shown: List<CalendarBar>, val hidden: List<Int>)

/**
 * Desktop calendarLayout.calendarWeekSegments: longest bars take the first
 * free lane across their covered dates; shorter events fill the free lanes.
 * This places already-expanded occurrences; it never computes recurrence.
 */
fun calendarBars(items: List<CalendarItem>, first: LocalDate, zone: ZoneId, barsOnly: Boolean = false): List<CalendarBar> {
    val pieces = items.mapNotNull { item ->
        val timing = item.occurrence.timing
        if (barsOnly && !timing.spansDays) return@mapNotNull null
        val (start, end) = timing.days(zone)
        val from = (start.toEpochDay() - first.toEpochDay()).toInt()
        val to = (end.toEpochDay() - first.toEpochDay()).toInt()
        if (to <= 0 || from >= 7) return@mapNotNull null
        CalendarBar(item, maxOf(0, from), minOf(7, to), from < 0, to > 7, timing.spansDays || to - from > 1, lane = 0)
    }.sortedWith(compareBy<CalendarBar>({ !it.bar }, { it.startColumn }, { -(it.endColumn - it.startColumn) }, { it.item.occurrence.timing.span(zone).first }))
    val lanes = ArrayList<BooleanArray>()
    return pieces.map { piece ->
        val lane = lanes.indexOfFirst { occupied -> (piece.startColumn until piece.endColumn).none { occupied[it] } }
            .takeIf { it >= 0 } ?: lanes.size.also { lanes += BooleanArray(7) }
        for (column in piece.startColumn until piece.endColumn) lanes[lane][column] = true
        piece.copy(lane = lane)
    }
}

/** Reserve the last lane for “+N more” on every date a hidden bar crosses. */
fun calendarBarsFit(bars: List<CalendarBar>, lanes: Int): CalendarBarFit {
    require(lanes >= 1)
    val overflow = BooleanArray(7)
    for (bar in bars) if (bar.lane >= lanes) for (day in bar.startColumn until bar.endColumn) overflow[day] = true
    val hidden = IntArray(7)
    val shown = bars.filter { bar ->
        val fits = bar.lane < lanes - 1 || (bar.lane == lanes - 1 && (bar.startColumn until bar.endColumn).none { overflow[it] })
        if (!fits) for (day in bar.startColumn until bar.endColumn) hidden[day]++
        fits
    }
    return CalendarBarFit(shown, hidden.toList())
}

@Immutable
data class CalendarTimedPiece(val item: CalendarItem, val column: Int, val startMinutes: Int, val endMinutes: Int,
    val continuesBefore: Boolean, val continuesAfter: Boolean, val lane: Int = 0, val lanes: Int = 1)

/**
 * Desktop calendarTimedSegments: cut at each midnight, group overlaps and
 * divide the width equally within each group. A very short event reserves
 * its drawn minimum of 20 minutes, so labels do not cover a neighbor.
 */
fun calendarTimedPieces(items: List<CalendarItem>, first: LocalDate, days: Int, zone: ZoneId): List<CalendarTimedPiece> = buildList {
    fun minutes(instant: Long): Int = Instant.ofEpochMilli(instant).atZone(zone).let { it.hour * 60 + it.minute }
    repeat(days) { column ->
        val date = first.plusDays(column.toLong())
        val dayStart = date.atStartOfDay(zone).toInstant().toEpochMilli()
        val dayEnd = date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val pieces = items.mapNotNull { item ->
            val timing = item.occurrence.timing as? CalendarTiming.Timed ?: return@mapNotNull null
            if (timing.spansDays || timing.end <= dayStart || timing.start >= dayEnd) return@mapNotNull null
            CalendarTimedPiece(item, column, if (timing.start <= dayStart) 0 else minutes(timing.start), if (timing.end >= dayEnd) 1440 else minutes(timing.end),
                continuesBefore = timing.start < dayStart, continuesAfter = timing.end > dayEnd)
        }.sortedWith(compareBy({ it.startMinutes }, { -it.endMinutes }))
        var group = ArrayList<CalendarTimedPiece>()
        var laneEnds = ArrayList<Int>()
        var groupEnd = -1
        fun flush() {
            addAll(group.map { it.copy(lanes = laneEnds.size) })
            group = ArrayList()
            laneEnds = ArrayList()
        }
        for (piece in pieces) {
            val end = maxOf(piece.endMinutes, piece.startMinutes + 20)
            if (piece.startMinutes >= groupEnd) flush()
            val lane = laneEnds.indexOfFirst { it <= piece.startMinutes }.takeIf { it >= 0 } ?: laneEnds.size.also { laneEnds += end }
            laneEnds[lane] = end
            group += piece.copy(lane = lane)
            groupEnd = maxOf(groupEnd, end)
        }
        flush()
    }
}

/** The selected date's agenda, with all-day entries before timed entries. */
fun calendarAgenda(items: List<CalendarItem>, date: LocalDate, zone: ZoneId): List<CalendarItem> = items.filter {
    val (first, end) = it.occurrence.timing.days(zone)
    date >= first && date < end
}.sortedWith(compareBy({ it.occurrence.timing !is CalendarTiming.AllDay }, { it.occurrence.timing.span(zone).first }, { it.occurrence.key }))