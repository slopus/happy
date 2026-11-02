package com.slopus.happy.ui.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class KindSubtitleTest {
    @Test
    fun theKindLeadsWhatElseTellsTheAccountApart() {
        assertEquals("Happy CLI · @steve", kindSubtitle("Happy CLI", "@steve"))
        assertEquals("Happy Agent · Connected", kindSubtitle("Happy Agent", "Connected"))
    }

    @Test
    fun withNothingElseTheKindStandsAlone() {
        assertEquals("Happy CLI", kindSubtitle("Happy CLI", null))
        assertEquals("Happy CLI", kindSubtitle("Happy CLI", ""))
    }
}
