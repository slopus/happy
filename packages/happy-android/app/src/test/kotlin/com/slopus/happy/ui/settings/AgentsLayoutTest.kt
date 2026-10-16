package com.slopus.happy.ui.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.MachineChoice
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.settings.AgentDefaultOverride
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentKey
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.components.PromptTags
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlinx.serialization.json.put

/**
 * happy-app settings/agents.tsx. Machines: one row per computer, online
 * first then most recently active, "platform • online|offline" under the
 * name; tapping opens the online daemon. No machines: a "No connected
 * machines" row. Defaults: Clear Overrides, disabled with no overrides.
 * One group per configurable agent (Claude Code, Codex, Antigravity; never
 * the retired Gemini or OpenClaw) with Permission, Model and Effort rows
 * whose detail is the override or "Default (code default)" for the first
 * listed machine's CLI. A field expands into "Use code default" and its
 * options, the chosen one checked; Codex models end with "Custom model…".
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentsLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun choices(vararg machines: com.slopus.happy.model.Machine): List<MachineChoice> =
        sortAgentMachines(collectMachineChoices(machines.toList()))

    @Test
    fun machinesSortOnlineFirstAndDescribeTheirCli() {
        val sorted = choices(
            machine("old", machineMetadata("old.local") { put("happyCliVersion", "1.0.0") }, active = false, activeAt = 30),
            machine("new", machineMetadata("new.local") { put("happyCliVersion", "1.2.6") }, active = true, activeAt = 10),
            machine("idle", machineMetadata("idle.local"), active = false, activeAt = 20),
        )
        assertEquals(listOf("new", "old", "idle"), sorted.map { it.id })
        assertEquals("1.2.6", agentDefaultsCliVersion(sorted))
        assertEquals(null, agentDefaultsCliVersion(emptyList()))
    }

    @Test
    fun noMachinesAndNothingToClear() {
        rule.setHappyContent { AgentsScreen(emptyList(), AgentDefaultOverrides(), {}, {}, {}) }
        rule.onNodeWithText("No connected machines").assertIsDisplayed()
        rule.onNodeWithText("Run Happy on a computer to connect it").assertIsDisplayed()
        rule.onNodeWithText("Clear Overrides").assertIsNotEnabled()
        rule.onNodeWithText("CLAUDE CODE").assertIsDisplayed()
        rule.onNodeWithText("CODEX").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("ANTIGRAVITY").performScrollTo().assertIsDisplayed()
        rule.onAllNodesWithText("GEMINI").assertCountEquals(0)
        rule.onAllNodesWithText("OPENCLAW").assertCountEquals(0)
        // No CLI version known: auto stays, Claude keeps the model before Opus 5.5.
        rule.onAllNodesWithText("Default (Auto)").assertCountEquals(2)
        rule.onNodeWithText("Default (Opus 5)").assertIsDisplayed()
        rule.onNodeWithText("Default (GPT-6.1 Sol)").assertIsDisplayed()
    }

    @Test
    fun machineRowsOpenTheOnlineDaemon() {
        val machines = choices(
            machine("offline", machineMetadata("offline.local") { put("displayName", "Desk") }, active = false, activeAt = 50),
            machine("online", machineMetadata("online.local") { put("displayName", "Laptop"); put("happyCliVersion", "1.0.0") }),
        )
        var opened: String? = null
        rule.setHappyContent { AgentsScreen(machines, AgentDefaultOverrides(), {}, { opened = it.id }, {}) }
        rule.onNodeWithText("darwin • online").assertIsDisplayed()
        rule.onNodeWithText("darwin • offline").assertIsDisplayed()
        val rows = rule.onAllNodesWithTag(ItemTags.ROW, useUnmergedTree = true)
        val laptop = rows[0].bounds
        val desk = rows[1].bounds
        assertTrue("online computer first", laptop.top < desk.top)
        assertDp("machine row: icon, title and subtitle", 76, laptop.bottom - laptop.top)
        rule.onNodeWithText("Laptop").performClick()
        assertEquals("online", opened)
        rule.onNodeWithText("Desk").performClick()
        assertEquals("offline", opened)
        // An old CLI: auto is not offered as the code default.
        rule.onAllNodesWithText("Default (Default)")[0].assertIsDisplayed()
    }

    @Test
    fun permissionExpandsAndOverrides() {
        var overrides by mutableStateOf(AgentDefaultOverrides())
        rule.setHappyContent { AgentsScreen(emptyList(), overrides, { overrides = it }, {}, {}) }
        val field = rule.onAllNodesWithText("Permission")[0]
        assertDp("field row: icon and title", 64, rule.onAllNodesWithTag(ItemTags.ROW, useUnmergedTree = true)[2].bounds.let { it.bottom - it.top })
        field.performClick()
        rule.onNodeWithText("Use code default").assertIsDisplayed()
        rule.onNodeWithText("plan first").assertIsDisplayed()
        rule.onAllNodesWithTag(AgentsTags.CHECK, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Plan").performClick()
        assertEquals("plan", overrides.agents[AgentKey.Claude]?.permissionMode)
        rule.onNodeWithText("Clear Overrides").assertIsEnabled()
        rule.onAllNodesWithTag(AgentsTags.CHECK, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Use code default").performClick()
        assertEquals(AgentDefaultOverrides(), overrides)
        // Tapping the field again collapses it.
        rule.onAllNodesWithText("Permission")[0].performClick()
        rule.onAllNodesWithText("Use code default").assertCountEquals(0)
    }

    @Test
    fun overridesShowAndClear() {
        var overrides by mutableStateOf(AgentDefaultOverrides(mapOf(AgentKey.Claude to AgentDefaultOverride(modelMode = "claude-haiku-5-5"))))
        rule.setHappyContent { AgentsScreen(emptyList(), overrides, { overrides = it }, {}, {}) }
        rule.onNodeWithText("Haiku 5.5").assertIsDisplayed()
        rule.onNodeWithText("Clear Overrides").performClick()
        assertEquals(AgentDefaultOverrides(), overrides)
        rule.onNodeWithText("Default (Opus 5)").assertIsDisplayed()
    }

    @Test
    fun codexTakesACustomModel() {
        var overrides by mutableStateOf(AgentDefaultOverrides())
        rule.setHappyContent { AgentsScreen(emptyList(), overrides, { overrides = it }, {}, {}) }
        rule.onAllNodesWithText("Model")[1].performScrollTo().performClick()
        rule.onNodeWithText("Custom model…").performScrollTo().performClick()
        rule.onNodeWithText("Custom Codex model").assertIsDisplayed()
        rule.onNodeWithTag(PromptTags.INPUT).performTextInput("  my-model ")
        rule.onNodeWithTag(PromptTags.CONFIRM).performClick()
        assertEquals("my-model", overrides.agents[AgentKey.Codex]?.modelMode)
        // The custom model is its own row and checked; its effort falls back to the gpt-5 set.
        rule.onNodeWithText("custom model").performScrollTo().assertIsDisplayed()
        rule.onAllNodesWithText("my-model")[0].assertIsDisplayed()
        rule.onAllNodesWithText("Default (Medium)")[1].performScrollTo().performClick()
        rule.onAllNodesWithText("xHigh").assertCountEquals(1)
        rule.onAllNodesWithText("Ultra").assertCountEquals(0)
    }
}
