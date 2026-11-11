package com.slopus.happy.ui.connection

import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** Desktop's drift on a phone and on a tablet: never on the slides, the button or another scene, and at most two a side on a phone. */
class CloudDriftTest {
    /** The Fold's cover screen, 411 × 891 with 24 and 48 of bars: the slides in the middle, the button at the foot. */
    private val phoneClear = listOf(Rect(0f, 300f, 411f, 600f), Rect(65f, 760f, 346f, 810f))

    /** Its inner screen, 750 × 830: a 440 column. */
    private val tabletClear = listOf(Rect(155f, 260f, 595f, 560f), Rect(235f, 700f, 515f, 750f))

    private fun check(placed: List<DriftPlacement>, clear: List<Rect>, top: Float, bottom: Float) {
        for ((index, one) in placed.withIndex()) {
            val room = one.room(CloudDriftSpec.CLEARANCE)
            assertTrue("clear of the slides and the button: $one", clear.none { it.overlaps(room) })
            assertTrue("under the bar, over the bottom inset: $one", room.top >= top + CloudDriftSpec.TOP_ROW && room.bottom <= bottom)
            for (other in placed.drop(index + 1)) assertTrue("apart: $one, $other", !other.room(0f).overlaps(room))
        }
    }

    @Test
    fun onAPhoneAtMostTwoASideAgainstTheEdge() {
        repeat(200) { seed ->
            val placed = placeDrift(411f, 891f, 24f, 843f, phoneClear, Random(seed))
            check(placed, phoneClear, 24f, 843f)
            assertTrue(placed.count { it.x < 205 } <= 2 && placed.count { it.x >= 205 } <= 2)
            for (one in placed) {
                assertTrue("40–56: $one", one.size in 40f..56f)
                val off = if (one.x < 205) -one.x else one.x + one.size - 411f
                assertTrue("at most 35% off screen: $one", off >= -0.01f && off <= one.size * 0.35f + 0.01f)
            }
            assertTrue("some show", placed.isNotEmpty())
        }
    }

    @Test
    fun onATabletDesktopsSizes() {
        repeat(200) { seed ->
            val placed = placeDrift(750f, 830f, 24f, 782f, tabletClear, Random(seed))
            check(placed, tabletClear, 24f, 782f)
            for (one in placed) assertTrue("64–104: $one", one.size in 64f..104f)
        }
    }

    @Test
    fun noRoomNoScenes() {
        val everything = listOf(Rect(-100f, 0f, 600f, 900f))
        assertTrue(placeDrift(411f, 891f, 24f, 843f, everything, Random(1)).isEmpty())
    }
}
