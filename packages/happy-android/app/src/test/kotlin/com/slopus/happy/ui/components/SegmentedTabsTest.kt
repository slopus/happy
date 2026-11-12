package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.NewWorkSegments
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The 32 dp control keeps a visible track and selected thumb on the file toolbar in both themes. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SegmentedTabsTest {
    @get:Rule val rule = createComposeRule()

    private fun check(dark: Boolean) {
        rule.setHappyContent(dark = dark) {
            var selected by remember { mutableIntStateOf(0) }
            Box(Modifier.background(if (dark) Color(0xFF161616) else Color.White)) {
                SegmentedTabs(listOf(Segment("Rendered", "rendered"), Segment("Source", "source")), selected, { selected = it }, Modifier.testTag("tabs"))
            }
        }
        val thumb = if (dark) Color(0xFF636366) else Color.White
        val track = if (dark) Color(0xFF2C2C2E) else Color(0xFFE5E5EA)
        val pixels = rule.node("tabs").captureToImage().toPixelMap()
        assertEquals(track, pixels[pixels.width / 2, 1])
        val selectedPixels = rule.node("rendered").captureToImage().toPixelMap()
        assertEquals(thumb, selectedPixels[2, selectedPixels.height / 2])
        val sourcePixels = rule.node("source").captureToImage().toPixelMap()
        assertEquals(track, sourcePixels[2, sourcePixels.height / 2])
        assertDp("32 high track", 32.dp, rule.node("tabs").bounds.height)
        assertDp("2 dp inset", 2.dp, rule.node("rendered").bounds.top)
        rule.node("rendered").assertIsSelected()
        rule.node("source").assertIsNotSelected().performClick().assertIsSelected()
        rule.node("rendered").assertIsNotSelected()
    }

    /**
     * New work's Task | Bot (and Session | Bot | Task, Home's Session | Bot,
     * the feed's tabs) raise the pick the same way: light keeps
     * surfaceHighest; dark takes iOS's grey, well clear of the track.
     */
    private fun checkNewWork(dark: Boolean) {
        val surface = if (dark) Color(0xFF161616) else Color.White
        rule.setHappyContent(dark = dark) {
            Box(Modifier.background(surface)) {
                NewWorkSegments(listOf("Task", "Bot"), selected = 0, enabled = true, tag = { "kind.$it" }, onPick = {})
            }
        }
        val picked = rule.node("kind.0").captureToImage().toPixelMap().let { it[2, it.height / 2] }
        val other = rule.node("kind.1").captureToImage().toPixelMap().let { it[2, it.height / 2] }
        assertEquals(if (dark) Color(0xFF636366) else Color(0xFFF0F0F0), picked)
        val lift = (picked.red + picked.green + picked.blue - other.red - other.green - other.blue) / 3
        if (dark) assertTrue("the pick stands out of the track: $lift", lift > 0.2f)
    }

    @Test fun lightNewWorkKind() = checkNewWork(false)
    @Test fun darkNewWorkKind() = checkNewWork(true)

    @Test fun lightToolbar() = check(false)
    @Test fun darkToolbar() = check(true)
    @Test @Config(qualifiers = "w1280dp-h800dp-xhdpi") fun tabletLightToolbar() = check(false)
    @Test @Config(qualifiers = "w1280dp-h800dp-xhdpi") fun tabletDarkToolbar() = check(true)
}