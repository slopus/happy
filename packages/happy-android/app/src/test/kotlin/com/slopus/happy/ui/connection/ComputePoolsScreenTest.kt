package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.ComputeJoinCommand
import com.slopus.happy.agent.ComputeHost
import com.slopus.happy.agent.ComputeNode
import com.slopus.happy.agent.ComputePlacement
import com.slopus.happy.agent.ComputePool
import com.slopus.happy.agent.ComputePoolsSource
import com.slopus.happy.agent.ComputeSnapshot
import com.slopus.happy.agent.Permission
import com.slopus.happy.agent.SandboxCapacity
import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ComputePoolsScreenTest {
    @get:Rule val rule = createComposeRule()
    private val pool = ComputePool("p1", "Team", mapOf("online" to 1), SandboxCapacity(3, null))
    private val node = ComputeNode("n1", "p1", "Worker", "online", null, "linux.8", SandboxCapacity(3, null), listOf(ComputePlacement("s1", "a1", "Check checkout")))
    private fun loaded(node: ComputeNode = this.node) = ComputePoolsSource.State.Loaded(ComputeSnapshot(listOf(pool), listOf(node)))

    @Test
    fun onlyAnExplicitCloudPoolGrantAllowsThePage() {
        assertFalse(canManagePools(true, ServerPermissions.Unknown))
        assertFalse(canManagePools(true, ServerPermissions.Ungated))
        assertFalse(canManagePools(true, ServerPermissions(true, setOf("compute.use"))))
        assertFalse(canManagePools(false, ServerPermissions(true, setOf(Permission.POOLS_MANAGE))))
        assertTrue(canManagePools(true, ServerPermissions(true, setOf(Permission.POOLS_MANAGE))))
    }

    @Test
    fun nodesExpandToMonitoringFactsAndNoActionRunsOnComposition() {
        var adds = 0
        var drains = 0
        rule.setHappyContent { ComputePoolsScreen(loaded(), false, {}, { adds++ }, { drains++ }, {}) }
        assertEquals(0, adds + drains)
        val row = rule.node(ComputePoolsTags.node("n1"))
        // 16dp margins and the settings card's one-physical-pixel border on each side.
        assertDp("node responsive settings width", (379 - 2f / rule.density.density).dp, row.bounds.width)
        assertTrue(row.bounds.height.value >= 48)
        row.performClick()
        rule.onNodeWithText("linux.8").assertIsDisplayed()
        rule.onNodeWithText("Check checkout", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Agents").assertIsDisplayed()
        rule.onAllNodesWithText("Sandboxes: 3 · capacity unknown").assertCountEquals(2)
        rule.onAllNodesWithText("Sandboxes: 3 / 0").assertCountEquals(0)
        rule.onNodeWithTag(ComputePoolsTags.drain("n1")).performScrollTo().performClick()
        assertEquals(1, drains)
        rule.onNodeWithTag(ComputePoolsTags.add("p1")).performScrollTo().performClick()
        assertEquals(1, adds)
    }

    @Test
    fun revokedMachinesHaveNoLifecycleAction() {
        rule.setHappyContent { ComputePoolsScreen(loaded(node.copy(status = "revoked")), false, {}, {}, {}, {}) }
        rule.onAllNodesWithTag(ComputePoolsTags.node("n1")).assertCountEquals(0)
        rule.onNodeWithText("1 revoked").performClick()
        rule.onNodeWithTag(ComputePoolsTags.node("n1")).performClick()
        rule.onAllNodesWithTag(ComputePoolsTags.drain("n1")).assertCountEquals(0)
        rule.onNodeWithTag(ComputePoolsTags.revoked("p1")).performScrollTo().performClick()
        rule.onAllNodesWithTag(ComputePoolsTags.node("n1")).assertCountEquals(0)
    }

    @Test
    fun hostFactsShowReadableTotalsAndHideUnknownRows() {
        val host = ComputeHost(4, 8_326_934_528, null)
        rule.setHappyContent { ComputePoolsScreen(loaded(node.copy(host = host)), false, {}, {}, {}, {}) }
        rule.onNodeWithTag(ComputePoolsTags.node("n1")).performClick()
        rule.onNodeWithText("Logical CPUs").assertIsDisplayed()
        rule.onNodeWithText("4").assertIsDisplayed()
        rule.onNodeWithText("Total RAM").assertIsDisplayed()
        rule.onNodeWithText("GB", substring = true).assertIsDisplayed()
        rule.onAllNodesWithText("Workspace volume size").assertCountEquals(0)
    }

    @Test
    fun onlyActiveStatusesAreListedUntilRevokedToggleOpens() {
        val nodes = listOf("online", "offline", "draining", "enrolling", "revoked").map { node.copy(id = it, status = it) }
        rule.setHappyContent { ComputePoolsScreen(ComputePoolsSource.State.Loaded(ComputeSnapshot(listOf(pool), nodes)), false, {}, {}, {}, {}) }
        for (status in listOf("online", "offline", "draining")) rule.onNodeWithTag(ComputePoolsTags.node(status)).assertIsDisplayed()
        for (status in listOf("enrolling", "revoked")) rule.onAllNodesWithTag(ComputePoolsTags.node(status)).assertCountEquals(0)
        rule.onNodeWithTag(ComputePoolsTags.revoked("p1")).performScrollTo().performClick()
        rule.onNodeWithTag(ComputePoolsTags.node("revoked")).performScrollTo().assertIsDisplayed()
        rule.onAllNodesWithTag(ComputePoolsTags.node("enrolling")).assertCountEquals(0)
    }

    @Test
    fun deniedPageRevealsNeitherFactsNorActions() {
        rule.setHappyContent { ComputePoolsScreen(ComputePoolsSource.State.Forbidden, false, {}, {}, {}, {}) }
        rule.onNodeWithText("Managing compute pools requires pools.manage permission.").assertIsDisplayed()
        rule.onAllNodesWithTag(ComputePoolsTags.add("p1")).assertCountEquals(0)
        rule.onAllNodesWithText("Worker").assertCountEquals(0)
    }

    @Test
    fun aLoadFailureHasAnExplicitRetry() {
        var retries = 0
        rule.setHappyContent { ComputePoolsScreen(ComputePoolsSource.State.Failed, false, { retries++ }, {}, {}, {}) }
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun joinCommandsAreShownVerbatimInTheSettingsColumn() {
        val text = "  curl --exact 'example.invalid/install' | sh  "
        rule.setHappyContent { ComputeJoinScreen(ComputeJoinCommand(text, null, System.currentTimeMillis() + 3_600_000), {}) }
        rule.onNodeWithTag(ComputePoolsTags.COMMAND).assertTextEquals(text)
        assertTrue(rule.node(ComputePoolsTags.COMMAND).bounds.width.value <= 379)
        rule.onNodeWithText("Copy").assertIsDisplayed().performClick()
        rule.waitForIdle()
        val clipboard = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(android.content.ClipboardManager::class.java)
        assertEquals(text, clipboard.primaryClip!!.getItemAt(0).text.toString())
        assertTrue(clipboard.primaryClip!!.description.extras.getBoolean("android.content.extra.IS_SENSITIVE"))
    }

    @Test
    fun expiredCommandCannotBeReadOrCopied() {
        rule.setHappyContent { ComputeJoinScreen(ComputeJoinCommand("expired secret", null, 1), {}) }
        rule.onAllNodesWithTag(ComputePoolsTags.COMMAND).assertCountEquals(0)
        rule.onAllNodesWithText("Copy").assertCountEquals(0)
    }

    @Test
    fun anUnconfiguredInstallerDoesNotInventACommand() {
        rule.setHappyContent { ComputeJoinScreen(ComputeJoinCommand(null, null, System.currentTimeMillis() + 3_600_000), {}) }
        rule.onNodeWithText("The server has no installer configured.").assertIsDisplayed()
        rule.onAllNodesWithTag(ComputePoolsTags.COMMAND).assertCountEquals(0)
    }
}