package com.slopus.happy.ui.calendar

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.time.LocalDate
import java.time.ZonedDateTime
import kotlin.math.roundToInt

/**
 * Desktop CalendarWeekView: 72dp hour gutter, days at least 96dp, 48dp
 * hours and a 20dp minimum event. Narrow windows scroll across the week.
 * Text grows with the system font. The grid is one drawing and only event
 * labels near the visible hours are composed, even for a full API page.
 */
@Composable
internal fun CalendarWeekGrid(plan: CalendarWeekPlan, now: ZonedDateTime, onDay: (LocalDate) -> Unit,
    onEvent: (CalendarItem) -> Unit, initialMinute: Int = 8 * 60) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val hour = with(density) { maxOf(48.dp, 32.sp.toDp() + 16.dp) }
    val line = with(density) { maxOf(20.dp, 20.sp.toDp()) }
    val vertical = rememberScrollState()
    val horizontal = rememberScrollState()
    val hourPx = with(density) { hour.toPx() }
    LaunchedEffect(vertical, hourPx) { vertical.scrollTo((initialMinute / 60f * hourPx).roundToInt()) }
    val startMinute by remember(hourPx) { derivedStateOf { (vertical.value / hourPx * 60).toInt() - 60 } }
    val endMinute by remember(hourPx) { derivedStateOf { ((vertical.value + vertical.viewportSize) / hourPx * 60).toInt() + 60 } }
    val visible = remember(plan.events, startMinute, endMinute) {
        plan.events.filter { it.piece.endMinutes >= startMinute && it.piece.startMinutes <= endMinute }
    }
    CardBlock(HomeCardPlace(true, true), tag = "calendar.week") {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val day = maxOf(96.dp, (maxWidth - 72.dp) / 7)
            val width = 72.dp + day * 7
            Column(Modifier.horizontalScroll(horizontal).testTag("calendar.week.horizontal")) {
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
                                .clickable { onDay(plan.days[bar.from].date) }.padding(horizontal = 4.dp)
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
                        bars.forEachIndexed { index, bar -> bar.placeRelative(gutter + plan.bars[index].from * dayWidth + 4.dp.roundToPx(), header + plan.bars[index].lane * stride) }
                        plan.hidden.withIndex().filter { it.value > 0 }.forEachIndexed { index, hidden -> more[index].placeRelative(gutter + hidden.index * dayWidth + 4.dp.roundToPx(), header + 2 * stride) }
                    }
                }
                Box(Modifier.width(width).height(480.dp).verticalScroll(vertical).testTag("calendar.week.hours")) {
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
                            Text(event.title, style = happyTextStyle(12, 16), color = RowTile.Blue.ink(colors.dark), maxLines = 2, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag("calendar.week.event.${event.piece.item.occurrence.key}:${event.piece.column}")
                                    .clip(RoundedCornerShape(4.dp)).background(RowTile.Blue.fill(colors.dark))
                                    .clickable { onEvent(event.piece.item) }.padding(4.dp).semantics { contentDescription = event.description })
                        }
                    }, modifier = Modifier.width(width).height(hour * 24).testTag("calendar.week.grid")) { children, constraints ->
                        val height = (hour * 24).roundToPx()
                        val gutter = 72.dp.roundToPx()
                        val dayWidth = day.roundToPx()
                        val background = children[0].measure(Constraints.fixed(constraints.maxWidth, height))
                        val labels = children.drop(1).take(24).map { it.measure(Constraints(maxWidth = gutter, maxHeight = hour.roundToPx())) }
                        val events = visible.mapIndexed { index, event ->
                            val eventWidth = (dayWidth.toFloat() / event.piece.lanes).toInt()
                            val eventHeight = maxOf(line.roundToPx(), ((event.piece.endMinutes - event.piece.startMinutes) / 60f * hourPx).roundToInt())
                            children[25 + index].measure(Constraints.fixed((eventWidth - 4.dp.roundToPx()).coerceAtLeast(0), eventHeight))
                        }
                        layout(constraints.maxWidth, height) {
                            background.placeRelative(0, 0)
                            labels.forEachIndexed { hour, label -> label.placeRelative(0, (hour * hourPx).roundToInt()) }
                            events.forEachIndexed { index, event ->
                                val piece = visible[index].piece
                                event.placeRelative(gutter + piece.column * dayWidth + (piece.lane * dayWidth.toFloat() / piece.lanes).toInt() + 2.dp.roundToPx(), (piece.startMinutes / 60f * hourPx).roundToInt())
                            }
                        }
                    }
                }
            }
        }
    }
}