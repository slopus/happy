package com.slopus.happy.ui.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.time.LocalDate

@Immutable
internal data class MonthDay(val date: LocalDate, val number: String, val description: String, val count: Int)
@Immutable
internal data class MonthLine(val key: String, val from: Int, val to: Int, val lane: Int, val label: String, val description: String, val bar: Boolean)
@Immutable
internal data class MonthWeek(val days: List<MonthDay>, val lines: List<MonthLine>, val hidden: List<Int>)

/**
 * Desktop CalendarMonthView: Monday first, 24 weekday line, 28 date head,
 * 20 event lines with 2 gaps. Phone cells hold two lines (76 high) and use
 * the last for +N when needed; choosing a date shows its full agenda. At
 * larger text sizes both the date head and event lines grow in sp.
 * Calendar bars/lane placement and all labels arrive derived off Main.
 */
@Composable
internal fun CalendarMonthGrid(
    month: Int,
    weekdays: List<String>,
    weeks: List<MonthWeek>,
    today: LocalDate,
    selected: LocalDate,
    onSelect: (LocalDate) -> Unit,
) {
    val colors = HappyTheme.colors
    CardBlock(HomeCardPlace(true, true), tag = "calendar.month") {
        Column {
            Row(Modifier.fillMaxWidth().heightIn(min = 24.dp).testTag("calendar.weekdays"), verticalAlignment = Alignment.CenterVertically) {
                weekdays.forEach { weekday ->
                    Box(Modifier.weight(1f).padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
                        Text(weekday, style = happyTextStyle(11, 16, weight = FontWeight.SemiBold), color = colors.textSecondary, maxLines = 1,
                            modifier = Modifier.clearAndSetSemantics {})
                    }
                }
            }
            weeks.forEach { week -> CalendarMonthWeek(month, week, today, selected, onSelect) }
        }
    }
}

@Composable
private fun CalendarMonthWeek(month: Int, week: MonthWeek, today: LocalDate, selectedDate: LocalDate, onSelect: (LocalDate) -> Unit) {
    val colors = HappyTheme.colors
    val blue = RowTile.Blue
    val head = with(LocalDensity.current) { maxOf(28.dp, 16.sp.toDp() + 8.dp) }
    val line = with(LocalDensity.current) { maxOf(20.dp, 20.sp.toDp()) }
    val height = head + (line + 2.dp) * 2 + 4.dp
    Layout(content = {
        week.days.forEach { day ->
            val chosen = day.date == selectedDate
            Box(Modifier.background(if (chosen) blue.fill(colors.dark) else if (day.date.monthValue != month) colors.surface else colors.surfaceHigh)
                .clickable(role = Role.Button) { onSelect(day.date) }.semantics {
                    contentDescription = day.description
                    selected = chosen
                }.drawBehind { drawLine(colors.divider, Offset(0f, 0f), Offset(0f, size.height), 1f) }
                .testTag("calendar.day.${day.date}"), contentAlignment = Alignment.TopCenter) {
                Text(day.number, style = happyTextStyle(12, 16, weight = FontWeight.Medium),
                    color = if (day.date == today) Color.White else if (day.date.monthValue != month) colors.textSecondary else colors.text,
                    modifier = Modifier.padding(top = 4.dp).clip(CircleShape)
                        .background(if (day.date == today) colors.textLink else Color.Transparent)
                        .padding(horizontal = 6.dp).heightIn(min = 20.dp).clearAndSetSemantics {})
            }
        }
        week.lines.forEach { item ->
            Text(item.label, style = happyTextStyle(12, 16), color = if (item.bar) blue.ink(colors.dark) else colors.text,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(if (item.bar) blue.fill(colors.dark) else Color.Transparent)
                    .clickable { onSelect(week.days[item.from].date) }.padding(horizontal = 4.dp)
                    .semantics { contentDescription = item.description }.testTag("calendar.line.${item.key}"))
        }
        week.hidden.forEachIndexed { column, count ->
            if (count > 0) Text(pluralStringResource(R.plurals.calendar_more, count, count), style = happyTextStyle(12, 16), color = colors.textLink,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clickable { onSelect(week.days[column].date) }.padding(horizontal = 4.dp).testTag("calendar.more.${week.days[column].date}"))
        }
    }, modifier = Modifier.fillMaxWidth().testTag("calendar.week.${week.days.first().date}").drawBehind {
        drawLine(colors.divider, Offset(0f, size.height - .5f), Offset(size.width, size.height - .5f), 1f)
    }) { measurables, constraints ->
        val width = constraints.maxWidth
        val rowHeight = height.roundToPx()
        val headerHeight = head.roundToPx()
        val lineHeight = line.roundToPx()
        val gap = 2.dp.roundToPx()
        val inset = 4.dp.roundToPx()
        val dates = measurables.take(7).mapIndexed { column, measurable -> measurable.measure(Constraints.fixed(width * (column + 1) / 7 - width * column / 7, rowHeight)) }
        val eventLines = week.lines.mapIndexed { index, item ->
            measurables[7 + index].measure(Constraints.fixed((width * item.to / 7 - width * item.from / 7 - 2 * inset).coerceAtLeast(0), lineHeight))
        }
        val more = week.hidden.withIndex().filter { it.value > 0 }.mapIndexed { index, day ->
            measurables[7 + week.lines.size + index].measure(Constraints.fixed((width * (day.index + 1) / 7 - width * day.index / 7 - 2 * inset).coerceAtLeast(0), lineHeight))
        }
        layout(width, rowHeight) {
            dates.forEachIndexed { column, placeable -> placeable.placeRelative(width * column / 7, 0) }
            eventLines.forEachIndexed { index, placeable -> placeable.placeRelative(width * week.lines[index].from / 7 + inset, headerHeight + week.lines[index].lane * (lineHeight + gap)) }
            week.hidden.withIndex().filter { it.value > 0 }.forEachIndexed { index, day -> more[index].placeRelative(width * day.index / 7 + inset, headerHeight + lineHeight + gap) }
        }
    }
}