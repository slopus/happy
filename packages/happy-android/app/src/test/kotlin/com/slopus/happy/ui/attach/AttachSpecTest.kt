package com.slopus.happy.ui.attach

import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.ui.assertDp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Telegram's numbers (research/attachment-menu.md), as the port draws and moves with them. */
class AttachSpecTest {
    private val delta = 0.0001f

    @Test fun `the sheet is Telegram's`() {
        assertEquals(0.2f, AttachSpec.SCRIM_ALPHA, 0.001f)
        assertDp("corner", 24, AttachSpec.corner)
        assertDp("grabber", 36, AttachSpec.grabberWidth)
        assertDp("grabber", 4, AttachSpec.grabberHeight)
        assertDp("sheet over the first row", 24, AttachSpec.sheetOverRow)
        assertDp("selection header", 26, AttachSpec.header)
        assertEquals(0.4f, AttachSpec.RESTING, delta)
        assertEquals(1 / 3.5f, AttachSpec.RESTING_LANDSCAPE, delta)
        assertEquals(0.8f, AttachSpec.DISMISS_CM, delta)
        assertDp("close extra", 10, AttachSpec.closeExtra)
    }

    @Test fun `the grid is three columns 2 apart, four from 600`() {
        assertEquals(3, AttachSpec.columns(411.dp))
        assertEquals(3, AttachSpec.columns(599.dp))
        assertEquals(4, AttachSpec.columns(640.dp))
        // (411 - 2 x 2 - 2 x 2) / 3, Telegram's itemSize on a phone.
        assertDp("phone cell", 403f / 3, AttachSpec.cell(411.dp, 3))
        assertDp("fold cell", (640f - 4 - 6) / 4, AttachSpec.cell(640.dp, 4))
        assertEquals(0.787f, AttachSpec.PICKED_SCALE, delta)
    }

    private fun assertDp(message: String, expected: Float, actual: androidx.compose.ui.unit.Dp) = assertDp(message, expected.dp, actual)

    @Test fun `the check is CheckBox2 at 24, its number by length`() {
        assertDp("check", 24, AttachSpec.check)
        assertDp("box", 26, AttachSpec.checkBox)
        assertDp("inset", 5, AttachSpec.checkInset)
        // Telegram's 42 corner, grown to Android's 48 target.
        assertDp("touch", 48, AttachSpec.checkTouch)
        assertEquals(14.sp, AttachSpec.checkText(9))
        assertEquals(14.sp, AttachSpec.checkText(20))
        assertEquals(10.sp, AttachSpec.checkText(100))
        assertEquals(8.sp, AttachSpec.checkText(1000))
        assertDp("baseline", 18, AttachSpec.checkBaseline(1))
        assertDp("baseline", 16.5f, AttachSpec.checkBaseline(123))
    }

    @Test fun `the bars`() {
        assertDp("tab bar", 70, AttachSpec.tabBar)
        assertDp("pill inset", 7, AttachSpec.tabBarInset)
        assertDp("pill corner", 28, AttachSpec.tabBarCorner)
        assertDp("tab padding", 11, AttachSpec.tabPadding)
        assertDp("two tabs", 196, AttachSpec.tabBarWidth(2, 411.dp))
        assertDp("narrow window", 150, AttachSpec.tabBarWidth(2, 150.dp))
        assertEquals(0.09f, AttachSpec.TAB_SELECTED_ALPHA, delta)
        assertEquals(0.6f, AttachSpec.TAB_SELECTED_FROM, delta)
        assertEquals(5, AttachSpec.CAPTION_LINES)
        assertDp("confirm", 52, AttachSpec.confirmMinWidth)
        assertDp("confirm", 38, AttachSpec.confirmHeight)
        assertDp("caption shift", 36, AttachSpec.captionShift)
        assertDp("file row", 64, AttachSpec.fileRow)
        assertDp("file icon", 42, AttachSpec.fileIcon)
        assertDp("file text", 72, AttachSpec.fileText)
        assertDp("switch", 78, AttachSpec.switchShift)
    }

