package com.slopus.happy.ui.calendar

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.calendar.CalendarTiming
import com.slopus.happy.calendar.calendarMove
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.time.LocalDate
import java.time.ZonedDateTime
import java.time.Instant
import kotlin.math.roundToInt

private data class CalendarHold(val key: String, val item: CalendarItem, val resize: Boolean, val delta: Offset = Offset.Zero,
    val days: Int = 0, val minutes: Int = 0)

/**
 * Desktop CalendarWeekView: 72dp hour gutter, days at least 96dp, 48dp
 * hours and a 20dp minimum event. Narrow windows scroll across the week.
 * Text grows with the system font. The grid is one drawing and only event
 * labels near the visible hours are composed, even for a full API page.
 * Native long-hold move/bottom-edge resize uses desktop's 15 minute grid.
 * Selection and release haptics follow Telegram ItemTouchHelper:813–897 and
 * ChatMessageCell:5572. See research/telegram-calendar.md.
 */
@Composable
internal fun CalendarWeekGrid(plan: CalendarWeekPlan, now: ZonedDateTime, onDay: (LocalDate) -> Unit,
    onEvent: (CalendarItem) -> Unit, initialMinute: Int = 7 * 60, onMove: ((CalendarItem, CalendarTiming) -> Unit)? = null) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val hour = with(density) { maxOf(48.dp, 32.sp.toDp() + 16.dp) }
    val line = with(density) { maxOf(20.dp, 20.sp.toDp()) }
    val vertical = rememberScrollState()
    val horizontal = rememberScrollState()
    val hourPx = with(density) { hour.toPx() }
    val view = LocalView.current
    val move by rememberUpdatedState(onMove)
    var held by remember(plan) { mutableStateOf<CalendarHold?>(null) }
    val earlier = stringResource(R.string.calendar_move_earlier)
    val later = stringResource(R.string.calendar_move_later)
    val previousDay = stringResource(R.string.calendar_move_previous_day)
    val nextDay = stringResource(R.string.calendar_move_next_day)
    val shorten = stringResource(R.string.calendar_shorten)
    val extend = stringResource(R.string.calendar_extend)
    LaunchedEffect(vertical, hourPx) { vertical.scrollTo((initialMinute / 60f * hourPx).roundToInt()) }
    val startMinute by remember(hourPx) { derivedStateOf { (vertical.value / hourPx * 60).toInt() - 60 } }
    val endMinute by remember(hourPx) { derivedStateOf { ((vertical.value + vertical.viewportSize) / hourPx * 60).toInt() + 60 } }
    val visible = remember(plan.events, startMinute, endMinute) {
        plan.events.filter { it.piece.endMinutes >= startMinute && it.piece.startMinutes <= endMinute }
    }
    CardBlock(HomeCardPlace(true, true), tag = "calendar.week") {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val day = maxOf(96.dp, (maxWidth - 72.dp) / 7)
            val dayPx = with(density) { day.toPx() }
            val width = 72.dp + day * 7
            fun gestures(key: String, item: CalendarItem, column: Int, bar: Boolean): Modifier {
                if (onMove == null) return Modifier
                return Modifier.pointerInput(key, item, dayPx, hourPx, now.zone) {
                    detectDragGesturesAfterLongPress(onDragStart = { point ->
                        held = CalendarHold(key, item, !bar && point.y >= size.height - 8.dp.toPx())
                        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    }, onDragCancel = { held = null }, onDragEnd = {
                        val current = held
                        held = null
                        if (current != null && (current.days != 0 || current.minutes != 0)) {
                            calendarMove(item.occurrence.timing, now.zone, current.days, current.minutes, current.resize)?.let { move?.invoke(item, it) }
                            view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                        }
                    }) { change, amount ->
                        val current = held ?: return@detectDragGesturesAfterLongPress
                        change.consume()
                        val delta = current.delta + amount
                        val days = (delta.x / dayPx).roundToInt().coerceIn(-column, 6 - column)
                        val rawMinutes = if (bar) 0 else (delta.y / hourPx * 60 / 15).roundToInt() * 15
                        val start = (item.occurrence.timing as? CalendarTiming.Timed)?.let { Instant.ofEpochMilli(it.start).atZone(now.zone) }
                        val minute = start?.let { it.hour * 60 + it.minute } ?: 0
                        val minutes = if (current.resize) rawMinutes else rawMinutes.coerceIn(-minute, 1439 - minute)
                        val candidate = calendarMove(item.occurrence.timing, now.zone, days, minutes, current.resize)
                        held = if (candidate == null) current.copy(delta = delta) else current.copy(delta = delta, days = days, minutes = minutes)
                    }
                }.semantics {
                    fun action(label: String, days: Int = 0, minutes: Int = 0, resize: Boolean = false) = CustomAccessibilityAction(label) {
                        calendarMove(item.occurrence.timing, now.zone, days, minutes, resize)?.let { move?.invoke(item, it); true } ?: false
                    }
                    customActions = listOf(action(previousDay, days = -1), action(nextDay, days = 1)) + if (bar) emptyList() else
                        listOf(action(earlier, minutes = -15), action(later, minutes = 15), action(shorten, minutes = -15, resize = true), action(extend, minutes = 15, resize = true))
                }
            }
            Column(Modifier.horizontalScroll(horizontal, enabled = held == null).testTag("calendar.week.horizontal")) {
                Layout(content = {
                    Text(stringResource(R.string.calendar_all_day), style = happyTextStyle(11, 16), color = colors.textSecondary, modifier = Modifier.padding(4.dp))
                    plan.days.forEach { date ->
                        Text(date.number, style = happyTextStyle(12, 16, weight = FontWeight.Medium), color = if (date.date == now.toLocalDate()) colors.textLink else colors.text,
                            maxLines = 1, modifier = Modifier.clickable { onDay(date.date) }.padding(4.dp)
                                .semantics { contentDescription = date.description }.testTag("calendar.week.day.${date.date}"))
                    }
                    plan.bars.forEach { bar ->
                        Text(bar.label, style = happyTextStyle(12, 16), color = RowTile.Blue.ink(colors.dark), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(RowTile.Blue.fill(colors.dark))
                                .then(plan.barItems[bar.key]?.let { gestures("bar.${bar.key}", it, bar.from, true) } ?: Modifier)
                                .clickable { plan.barItems[bar.key]?.let(onEvent) ?: onDay(plan.days[bar.from].date) }.padding(horizontal = 4.dp)
                                .semantics { contentDescription = bar.description }.testTag("calendar.week.bar.${bar.key}"))
                    }
                    plan.hidden.forEachIndexed { column, count -> if (count > 0) {
                        Text(pluralStringResource(R.plurals.calendar_more, count, count), style = happyTextStyle(12, 16), color = colors.textLink, maxLines = 1,
                            modifier = Modifier.clickable { onDay(plan.days[column].date) }.padding(horizontal = 4.dp))
                    } }
                }, modifier = Modifier.width(width).testTag("calendar.week.header")) { children, _ ->
                    val gutter = 72.dp.roundToPx()
                    val dayWidth = day.roundToPx()
                    val header = maxOf(32.dp.roundToPx(), line.roundToPx() + 8.dp.roundToPx())
                    val stride = line.roundToPx() + 2.dp.roundToPx()
                    val lanes = maxOf(plan.bars.maxOfOrNull { it.lane + 1 } ?: 0, if (plan.hidden.any { it > 0 }) 3 else 0)
                    val height = header + maxOf(1, lanes) * stride + 4.dp.roundToPx()
                    val label = children[0].measure(Constraints(maxWidth = gutter, maxHeight = height - header))
                    val dates = children.drop(1).take(7).map { it.measure(Constraints.fixed(dayWidth, header)) }
                    val bars = plan.bars.mapIndexed { index, bar -> children[8 + index].measure(Constraints.fixed(dayWidth * (bar.to - bar.from) - 8.dp.roundToPx(), line.roundToPx())) }
                    val more = children.drop(8 + bars.size).map { it.measure(Constraints.fixed(dayWidth - 8.dp.roundToPx(), line.roundToPx())) }
                    layout(width.roundToPx(), height) {
                        label.placeRelative(0, header)
                        dates.forEachIndexed { index, date -> date.placeRelative(gutter + index * dayWidth, 0) }
                        bars.forEachIndexed { index, bar ->
                            val shift = held?.takeIf { it.key == "bar.${plan.bars[index].key}" }?.days ?: 0
                            bar.placeRelative(gutter + (plan.bars[index].from + shift) * dayWidth + 4.dp.roundToPx(), header + plan.bars[index].lane * stride)
                        }
                        plan.hidden.withIndex().filter { it.value > 0 }.forEachIndexed { index, hidden -> more[index].placeRelative(gutter + hidden.index * dayWidth + 4.dp.roundToPx(), header + 2 * stride) }
                    }
                }
                Box(Modifier.width(width).height(480.dp).verticalScroll(vertical, enabled = held == null).testTag("calendar.week.hours")) {
                    Layout(content = {
                        Canvas(Modifier.fillMaxSize()) {
                            val gutter = 72.dp.toPx()
                            val dayWidth = day.toPx()
                            repeat(25) { hour -> drawLine(colors.divider, Offset(gutter, hour * hourPx), Offset(size.width, hour * hourPx), 1f) }
                            repeat(8) { column -> drawLine(colors.divider, Offset(gutter + column * dayWidth, 0f), Offset(gutter + column * dayWidth, size.height), 1f) }
                            val today = plan.days.indexOfFirst { it.date == now.toLocalDate() }
                            if (today >= 0) {
                                val y = (now.hour + now.minute / 60f) * hourPx
                                drawLine(Color(0xFFFF3B30), Offset(gutter + today * dayWidth, y), Offset(gutter + (today + 1) * dayWidth, y), 2.dp.toPx())
                            }
                        }
                        plan.hours.forEach { label -> Text(label, style = happyTextStyle(11, 16), color = colors.textSecondary, modifier = Modifier.padding(horizontal = 4.dp)) }
                        visible.forEach { event ->
                            val key = "${event.piece.item.occurrence.key}:${event.piece.column}"
                            Box(modifier = Modifier.testTag("calendar.week.event.$key")
                                    .clip(RoundedCornerShape(4.dp)).background(RowTile.Blue.fill(colors.dark))
                                    .then(gestures(key, event.piece.item, event.piece.column, false))
                                    .clickable { onEvent(event.piece.item) }.semantics { contentDescription = event.description }) {
                                Text(event.title, style = happyTextStyle(12, 16), color = RowTile.Blue.ink(colors.dark), maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(4.dp))
                                if (onMove != null) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp).width(12.dp).height(2.dp).background(RowTile.Blue.ink(colors.dark), RoundedCornerShape(1.dp)))
                            }
                        }
                    }, modifier = Modifier.width(width).height(hour * 24).testTag("calendar.week.grid")) { children, constraints ->
                        val height = (hour * 24).roundToPx()
                        val gutter = 72.dp.roundToPx()
                        val dayWidth = day.roundToPx()
                        val background = children[0].measure(Constraints.fixed(constraints.maxWidth, height))
                        val labels = children.drop(1).take(24).map { it.measure(Constraints(maxWidth = gutter, maxHeight = hour.roundToPx())) }
                        val events = visible.mapIndexed { index, event ->
                            val eventWidth = (dayWidth.toFloat() / event.piece.lanes).toInt()
                            val current = held?.takeIf { it.key == "${event.piece.item.occurrence.key}:${event.piece.column}" }
                            val extra = if (current?.resize == true) current.days * 1440 + current.minutes else 0
                            val eventHeight = maxOf(line.roundToPx(), ((event.piece.endMinutes - event.piece.startMinutes + extra).coerceAtLeast(15) / 60f * hourPx).roundToInt())
                            children[25 + index].measure(Constraints.fixed((eventWidth - 4.dp.roundToPx()).coerceAtLeast(0), eventHeight))
                        }
                        layout(constraints.maxWidth, height) {
                            background.placeRelative(0, 0)
                            labels.forEachIndexed { hour, label -> label.placeRelative(0, (hour * hourPx).roundToInt()) }
                            events.forEachIndexed { index, event ->
                                val piece = visible[index].piece
                                val current = held?.takeIf { it.key == "${piece.item.occurrence.key}:${piece.column}" }
                                val days = current?.takeUnless { it.resize }?.days ?: 0
                                val minutes = current?.takeUnless { it.resize }?.minutes ?: 0
                                event.placeRelative(gutter + (piece.column + days) * dayWidth + (piece.lane * dayWidth.toFloat() / piece.lanes).toInt() + 2.dp.roundToPx(), ((piece.startMinutes + minutes) / 60f * hourPx).roundToInt(), zIndex = if (current != null) 1f else 0f)
                            }
                        }
                    }
                }
            }
        }
    }
}