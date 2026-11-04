package com.slopus.happy.ui.calendar

import android.content.Context
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.width
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.calendar.CalendarEvent
import com.slopus.happy.calendar.CalendarItem
import com.slopus.happy.calendar.CalendarOccurrence
import com.slopus.happy.calendar.CalendarTiming
import com.slopus.happy.calendar.CalendarWindow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate
import java.time.ZoneId

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CalendarWeekGridTest {
    @get:Rule val rule = createComposeRule()
    private val date = LocalDate.of(2026, 10, 19)
    private val zone = ZoneId.of("UTC")
    private fun event(id: String, from: Int, to: Int): CalendarItem {
        val start = date.atStartOfDay(zone).toInstant().toEpochMilli()
        val timing = CalendarTiming.Timed(start + from * 60_000, start + to * 60_000, zone.id)
        return CalendarItem(CalendarEvent(id, "team", id, timing, "v1"), CalendarOccurrence(id, 0, timing))
    }
    private fun plan() = calendarWeekPlan(listOf(event("one", 540, 600), event("two", 570, 660), event("late", 1380, 1410)),
        CalendarWindow.week(date), zone, ApplicationProvider.getApplicationContext<Context>().resources)

    @Test fun narrowWeekUsesScrollableDaysAndSplitsOverlappingEvents() {
        var chosen: CalendarItem? = null
        rule.setHappyContent { CalendarWeekGrid(plan(), date.atTime(9, 30).atZone(zone), {}, { chosen = it }) }
        rule.waitForIdle()
        assertDp("72 gutter plus seven 96 days", 744, rule.node("calendar.week.grid").bounds.width)
        assertDp("card keyline plus gutter and gap", 90, rule.node("calendar.week.event.one:0:0").bounds.left)
        assertDp("half day less gaps", 44, rule.node("calendar.week.event.one:0:0").bounds.width)
        assertDp("overlap second lane", 138, rule.node("calendar.week.event.two:0:0").bounds.left)
        rule.node("calendar.week.event.late:0:0").assertDoesNotExist()
        rule.node("calendar.week.event.one:0:0").performClick()
        assertEquals("one", chosen?.event?.id)
    }

    @Test fun largeTextGrowsHoursWithoutChangingHorizontalDayMeasure() {
        rule.setHappyContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                CalendarWeekGrid(plan(), date.atTime(9, 30).atZone(zone), {}, {})
            }
        }
        assertTrue(rule.node("calendar.week.grid").bounds.bottom - rule.node("calendar.week.grid").bounds.top > androidx.compose.ui.unit.Dp(1152f))
        assertDp("day widths stay physical", 44, rule.node("calendar.week.event.one:0:0").bounds.width)
    }

    @Test @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun tabletWeekFitsTheReadableColumn() {
        rule.setHappyContent { ProvideWindowLayout { CalendarWeekGrid(plan(), date.atTime(9, 30).atZone(zone), {}, {}) } }
        assertDp("tablet card", 256, rule.node("calendar.week.body").bounds.left)
        assertDp("all seven days fit", 768, rule.node("calendar.week.grid").bounds.width)
    }

    @Test fun holdingMovesOnQuarterHoursAndSendsOnlyTheFinalDrop() {
        val changes = mutableListOf<CalendarTiming>()
        rule.setHappyContent { CalendarWeekGrid(plan(), date.atTime(9, 30).atZone(zone), {}, {}, onMove = { _, timing -> changes += timing }) }
        val node = rule.node("calendar.week.event.one:0:0")
        val before = node.bounds
        node.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(600)
        node.performTouchInput { moveBy(Offset(96 * rule.density.density, 13 * rule.density.density)) }
        rule.waitForIdle()
        assertTrue(changes.isEmpty())
        assertDp("move one day", before.left + androidx.compose.ui.unit.Dp(96f), node.bounds.left)
        assertDp("snap quarter hour", before.top + androidx.compose.ui.unit.Dp(12f), node.bounds.top)
        node.performTouchInput { up() }
        rule.waitForIdle()
        val original = event("one", 540, 600).occurrence.timing as CalendarTiming.Timed
        assertEquals(listOf(original.copy(start = original.start + CalendarTiming.DAY_MS + 15 * 60_000, end = original.end + CalendarTiming.DAY_MS + 15 * 60_000)), changes)
    }

    @Test fun holdingBottomEdgeResizesAndCancellationSendsNothing() {
        val changes = mutableListOf<CalendarTiming>()
        rule.setHappyContent { CalendarWeekGrid(plan(), date.atTime(9, 30).atZone(zone), {}, {}, onMove = { _, timing -> changes += timing }) }
        val node = rule.node("calendar.week.event.one:0:0")
        node.performTouchInput { down(Offset(width / 2f, height - 2f)) }
        rule.mainClock.advanceTimeBy(600)
        node.performTouchInput { moveBy(Offset(0f, 24 * rule.density.density)) }
        rule.waitForIdle()
        assertDp("resize preview", 72, node.bounds.bottom - node.bounds.top)
        node.performTouchInput { up() }
        rule.waitForIdle()
        val original = event("one", 540, 600).occurrence.timing as CalendarTiming.Timed
        assertEquals(listOf(original.copy(end = original.end + 30 * 60_000)), changes)
        node.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(600)
        node.performTouchInput { moveBy(Offset(0f, 24 * rule.density.density)); cancel() }
        rule.waitForIdle()
        assertEquals(1, changes.size)
        val actions = node.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        assertEquals(6, actions.size)
        rule.runOnIdle { actions.first { it.label == "Extend by 15 minutes" }.action() }
        assertEquals(original.copy(end = original.end + 15 * 60_000), changes.last())
    }

    @Test fun allDayBarsMoveByWholeDaysAndOpenTheirEvent() {
        val timing = CalendarTiming.AllDay(date, date.plusDays(2))
        val item = CalendarItem(CalendarEvent("offsite", "team", "Offsite", timing, "v1"), CalendarOccurrence("offsite", 0, timing))
        var selected: CalendarItem? = null
        var changed: CalendarTiming? = null
        val plan = calendarWeekPlan(listOf(item), CalendarWindow.week(date), zone, ApplicationProvider.getApplicationContext<Context>().resources)
        rule.setHappyContent { CalendarWeekGrid(plan, date.atTime(9, 30).atZone(zone), {}, { selected = it }, onMove = { _, value -> changed = value }) }
        val bar = rule.node("calendar.week.bar.offsite:0")
        bar.performClick()
        assertEquals(item, selected)
        bar.performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(600)
        bar.performTouchInput { moveBy(Offset(96 * rule.density.density, 0f)); up() }
        rule.waitForIdle()
        assertEquals(CalendarTiming.AllDay(date.plusDays(1), date.plusDays(3)), changed)
    }
}