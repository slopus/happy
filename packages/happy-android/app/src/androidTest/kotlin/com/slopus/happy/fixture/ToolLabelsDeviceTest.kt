package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.ToolCallActions
import com.slopus.happy.ui.conversation.ToolCallScreen
import com.slopus.happy.ui.conversation.ToolCallScreenState
import com.slopus.happy.ui.files.MessageDetailTags
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.Json
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Synthetic Cloud call arguments through the real row projection and conversation/detail UI. No network or execution. */
@RunWith(AndroidJUnit4::class)
class ToolLabelsDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun descriptionsNameCallsAndDetailsStillShowTheCommand() {
        val calls = listOf(
            """{"type":"tool_call","id":"python","name":"python","status":"completed","arguments":{"code":"print(42)","description":"Calculate the answer"}}""",
            """{"type":"tool_call","id":"shell","name":"exec_command","status":"completed","arguments":{"cmd":"printf label-check","description":"Inspect the shell environment"},"presentation":{"type":"exec_command","command":"printf label-check","output":"label-check"}}""",
            """{"type":"tool_call","id":"patch","name":"apply_patch","status":"completed","arguments":{"description":"Update account settings"},"presentation":{"type":"file_diff","files":[{"path":"a.kt","kind":"update","added":3,"deleted":1},{"path":"b.kt","kind":"add","added":2,"deleted":0}]}}""",
            """{"type":"tool_call","id":"terminal","name":"write_stdin","status":"running","arguments":{"description":"Read test results"}}""",
            """{"type":"tool_call","id":"stop","name":"stop_shell","status":"failed","arguments":{"description":"Stop the test worker"}}""",
            """{"type":"tool_call","id":"mcp","name":"mcp__github__create_issue","status":"completed","arguments":{"description":"Semantic issue body"}}""",
        ).map { Block.parse(Json.parseToJsonElement(it)) as Block.ToolCall }
        val message = Message("fixture", "agent", 1, calls)
        val rows = ConversationRowBuilder.build(message, "agent", null, false).asReversed()
        val agent = AgentInfo("agent", "workspace", null, "Tool label fixture", "idle", null, null, 1, 2, 0, 0)
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme {
                var selected by remember { mutableStateOf<Block.ToolCall?>(null) }
                BackHandler(selected != null) { selected = null }
                val call = selected
                if (call == null) ConversationScreen(
                    ConversationState(created = true, loaded = true, rows = rows, agent = agent),
                    ConversationScreenActions(onOpenTool = { id -> selected = calls.first { it.id == id } }),
                ) else ToolCallScreen(ToolCallScreenState(call, false, false, false), ToolCallActions(onBack = { selected = null }))
            }
        }
        rule.onNodeWithText("Calculate the answer", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Inspect the shell environment", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Update account settings", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Read test results", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Stop the test worker", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("github · create_issue", useUnmergedTree = true).assertIsDisplayed()
        capture("tool-labels-fixture")
        rule.onNodeWithText("Inspect the shell environment", useUnmergedTree = true).performClick()
        rule.onNodeWithTag(MessageDetailTags.COMMAND, useUnmergedTree = true).assertIsDisplayed()
        rule.onAllNodesWithText("printf label-check", useUnmergedTree = true).assertCountEquals(2)
        capture("tool-labels-command-detail-fixture")
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "tool-labels").apply { mkdirs() }
        UiDevice.getInstance(instrumentation).takeScreenshot(File(directory, "$name.png"))
    }
}