package com.slopus.happy.ui.connect

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.tan

/** iOS's QRScannerOrientationTests' focus zoom cases, the same numbers. */
class ScanFocusTest {
    @Test
    fun aFarFocusingCameraZoomsIn() {
        val distance = 30 / (2 * 0.3 * tan(34.5 * Math.PI / 180))
        assertEquals(200 / distance, ScanFocus.zoom(200f, 69f, 0.3f).toDouble(), 1e-3)
        assertEquals(100 / distance, ScanFocus.zoom(100f, 69f, 0.3f).toDouble(), 1e-3)
    }

    @Test
    fun aCameraThatFocusesCloseStaysAtOne() {
        assertEquals(1f, ScanFocus.zoom(50f, 69f, 0.3f))
        assertEquals(1f, ScanFocus.zoom(-1f, 69f, 0.3f))
        assertEquals(1f, ScanFocus.zoom(200f, 0f, 0.3f))
        assertEquals(1f, ScanFocus.zoom(200f, 69f, 0f))
    }

    @Test
    fun zoomStopsAtThree() {
        assertEquals(ScanFocus.MAX_ZOOM, ScanFocus.zoom(400f, 69f, 0.3f))
    }

    @Test
    fun camera2sUnits() {
        // 10 diopters is 10 cm; 0 is a fixed-focus lens.
        assertEquals(100f, ScanFocus.minimumFocusMm(10f))
        assertEquals(-1f, ScanFocus.minimumFocusMm(0f))
        assertEquals(-1f, ScanFocus.minimumFocusMm(null))
        // A 6.4 mm sensor behind a 4.4 mm lens: about 72° across.
        assertEquals(72.06f, ScanFocus.fieldOfView(6.4f, 4.4f), 0.01f)
        // The phone's 260 square on its 891 long side.
        assertEquals(260f / 891f, ScanFocus.fill(260f, 411f, 891f))
        assertEquals(260f / 891f, ScanFocus.fill(260f, 891f, 411f))
    }
}
