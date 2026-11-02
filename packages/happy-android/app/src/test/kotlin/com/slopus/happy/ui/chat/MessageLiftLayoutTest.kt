package com.slopus.happy.ui.chat

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import org.junit.Assert.assertEquals
import org.junit.Test

/** iOS 8c2a92172's MessageLiftLayoutTests, at a density of 1: where a lifted message and its menu go. */
class MessageLiftLayoutTest {
    private val screen = Size(402f, 874f)
    private val menu = Size(220f, 150f)

    private fun layout(source: Rect, leading: Boolean, menu: Size = this.menu, screen: Size = this.screen, top: Float = 62f, bottom: Float = 34f) =
        MessageLiftLayout.of(screen, top, bottom, source, menu, leading) { it.value }

    private fun rect(x: Float, y: Float, w: Float, h: Float) = Rect(x, y, x + w, y + h)

    @Test fun aShortMessageStaysWhereItWasWithTheMenuUnderItsTrailingEdge() {
        val l = layout(rect(180f, 400f, 210f, 60f), leading = false)
        assertEquals(rect(180f, 400f, 210f, 60f), l.viewport)
        assertEquals(0f, l.offset)
        // 390 - 7 - 220.
        assertEquals(rect(163f, 467f, 220f, 150f), l.menu)
    }

    @Test fun aMessageNearTheFootMovesUpWithItsMenu() {
        val l = layout(rect(16f, 700f, 300f, 80f), leading = true)
        // 874 - 34 - 10 - 150 - 7 - 80.
        assertEquals(rect(16f, 593f, 300f, 80f), l.viewport)
        assertEquals(rect(18f, 680f, 220f, 150f), l.menu)
    }

    @Test fun aMessageAboveTheTopComesDownUnderIt() {
        val l = layout(rect(16f, 20f, 300f, 40f), leading = true)
        assertEquals(rect(16f, 70f, 300f, 40f), l.viewport)
        assertEquals(rect(18f, 117f, 220f, 150f), l.menu)
    }

    @Test fun aTallMessageIsCutToTheRoomAndScrollsFromWhatWasOnScreen() {
        val l = layout(rect(16f, -1500f, 370f, 3000f), leading = true)
        // 830 - 70 - 157 tall, at the top.
        assertEquals(rect(16f, 70f, 370f, 603f), l.viewport)
        // The part that was at y 70 stays there.
        assertEquals(1570f, l.offset)
        assertEquals(rect(18f, 680f, 220f, 150f), l.menu)
    }

    @Test fun aTallMessageOnAShortScreenStartsAtItsTop() {
        val l = layout(rect(16f, 100f, 343f, 1000f), leading = true, screen = Size(375f, 667f), top = 20f, bottom = 0f)
        assertEquals(rect(16f, 28f, 343f, 472f), l.viewport)
        assertEquals(0f, l.offset)
    }

    @Test fun theMenuKeepsTwelveFromTheSides() {
        assertEquals(170f, layout(rect(300f, 300f, 90f, 40f), leading = true).menu.left)
    }

    @Test fun withoutAMenuOnlyTheMessageKeepsClearOfTheFoot() {
        assertEquals(rect(16f, 790f, 300f, 40f), layout(rect(16f, 820f, 300f, 40f), leading = true, menu = Size.Zero).viewport)
    }

    @Test fun telegramsSpring() {
        // mass 5, stiffness 900, damping 104: ratio 104 / (2 √4500), stiffness 900 / 5.
        assertEquals(0.775f, MessageLiftSpec.dampingRatio, 0.001f)
        assertEquals(180f, MessageLiftSpec.stiffness)
    }
}
