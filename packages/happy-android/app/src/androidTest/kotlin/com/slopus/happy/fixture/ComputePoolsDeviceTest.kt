package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.ComputeNode
import com.slopus.happy.agent.ComputeHost
import com.slopus.happy.agent.ComputePlacement
import com.slopus.happy.agent.ComputePool
import com.slopus.happy.agent.ComputePoolsSource
import com.slopus.happy.agent.ComputeSnapshot
import com.slopus.happy.agent.SandboxCapacity
import com.slopus.happy.ui.connection.ComputePoolsScreen
import com.slopus.happy.ui.connection.ComputePoolsTags
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Emulator-only UI fixture. No network, real node, command, token or lifecycle mutation. */
@RunWith(AndroidJUnit4::class)
class ComputePoolsDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun hostFactsAndCollapsedRevokedNodesAreReadOnly() {
        val pool = ComputePool("pool", "Team pool", mapOf("online" to 1, "offline" to 1, "revoked" to 2), SandboxCapacity(3, 8))
        val online = ComputeNode("online", "pool", "Linux worker", "online", System.currentTimeMillis(), "0.1.0-linux.9", SandboxCapacity(3, 8), listOf(
            ComputePlacement("sandbox", "agent-example", "Investigate checkout"),
        ), host = ComputeHost(4, 8_326_934_528, 165_295_407_104))
        val offline = online.copy(id = "offline", name = "Backup worker", status = "offline", lastSeenAt = System.currentTimeMillis() - 3_600_000, capacity = SandboxCapacity(0, null), agents = emptyList(), host = null)
        val revoked = listOf(offline.copy(id = "old1", name = "Old worker 1", status = "revoked"), offline.copy(id = "old2", name = "Old worker 2", status = "revoked"))
        var adds = 0
        var drains = 0
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme {
                ComputePoolsScreen(ComputePoolsSource.State.Loaded(ComputeSnapshot(listOf(pool), listOf(online, offline) + revoked)), false, {}, { adds++ }, { drains++ }, {})
            }
        }
        rule.onNodeWithText("2 revoked").assertIsDisplayed()
        rule.onAllNodesWithTag(ComputePoolsTags.node("old1")).assertCountEquals(0)
        rule.waitForIdle()
        android.os.SystemClock.sleep(600) // Let the tap ripple leave the screenshot.
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "compute-pools").apply { mkdirs() }
        UiDevice.getInstance(instrumentation).takeScreenshot(File(directory, "pools-collapsed-fixture.png"))
        rule.onNodeWithTag(ComputePoolsTags.node("online")).performClick()
        rule.onNodeWithText("Logical CPUs").assertIsDisplayed()
        rule.onNodeWithText("Total RAM").assertIsDisplayed()
        rule.onNodeWithText("Workspace volume size").assertIsDisplayed()
        rule.waitForIdle()
        android.os.SystemClock.sleep(600)
        UiDevice.getInstance(instrumentation).takeScreenshot(File(directory, "pools-host-fixture.png"))
        assertEquals(0, adds + drains)
        rule.onNodeWithTag(ComputePoolsTags.node("online")).performClick()
        rule.onNodeWithTag(ComputePoolsTags.revoked("pool")).performScrollTo().performClick()
        rule.onNodeWithTag(ComputePoolsTags.node("old1")).performScrollTo().assertIsDisplayed()
        assertEquals(0, adds + drains)
    }
}