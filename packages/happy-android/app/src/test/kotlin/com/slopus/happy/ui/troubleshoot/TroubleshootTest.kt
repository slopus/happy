package com.slopus.happy.ui.troubleshoot

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** troubleshoot.tsx and offlineMachineTroubleshooting.ts (with its vitest cases). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TroubleshootTest {
    @get:Rule
    val rule = createComposeRule()

    private fun computer(id: String, name: String, activeAt: Long, happyHomeDir: String? = null) =
        TroubleshootComputer(id = id, name = name, online = false, activeAt = activeAt, happyHomeDir = happyHomeDir)

    @Test
    fun pointsTheAiAtTheHappyFolderAndNamesTheMachineAndProject() {
        val guide = buildOfflineMachineTroubleshooting(
            listOf(computer("mac", "Kirill’s Mac", 10, "/Users/kirill/.happy")),
            listOf(TroubleshootSession(updatedAt = 20, machineId = "mac", projectName = "Happy", path = "/Users/kirill/Developer/happy")),
        )
        assertEquals("In /Users/kirill/.happy, diagnose why Happy cannot reach \"Kirill’s Mac\" for project \"Happy\".", guide.aiPrompt)
        assertTrue(guide.message.contains("1. Wake the machine and check internet."))
        assertTrue(guide.message.endsWith(guide.aiPrompt))
    }

    @Test
    fun usesTheNewestKnownProjectToChooseTheMachine() {
        val guide = buildOfflineMachineTroubleshooting(
            listOf(computer("desktop", "Desktop", 100, "/desktop/.happy"), computer("laptop", "Laptop", 50, "/laptop/.happy")),
            listOf(
                TroubleshootSession(updatedAt = 20, machineId = "desktop", path = "/work/older"),
                TroubleshootSession(updatedAt = 30, machineId = "laptop", path = "C:\\work\\current-project"),
            ),
        )
        assertEquals("Laptop", guide.machineName)
        assertEquals("current-project", guide.projectName)
        assertEquals("/laptop/.happy", guide.happyHomeDir)
    }

    @Test
    fun stillUsefulBeforeAnySessionExists() {
        val guide = buildOfflineMachineTroubleshooting(listOf(computer("mac", "Mac", 10)), emptyList())
        assertEquals("Happy", guide.projectName)
        assertEquals("~/.happy", guide.happyHomeDir)
        assertEquals("Mac", guide.machineName)
        assertEquals("this machine", buildOfflineMachineTroubleshooting(emptyList(), emptyList()).machineName)
    }

    @Test
    fun screenSpec() {
        val opened = mutableListOf<String>()
        rule.setHappyContent {
            TroubleshootScreen(
                computers = listOf(computer("mac", "Mac", 1), TroubleshootComputer("pc", "PC", online = true, activeAt = 2)),
                aiPrompt = "In ~/.happy, diagnose",
                onOpenMachine = { opened += it },
                onOpenUrl = {},
                onBack = {},
            )
        }
        val heading = rule.node(TroubleshootTags.HEADING).bounds
        assertBox("heading", heading, 24.dp, (64 + 20).dp, (PHONE_WIDTH - 48).dp, heading.bottom - heading.top)
        val intro = rule.node(TroubleshootTags.INTRO).bounds
        assertDp("intro 8 below", heading.bottom + 8.dp, intro.top)

        val steps = rule.onAllNodesWithTag(TroubleshootTags.STEP, useUnmergedTree = true)
        val icons = rule.onAllNodesWithTag(TroubleshootTags.STEP_ICON, useUnmergedTree = true)
        val first = steps[0].bounds
        assertDp("steps 24 below the intro", intro.bottom + 24.dp, first.top)
        assertBox("step icon", icons[0].bounds, 24.dp, first.top, 26.dp, 22.dp)
        assertDp("20 between steps", first.bottom + 20.dp, steps[1].bounds.top)
        val terminal = rule.node(TroubleshootTags.TERMINAL).bounds
        assertDp("terminal block beside the icon", 24 + 26 + 12, terminal.left)

        rule.onNodeWithText("MACHINES").assertExists()
        rule.onNodeWithText("Offline").assertExists()
        rule.onNodeWithText("PC").performClick()
        assertEquals(listOf("pc"), opened)

        val card = rule.node(ItemGroupTags.CARD).bounds
        val copy = rule.node(TroubleshootTags.COPY).bounds
        assertBox("copy button", copy, ((PHONE_WIDTH - 260) / 2f).dp, card.bottom + 20.dp, 260.dp, 44.dp)
        assertDp("hint 8 below", copy.bottom + 8.dp, rule.node(TroubleshootTags.HINT).bounds.top)

        rule.onNodeWithText("Copy AI prompt").performClick()
        rule.onNodeWithText("Copied").assertExists()
        val clipboard = ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java)
        assertEquals("In ~/.happy, diagnose", clipboard.primaryClip!!.getItemAt(0).text)
    }

    @Test
    fun noMachinesNoGroup() {
        rule.setHappyContent {
            TroubleshootScreen(computers = emptyList(), aiPrompt = "x", onOpenMachine = {}, onOpenUrl = {}, onBack = {})
        }
        rule.node(ItemGroupTags.CARD).assertDoesNotExist()
    }
}
