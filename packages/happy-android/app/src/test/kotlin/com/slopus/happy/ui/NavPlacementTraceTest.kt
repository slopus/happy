package com.slopus.happy.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class NavPlacementTraceTest {
    @Test fun onlyAChangedRoundedIncomingPlacementReports() {
        val reports = mutableListOf<String>()
        val trace = NavPlacementTrace(reports::add)
        trace.expect("home", "settings", 1080)
        trace.placed("home", -50f) // Outgoing movement is not incoming movement.
        trace.placed("settings", 1080f)
        trace.placed("settings", 1079.8f)
        assertEquals(emptyList<String>(), reports)
        trace.placed("settings", 1079f)
        trace.expect("home", "settings", 1080) // Re-measure cannot emit again.
        trace.placed("settings", 1000f)
        assertEquals(listOf("settings"), reports)
    }

    @Test fun popAndLaterPushHaveIndependentMarkers() {
        val reports = mutableListOf<String>()
        val trace = NavPlacementTrace(reports::add)
        trace.expect("settings", "home", -281)
        trace.placed("home", -281f)
        trace.placed("home", -270f)
        trace.expect("chat", "home", -281)
        trace.placed("home", -270f)
        trace.forget("home")
        trace.expect("chat", "home", -281)
        trace.placed("home", -270f)
        assertEquals(listOf("home", "home", "home"), reports)
    }

    @Test fun rightToLeftAndAlreadyAdvancedInitialPlacementAreMeasured() {
        val reports = mutableListOf<String>()
        val trace = NavPlacementTrace(reports::add)
        trace.expect("home", "home", 0)
        trace.placed("home", 0f)
        trace.expect("home", "settings", -1080)
        trace.placed("settings", -1040f)
        assertEquals(listOf("settings"), reports)
    }
}