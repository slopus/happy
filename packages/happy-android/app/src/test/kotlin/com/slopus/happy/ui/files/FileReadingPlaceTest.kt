package com.slopus.happy.ui.files

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.diff.LocalDiffSyntax
import com.slopus.happy.ui.node
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * F14, iOS bbaf6a8e1: the file viewer keeps the reader's place over a
 * text-size change. Android makes the activity again at the new size; the
 * viewer's scroll pixels would land elsewhere, so the line at the top is
 * what is kept. A line asked for is gone to once, not again over it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class FileReadingPlaceTest {
    @get:Rule val rule = createComposeRule()

    private val source = (1..400).joinToString("\n") { "line $it" }
    private var fontScale by mutableFloatStateOf(1f)

    private fun show(restoration: StateRestorationTester, line: Int? = null) {
        restoration.setContent {
            HappyTheme(preference = ThemePreference.Light) {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                    ProvideWindowLayout {
                        CompositionLocalProvider(LocalDiffSyntax provides null) {
                            FileScreen(FileLoad.Loaded(source, null), "notes.txt", onBack = {}, line = line)
                        }
                    }
                }
            }
        }
        rule.waitForIdle()
    }

    /** The source's line at the top of the viewer: its 400 lines share the text's height, none wrapping. */
    private fun topLine(): Int {
        val viewport = rule.node(FileTags.SCROLL).bounds
        val code = rule.node(FileTags.CODE).bounds
        val line = (code.bottom - code.top) / 400
        return ((viewport.top - code.top) / line).toInt() + 1
    }

    @Test fun `the line at the top stays there when the text doubles`() {
        val restoration = StateRestorationTester(rule)
        show(restoration)
        repeat(4) { rule.node(FileTags.SCROLL).performTouchInput { swipeUp() } }
        rule.waitForIdle()
        val before = topLine()
        assertTrue("scrolled well in: $before", before > 40)
        fontScale = 2f
        restoration.emulateSavedInstanceStateRestore()
        rule.waitForIdle()
        assertEquals(before.toFloat(), topLine().toFloat(), 1f)
    }

    @Test fun `a line asked for is gone to once, and the place read to after it is what is kept`() {
        val restoration = StateRestorationTester(rule)
        show(restoration, line = 120)
        val asked = topLine()
        assertTrue("near line 120: $asked", asked in 115..120)
        rule.node(FileTags.SCROLL).performTouchInput { swipeUp() }
        rule.waitForIdle()
        val read = topLine()
        assertTrue("read on past it: $read", read > asked + 5)
        fontScale = 2f
        restoration.emulateSavedInstanceStateRestore()
        rule.waitForIdle()
        assertEquals(read.toFloat(), topLine().toFloat(), 1f)
    }

    @Test fun `a line starts where the newlines before it end`() {
        assertEquals(0, offsetOfLine("a\nb\nc", 1))
        assertEquals(2, offsetOfLine("a\nb\nc", 2))
        assertEquals(4, offsetOfLine("a\nb\nc", 3))
        assertEquals(5, offsetOfLine("a\nb\nc", 9))
    }
}
