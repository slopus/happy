package com.slopus.happy.ui.calendar

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.waitUntilAtLeastOneExists
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.calendar.CalendarFeed
import com.slopus.happy.calendar.CalendarPage
import com.slopus.happy.calendar.CalendarWindow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
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
@OptIn(ExperimentalTestApi::class)
class CalendarScreenTest {
    @get:Rule val rule = createComposeRule()
    @Test fun periodControlsChangeTheReadWindowAndWeekIsASevenDayRange() {
        val zone = ZoneId.of("UTC")
        val today = LocalDate.now(zone)
        var range: CalendarWindow? = null
        rule.setHappyContent {
            CalendarScreen(CalendarFeed.State(page = CalendarPage(emptyList(), false, "0"), status = CalendarFeed.Status.Ready), "Work calendar", zone,
                onRange = { range = it }, onBack = {}, onEvent = {})
        }
        rule.waitUntilAtLeastOneExists(hasTestTag("calendar.month.body"), 5_000)
        assertTrue(rule.node("calendar.controls").bounds.top >= rule.node("place.bar").bounds.bottom)
        assertDp("controls keyline", 16, rule.node("calendar.controls.body").bounds.left)
        assertEquals(CalendarWindow.month(YearMonth.from(today)), range)
        rule.node("calendar.next").performClick()
        rule.waitForIdle()
        assertEquals(CalendarWindow.month(YearMonth.from(today).plusMonths(1)), range)
        rule.node("calendar.today").performClick()
        rule.node("calendar.view").performClick()
        rule.node("calendar.view.week").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag("calendar.week.grid"), 5_000)
        assertEquals(CalendarWindow.week(today), range)
    }
}