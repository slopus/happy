package com.slopus.happy.ui.layout

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * How wide content may grow answers to the window, not the device class.
 * The old rule asked whether the diagonal reached 9 inches, so a 900x731dp
 * window — wide enough for the tablet shell — was called a phone and ran
 * edge to edge; only a 1280x800 one was held in.
 */
class ContentWidthTest {
    @Test
    fun aWindowNarrowerThanTheCapKeepsItsOwnWidth() {
        // A phone upright and on its side, and the breakpoint itself: nothing is padded in.
        assertEquals(411.dp, ContentWidth.maxWidth(411.dp))
        assertEquals(731.dp, ContentWidth.maxWidth(731.dp))
        assertEquals(768.dp, ContentWidth.maxWidth(768.dp))
        assertEquals(800.dp, ContentWidth.maxWidth(800.dp))
    }

    @Test
    fun aWiderWindowIsHeldToTheCap() {
        // 900 is the case the device-class rule missed: tablet shell, phone diagonal.
        assertEquals(ContentWidth.tablet, ContentWidth.maxWidth(900.dp))
        assertEquals(ContentWidth.tablet, ContentWidth.maxWidth(1280.dp))
        assertEquals(ContentWidth.tablet, ContentWidth.maxWidth(2400.dp))
    }

    @Test
    fun theWindowLayoutCarriesTheSameAnswer() {
        val phone = WindowLayout.of(411.dp, 731.dp)
        assertEquals(411.dp, phone.contentMaxWidth)
        assertEquals(411.dp, phone.headerMaxWidth)
        assertEquals(false, phone.isTablet)

        // Wide enough for the shell, and now held in as well.
        val wide = WindowLayout.of(900.dp, 731.dp)
        assertEquals(true, wide.isTablet)
        assertEquals(ContentWidth.tablet, wide.contentMaxWidth)

        val tablet = WindowLayout.of(1280.dp, 800.dp)
        assertEquals(true, tablet.isTablet)
        assertEquals(ContentWidth.tablet, tablet.contentMaxWidth)

        // A phone on its side is still its own width, not padded to a column.
        val landscape = WindowLayout.of(731.dp, 411.dp)
        assertEquals(731.dp, landscape.contentMaxWidth)
        assertEquals(true, landscape.isLandscape)
    }
}
