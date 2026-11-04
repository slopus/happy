package com.slopus.happy.ui.monitor

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.waitUntilAtLeastOneExists
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.monitor.SystemMonitorFeed
import com.slopus.happy.monitor.systemMonitorSample
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalTestApi::class)
class MonitorScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test fun searchAndSortWorkTogetherAndClearingSearchRestoresTheProcesses() {
        rule.setHappyContent { MonitorScreen(SystemMonitorFeed.State(systemMonitorSample(), SystemMonitorFeed.Status.Ready), "Build box", {}) }
        rule.waitUntilAtLeastOneExists(hasTestTag("monitor.host"), 5_000)
        assertTrue(rule.node("monitor.host").bounds.top >= rule.node("place.bar").bounds.bottom)
        rule.node("monitor.search").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag("monitor.process.1234"), 5_000)
        rule.onNodeWithContentDescription("Sort: CPU ↓").assertExists()
        rule.node("agentSearch.field").performTextReplacement("python")
        rule.node("monitor.sort").performClick()
        rule.node("monitor.sort.Memory").performClick()
        rule.onNodeWithContentDescription("Sort: Memory ↓").assertExists()
        rule.node("monitor.rows").performScrollToNode(hasTestTag("monitor.processes:empty"))
        rule.node("monitor.processes:empty").assertExists()
        rule.node("monitor.search.clear").performClick()
        rule.node("monitor.rows").performScrollToNode(hasTestTag("monitor.process.1234"))
        rule.node("monitor.process.1234").assertExists()
    }
}