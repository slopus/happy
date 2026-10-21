package com.slopus.happy.ui.layout

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** utils/deviceCalculations.test.ts (the Android and platform-neutral cases), responsive.ts and layout.ts. */
class WindowLayoutTest {
    private fun close(expected: Double, actual: Float, digits: Int) =
        assertEquals(expected, actual.toDouble(), 0.5 * Math.pow(10.0, -digits.toDouble()))

    @Test
    fun androidPhoneDimensions() {
        val d = DeviceCalculations.dimensions(360f, 800f)
        close(2.25, d.widthInches, 3)
        close(5.0, d.heightInches, 3)
        close(5.483, d.diagonalInches, 3)
    }

    @Test
    fun androidTabletDimensions() {
        val d = DeviceCalculations.dimensions(800f, 1280f)
        close(5.0, d.widthInches, 4)
        close(8.0, d.heightInches, 4)
        close(9.434, d.diagonalInches, 4)
    }

    @Test
    fun customPointsPerInchAndSmallScreens() {
        val custom = DeviceCalculations.dimensions(1000f, 2000f, pointsPerInch = 96f)
        close(10.417, custom.widthInches, 3)
        close(20.833, custom.heightInches, 3)
        close(23.292, custom.diagonalInches, 2)
        val small = DeviceCalculations.dimensions(320f, 480f)
        close(2.0, small.widthInches, 4)
        close(3.0, small.heightInches, 4)
        close(3.6056, small.diagonalInches, 3)
    }

    @Test
    fun deviceTypeByDiagonal() {
        assertEquals(DeviceType.Tablet, DeviceCalculations.deviceType(10.1f))
        assertEquals(DeviceType.Phone, DeviceCalculations.deviceType(5.5f))
        assertEquals("the threshold itself is a tablet", DeviceType.Tablet, DeviceCalculations.deviceType(9.0f))
        assertEquals(DeviceType.Tablet, DeviceCalculations.deviceType(8.0f, thresholdInches = 7.5f))
        assertEquals(DeviceType.Phone, DeviceCalculations.deviceType(8.0f, thresholdInches = 8.5f))
        assertEquals("a large monitor", DeviceType.Tablet, DeviceCalculations.deviceType(15f))
    }

    @Test
    fun foldablesArePhones() {
        // Galaxy Fold unfolded, 673x884 dp: about 6.9 inches.
        val fold = DeviceCalculations.dimensions(673f, 884f)
        close(6.944, fold.diagonalInches, 2)
        assertEquals(DeviceType.Phone, DeviceCalculations.deviceType(fold.diagonalInches))
        assertEquals(DeviceType.Phone, DeviceCalculations.deviceType(7.6f))
    }

    @Test
    fun androidHeaderHeights() {
        assertEquals(64.dp, DeviceCalculations.headerHeight(DeviceType.Phone, isLandscape = false))
        assertEquals(48.dp, DeviceCalculations.headerHeight(DeviceType.Phone, isLandscape = true))
        assertEquals(64.dp, DeviceCalculations.headerHeight(DeviceType.Tablet, isLandscape = false))
        assertEquals(64.dp, DeviceCalculations.headerHeight(DeviceType.Tablet, isLandscape = true))
    }

    @Test
    fun tabletIsAWindowWidthRule() {
        assertFalse(TabletBreakpoint.isTablet(767.dp))
        assertTrue(TabletBreakpoint.isTablet(768.dp))
        // A keyboard halving the height leaves it a tablet.
        assertTrue(WindowLayout.of(1280.dp, 300.dp).isTablet)
        // A foldable's 673-wide inner screen is not; a phone on its side is.
        assertFalse(WindowLayout.of(673.dp, 841.dp).isTablet)
        assertTrue(WindowLayout.of(891.dp, 411.dp).isTablet)
    }

    @Test
    fun windowAnswers() {
        val tablet = WindowLayout.of(1280.dp, 800.dp)
        assertEquals(DeviceType.Tablet, tablet.deviceType)
        assertEquals(800.dp, tablet.contentMaxWidth)
        assertTrue(tablet.isLandscape)
        assertEquals(64.dp, tablet.headerHeight)

        // layout.ts gives a phone its longest side, so nothing is held in.
        val phone = WindowLayout.of(411.dp, 891.dp)
        assertEquals(DeviceType.Phone, phone.deviceType)
        assertEquals(891.dp, phone.contentMaxWidth)
        assertFalse(phone.isTablet)
        assertEquals(64.dp, phone.headerHeight)

        // An unfolded foldable gets the tablet shell from 768 wide but stays a phone for content width.
        val unfolded = WindowLayout.of(841.dp, 701.dp)
        assertTrue(unfolded.isTablet)
        assertEquals(DeviceType.Phone, unfolded.deviceType)
        assertEquals(841.dp, unfolded.contentMaxWidth)

        // A small phone on its side: the 48 bar.
        val sideways = WindowLayout.of(740.dp, 360.dp)
        assertFalse(sideways.isTablet)
        assertEquals(48.dp, sideways.headerHeight)
    }
}
