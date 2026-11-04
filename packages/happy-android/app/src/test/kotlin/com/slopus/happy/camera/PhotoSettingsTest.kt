package com.slopus.happy.camera

import android.util.Range
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhotoSettingsTest {
    @Test fun fixedAndNarrowZoomRangesNeverOfferAnUnsupportedZoom() {
        assertEquals(listOf(1f), PhotoZoom(1f, 1f).stops)
        val fractional = PhotoZoom(0.5f, 1.8f)
        assertEquals(listOf(0.5f, 1f), fractional.stops)
        assertEquals(1.8f, fractional.clamp(99f))
        assertEquals(0.5f, fractional.clamp(-1f))
        assertEquals(1, fractional.selected(1.4f))
        assertEquals("1.4×", PhotoZoom.label(1.4f, true))
    }

    @Test fun exposureHonoursBothTwoStopsAndTheHardwareStepAndBounds() {
        assertEquals(3, exposureIndex(1f, 1f / 3, Range(-3, 3)))
        assertEquals(-6, exposureIndex(-1f, 1f / 3, Range(-12, 12)))
        assertEquals(0, exposureIndex(Float.NaN, 1f / 3, Range(-12, 12)))
        assertEquals(0, exposureIndex(1f, 0f, Range(0, 0)))
    }

    @Test fun missingExposureMetadataDoesNotInventADarkScene() {
        assertNull(darkPhotoScene(null, 10_000_000, 100))
        assertNull(darkPhotoScene(2f, 0, 100))
        assertNull(darkPhotoScene(Float.NaN, 10_000_000, 100))
        assertEquals(false, darkPhotoScene(2f, 1_000_000, 100))
        assertEquals(true, darkPhotoScene(2f, 100_000_000, 800))
    }

    @Test fun thermalCapsOnlyChooseActualAdvertisedRanges() {
        val ranges = listOf(Range(30, 30), Range(15, 24), Range(15, 15), Range(15, 30))
        assertEquals(Range(30, 30), photoFrameRate(ranges, 30))
        assertEquals(Range(15, 24), photoFrameRate(ranges, 24))
        assertEquals(Range(15, 15), photoFrameRate(ranges - Range(15, 24), 24))
        assertEquals(Range(30, 30), photoFrameRate(listOf(Range(30, 30)), 24))
        assertNull(photoFrameRate(emptyList(), 24))
    }
}