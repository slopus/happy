package com.slopus.happy.ui.calendar

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.calendar.CalendarDraft
import com.slopus.happy.calendar.CalendarFrequency
import com.slopus.happy.calendar.CalendarRecurrence
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
import java.time.ZoneId

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CalendarEventFormTest {
    @get:Rule val rule = createComposeRule()
    private fun draft() = CalendarDraft.new(LocalDate.of(2026, 11, 4), ZoneId.of("UTC"))

    @Test fun nativeFieldsKeepInsetAndInvalidZonePreventsSaving() {
        var saved = false
        rule.setHappyContent {
            var draft by remember { mutableStateOf(draft()) }
            CalendarEventForm(draft, { draft = it }, false, false, false, { saved = true }, {}, {}, false)
        }
        assertDp("native field inset", 24, rule.node("calendar.editor.title").bounds.left)
        assertDp("native field width", 363, rule.node("calendar.editor.title").bounds.width)
        rule.node("calendar.editor.zone").performScrollTo().performTextReplacement("+02:00")
        rule.node("calendar.editor.save").performScrollTo().assertIsNotEnabled()
        rule.node("calendar.editor.invalid").assertExists()
        rule.node("calendar.editor.zone").performScrollTo().performTextReplacement("Europe/Berlin")
        rule.node("calendar.editor.save").performScrollTo().assertIsEnabled().performClick()
        assertTrue(saved)
    }

    @Test fun largeTextWrapsWeekdaysAndActionButtonsWithinTheSheet() {
        rule.setHappyContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                var draft by remember { mutableStateOf(draft().copy(recurrence = CalendarRecurrence(CalendarFrequency.Weekly))) }
                CalendarEventForm(draft, { draft = it }, true, false, false, {}, {}, {}, true)
            }
        }
        rule.node("calendar.editor.weekday.1").performScrollTo()
        val first = rule.node("calendar.editor.weekday.1").bounds
        val last = rule.node("calendar.editor.weekday.7").bounds
        assertTrue(last.top > first.top)
        assertTrue(last.right.value <= 387f)
        rule.node("calendar.editor.save").performScrollTo().assertIsEnabled()
        assertTrue(rule.node("calendar.editor.save").bounds.right.value <= 387f)
    }

    @Test @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun busyFormDisablesMutationsAndCancellation() {
        rule.setHappyContent { CalendarEventForm(draft(), {}, true, true, false, {}, {}, {}, false) }
        rule.node("calendar.editor.title").assertIsNotEnabled()
        rule.node("calendar.editor.save").performScrollTo().assertIsNotEnabled()
        rule.node("calendar.editor.delete").assertIsNotEnabled()
        rule.node("calendar.editor.cancel").assertIsNotEnabled()
        assertEquals(24f, rule.node("calendar.editor.title").bounds.left.value)
    }
}