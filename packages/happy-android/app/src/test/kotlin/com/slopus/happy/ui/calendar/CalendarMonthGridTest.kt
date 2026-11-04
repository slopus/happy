package com.slopus.happy.ui.calendar

import android.content.Context
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
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
import java.time.YearMonth
import java.time.ZoneId

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CalendarMonthGridTest {
    @get:Rule val rule = createComposeRule()
    private val chosen = LocalDate.of(2026, 10, 19)
    private val window = CalendarWindow.month(YearMonth.of(2026, 10))
    private fun plan(): CalendarMonthPlan {
        val timing = CalendarTiming.AllDay(chosen, chosen.plusDays(1))
        val items = List(3) { CalendarItem(CalendarEvent("event$it", "team", "Event $it", timing, "v1"), CalendarOccurrence("event$it", 0, timing)) }
        return calendarMonthPlan(items, window, chosen, ZoneId.of("UTC"), ApplicationProvider.getApplicationContext<Context>().resources)
    }

    @Test fun monthKeepsWholeWeekRowsAndTheOverflowChoosesItsFullAgenda() {
        val plan = plan()
        var picked: LocalDate? = null
        rule.setHappyContent { CalendarMonthGrid(10, plan.weekdays, plan.weeks, chosen, chosen) { picked = it } }
        assertDp("card edge", 16, rule.node("calendar.month.body").bounds.left)
        assertDp("weekday line", 24, rule.node("calendar.weekdays").bounds.height)
        assertDp("week row", 76, rule.node("calendar.week.2026-09-28").bounds.height)
        assertDp("five weeks and weekdays", 404, rule.node("calendar.month.body").bounds.height)
        rule.node("calendar.day.2026-10-19").assertIsSelected()
        rule.node("calendar.more.2026-10-19").performClick()
        assertEquals(chosen, picked)
        rule.node("calendar.day.2026-10-20").performClick()
        assertEquals(chosen.plusDays(1), picked)
    }

    @Test fun dateHeadsAndEventLinesGrowWithTheSystemFont() {
        val plan = plan()
        rule.setHappyContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                CalendarMonthGrid(10, plan.weekdays, plan.weeks, chosen, chosen) {}
            }
        }
        assertTrue(rule.node("calendar.week.2026-09-28").bounds.height > 76.dp)
        // Android's non-linear 2x font curve maps this 20sp slot to 34dp.
        assertDp("scaled event line", 34, rule.node("calendar.line.event0:0:3").bounds.height)
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun calendarUsesTheTabletReadableColumn() {
        val plan = plan()
        rule.setHappyContent { ProvideWindowLayout { CalendarMonthGrid(10, plan.weekdays, plan.weeks, chosen, chosen) {} } }
        assertDp("tablet edge", 256, rule.node("calendar.month.body").bounds.left)
        assertDp("tablet measure", 768, rule.node("calendar.month.body").bounds.width)
    }
}