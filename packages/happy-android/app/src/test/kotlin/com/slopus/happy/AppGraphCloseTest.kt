package com.slopus.happy

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppGraphCloseTest {
    @Test
    fun anEndedApplicationLeavesNothingOfItsGraphRunning() {
        // Robolectric ends each test's application; a graph still running then kept it to the end of the suite.
        val app = ApplicationProvider.getApplicationContext<HappyApplication>()
        val graph = app.graph
        app.onTerminate()
        assertTrue(graph.open("an-account").isCancelled)
    }
}