    @Test fun `the curves are Telegram's interpolators`() {
        // EASE_OUT (0, 0, .58, 1) is past half at a third of the way.
        assertTrue(AttachMotion.easeOut.transform(0.33f) > 0.45f)
        assertEquals(0f, AttachMotion.decelerate.transform(0f), delta)
        assertEquals(0.75f, AttachMotion.decelerate.transform(0.5f), delta)
        assertEquals(0.5f, AttachMotion.accelerateDecelerate.transform(0.5f), 0.001f)
        // OvershootInterpolator ends at 1 and passes it on the way.
        val overshoot = AttachMotion.overshoot(2f)
        assertEquals(1f, overshoot.transform(1f), delta)
        assertTrue((1..99).any { overshoot.transform(it / 100f) > 1.05f })
        assertEquals(1f, AttachMotion.scrim.transform(1f), delta)
    }

    @Test fun `the sheet springs up and goes in 250`() {
        assertEquals(0.75f, AttachMotion.OPEN_DAMPING, delta)
        assertEquals(350f, AttachMotion.OPEN_STIFFNESS, delta)
        assertEquals(250, AttachMotion.CLOSE_MS)
        assertEquals(400, AttachMotion.SCRIM_MS)
        assertEquals(20, AttachMotion.SCRIM_DELAY_MS)
        assertEquals(180, AttachMotion.CAPTION_MS)
        assertEquals(180, AttachMotion.COUNTER_MS)
        assertEquals(0.9f, AttachMotion.COUNTER_FROM, delta)
        assertEquals(200, AttachMotion.CHECK_MS)
        assertEquals(320, AttachMotion.TAB_SELECT_MS)
        assertEquals(180, AttachMotion.SWITCH_MS)
        assertEquals(500f, AttachMotion.SWITCH_STIFFNESS, delta)
    }

    @Test fun `tabs pop in from the open's clock, the last first`() {
        // Tab a starts at 32 x (3 - a): the first at 96 ms, the second at 64.
        assertEquals(0f, AttachMotion.tabScale(0, 96f), delta)
        assertTrue(AttachMotion.tabScale(1, 96f) > 0f)
        // Up to 1.1 over 200 ms, back to 1 over 100.
        assertEquals(1.1f, AttachMotion.tabScale(0, 296f), delta)
        assertEquals(1f, AttachMotion.tabScale(0, 396f), delta)
        assertEquals(1f, AttachMotion.tabScale(0, 1000f), delta)
        assertEquals(0f, AttachMotion.tabAlpha(0, 50f), delta)
        assertEquals(0.5f, AttachMotion.tabAlpha(0, 196f), 0.001f)
        assertEquals(1f, AttachMotion.tabAlpha(0, 296f), delta)
    }

    @Test fun `let go short, it comes back in 250 for a full pull and less for less`() {
        assertEquals(250, AttachMotion.springBackMs(50f, 50f))
        assertEquals(125, AttachMotion.springBackMs(25f, 50f))
        assertEquals(250, AttachMotion.springBackMs(80f, 50f))
        assertEquals(0, AttachMotion.springBackMs(0f, 50f))
    }

    @Test fun `files are coloured by their extension as Telegram colours them`() {
        assertEquals(FileTint.Blue, fileTint("notes.txt"))
        assertEquals(FileTint.Blue, fileTint("Report.DOCX"))
        assertEquals(FileTint.Green, fileTint("sheet.csv"))
        assertEquals(FileTint.Red, fileTint("deck.pdf"))
        assertEquals(FileTint.Yellow, fileTint("clip.mov"))
        assertEquals(FileTint.Yellow, fileTint("bundle.zip"))
        assertEquals(FileTint.Blue, fileTint("Makefile"))
        assertEquals(FileTint.entries['k'.code % 4], fileTint("app.kt"))
        assertEquals("pdf", fileExtension("a.b.PDF"))
        assertEquals("", fileExtension("README"))
    }
}
