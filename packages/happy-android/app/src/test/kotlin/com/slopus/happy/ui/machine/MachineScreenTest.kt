package com.slopus.happy.ui.machine

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.DaemonState
import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.sync.OpResult
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.ZoneOffset

/**
 * machine/[id].tsx: a 64 header naming the machine with the 48 pencil on
 * the right; the daemon group first (status, then Stop Daemon, which asks
 * before it stops and is off while the machine is offline); up to five
 * recent sessions, last updated first; the danger zone's delete asks, and
 * leaves once it went through. A rename sets or clears the display name.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MachineScreenTest {
    @get:Rule val rule = createComposeRule()

    private class FakeControls : MachineControls {
        val calls = mutableListOf<String>()
        var deleteResult = OpResult(true)

        override suspend fun stopDaemon(machineId: String): String? = "bye".also { calls += "stop:$machineId" }

        override suspend fun rename(machine: Machine, displayName: String?) {
            calls += "rename:${machine.id}:$displayName"
        }

        override suspend fun delete(machineId: String): OpResult = deleteResult.also { calls += "delete:$machineId" }

        override suspend fun refresh() {
            calls += "refresh"
        }
    }

    private val studio = machine(
        "m1",
        machineMetadata {
            put("displayName", "Studio")
            put("username", "dev")
            put("arch", "arm64")
            cliAvailability(claude = true, codex = false, rig = true)
        },
        active = true,
        activeAt = 1_700_000_000_000,
    ).copy(daemonState = DaemonState(buildJsonObject { put("pid", 4242); put("httpPort", JsonPrimitive(0)); put("startedWithCliVersion", "1.2.3") }))

    private var deleted = 0
    private val opened = mutableListOf<String>()
    private val actions = MachineScreenActions(onBack = {}, onOpenSession = { opened += it }, onDeleted = { deleted++ })

    private fun show(machine: Machine?, sessions: List<Session> = emptyList(), controls: MachineControls = FakeControls()) {
        rule.setHappyContent { MachineScreen(machine, sessions, controls, actions, zone = ZoneOffset.UTC) }
    }

    @Test
    fun headerAndDaemonGroup() {
        show(studio)
        val header = rule.node(HeaderTags.BAR).bounds
        assertDp("header", 64, header.bottom - header.top)
        assertBox("pencil", rule.node(MachineTags.RENAME).bounds, (PHONE_WIDTH - 16 - 48).dp, header.top + 8.dp, 48.dp, 48.dp)
        rule.onNodeWithText("Studio").assertExists()
        val status = rule.node(MachineTags.STATUS).bounds
        val stop = rule.node(MachineTags.STOP_DAEMON).bounds
        assertDp("stop right under status", status.bottom, stop.top)
        rule.onNodeWithText("online").assertExists()
        rule.onNodeWithText("4242").assertExists()
        // A zero port is falsy in happy-app and not shown.
        rule.onNodeWithText("Last Known HTTP Port").assertDoesNotExist()
        rule.onNodeWithText("Rig").performScrollTo().assertExists()
    }

    @Test
    fun stopDaemonAsksFirstAndIsOffWhileOffline() {
        val controls = FakeControls()
        show(studio, controls = controls)
        rule.node(MachineTags.STOP_DAEMON).performClick()
        rule.onNodeWithText("Stop Daemon?").assertExists()
        rule.onNode(hasText("Stop Daemon") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Daemon Stopped").assertExists()
        assertEquals(listOf("stop:m1", "refresh"), controls.calls)
    }

    @Test
    fun offlineMachineCannotStopItsDaemon() {
        val controls = FakeControls()
        show(studio.copy(active = false), controls = controls)
        rule.onNodeWithText("offline").assertExists()
        rule.node(MachineTags.STOP_DAEMON).performClick()
        rule.onNodeWithText("Stop Daemon?").assertDoesNotExist()
        assertTrue(controls.calls.isEmpty())
    }

    @Test
    fun recentSessionsOpenTheirChat() {
        val sessions = (1..7).map { i ->
            session("s$i", metadata = metadata(path = "/Users/dev/p$i") { put("machineId", "m1") }).copy(updatedAt = i.toLong())
        } + session("other", metadata = metadata { put("machineId", "m2") }) +
            // The newest of all, but a side chat: not a session here.
            session("side", metadata = metadata { put("machineId", "m1"); put("isSideChat", true) }).copy(updatedAt = 99)
        val recent = recentMachineSessions(sessions, "m1")
        assertEquals(listOf("s7", "s6", "s5", "s4", "s3"), recent.map { it.id })
        show(studio, recent)
        rule.onAllNodesWithTag(MachineTags.SESSION, useUnmergedTree = true).assertCountEquals(5)
        rule.onAllNodesWithTag(MachineTags.SESSION, useUnmergedTree = true)[0].performScrollTo().performClick()
        assertEquals(listOf("s7"), opened)
    }

    @Test
    fun renameSetsOrClearsTheDisplayName() {
        val controls = FakeControls()
        show(studio, controls = controls)
        rule.node(MachineTags.RENAME).performClick()
        rule.onNodeWithText("Rename Machine").assertExists()
        rule.onNode(hasSetTextAction()).performTextReplacement("  ")
        rule.onNode(hasText("Rename") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        assertEquals(listOf("rename:m1:null"), controls.calls)
        rule.onNodeWithText("Machine renamed successfully").assertExists()
    }

    @Test
    fun deleteAsksThenLeaves() {
        val controls = FakeControls()
        show(studio, controls = controls)
        rule.node(MachineTags.DELETE).performScrollTo().performClick()
        rule.onNodeWithText("Delete this machine?").assertExists()
        rule.onNode(hasText("Delete") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        assertEquals(listOf("delete:m1"), controls.calls)
        assertEquals(1, deleted)
    }

    @Test
    fun missingMachine() {
        show(null)
        rule.node(MachineTags.NOT_FOUND).assertExists()
        rule.onNodeWithText("Machine not found").assertExists()
    }
}
