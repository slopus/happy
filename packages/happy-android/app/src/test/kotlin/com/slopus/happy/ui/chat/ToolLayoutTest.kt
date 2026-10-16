package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.tools.PermissionChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ToolLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val gray = userMessageBubblePalette("gray", dark = false)

    private fun tool(
        name: String,
        input: String? = null,
        state: ToolState = ToolState.Completed,
        result: String? = null,
        permission: ToolPermission? = null,
    ) = ChatMessage.ToolCallMessage(
        "t", 0,
        ToolCall(
            name = name, state = state, input = input?.let(Json::parseToJsonElement), createdAt = 0,
            result = result?.let(Json::parseToJsonElement), permission = permission,
        ),
    )

    private fun show(message: ChatMessage.ToolCallMessage, env: ToolEnvironment = ToolEnvironment(path = "/repo"), callbacks: MessageCallbacks = MessageCallbacks()) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalToolEnvironment provides env) {
                Column(Modifier.fillMaxWidth()) { MessageView(ChatRow.Tool(message), gray, callbacks) }
            }
        }
    }

    // ToolView card: 8 side margins and 8 above; the header padded 12 with
    // a 24 icon box; the content 12 in and 8 below the header.
    @Test
    fun editCardWithItsDiff() {
        show(tool("Edit", """{"file_path":"/repo/src/a.kt","old_string":"val a = 1","new_string":"val a = 2"}"""))
        rule.onNodeWithText("src/a.kt").assertExists()
        val card = rule.node(ToolTags.CARD).bounds
        val header = rule.node(ToolTags.HEADER).bounds
        val icon = rule.node(ToolTags.ICON).bounds
        val content = rule.node(ToolTags.CONTENT).bounds
        assertBox("card", card, 8.dp, 8.dp, (PHONE_WIDTH - 16).dp, card.bottom - card.top)
        assertBox("icon", icon, 20.dp, header.top + 12.dp, 24.dp, 24.dp)
        assertDp("header 12 below the icon", 12, header.bottom - icon.bottom)
        // The content box is the card's width; its 12 padding is inside.
        assertDp("content spans the card", 8, content.left)
        assertDp("content right under the header", 0, content.top - header.bottom)
        // The diff section bleeds over the card's padding, flush under the header.
        val section = rule.node(ToolTags.SECTION).bounds
        assertBox("diff section", section, 8.dp, header.bottom, (PHONE_WIDTH - 16).dp, section.bottom - section.top)
        rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true).assertCountEquals(2)
        val line = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)[0].bounds
        assertDp("rows are 18 high", 18, line.bottom - line.top)
        rule.onNodeWithText("val a = 1").assertExists()
        rule.onNodeWithText("−").assertExists()
    }

    // The diff gutter: ceil(2 x char width) + 4 without line numbers; + 2 digits and 12 with them.
    @Test
    fun diffGutterWidth() {
        show(tool("Write", """{"file_path":"/repo/a.kt","content":"a\nb"}"""), ToolEnvironment(showLineNumbers = true))
        val gutter = rule.node(DiffTags.GUTTER).bounds
        // Plex Mono is 0.6 em; the measured advance rounds to whole pixels, so allow one dp.
        val expected = kotlin.math.ceil(4 * 12 * 0.6f) + 12
        val width = (gutter.right - gutter.left).value
        assertTrue("gutter $width", width >= expected - 0.5f && width <= expected + 1.5f)
        rule.onNodeWithText("2").assertExists()
    }

    @Test
    fun compactModeShrinksEditsToRows() {
        show(tool("Edit", """{"file_path":"/repo/a.kt","old_string":"a","new_string":"b"}"""), ToolEnvironment(compactToolCalls = true, path = "/repo"))
        rule.onNodeWithText("Edited: /repo/a.kt").assertExists()
        val row = rule.node(ToolTags.COMPACT).bounds
        assertBox("row", row, 8.dp, 2.dp, (PHONE_WIDTH - 16).dp, 28.dp)
        val icon = rule.node(ToolTags.ICON).bounds
        assertBox("icon", icon, 16.dp, 6.dp, 20.dp, 20.dp)
        val label = rule.node(ToolTags.LABEL).bounds
        assertDp("label 10 after the icon", 10, label.left - icon.right)
    }

    @Test
    fun hiddenToolsDrawNothing() {
        show(tool("ToolSearch", "{}"))
        rule.onAllNodesWithTag(ToolTags.COMPACT, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(ToolTags.CARD, useUnmergedTree = true).assertCountEquals(0)
    }

    // ToolError: radius 6, padding 12, 12 below, at most 115 high; a tool-use error shows its message alone.
    @Test
    fun errorBox() {
        show(tool("TodoWrite", """{"todos":[{"content":"a","status":"pending"}]}""", ToolState.Error, "\"Something broke\""))
        rule.onNodeWithText("Something broke").assertExists()
        val error = rule.node(ToolTags.ERROR).bounds
        val content = rule.node(ToolTags.CONTENT).bounds
        assertDp("error 12 in", 20, error.left)
        assertDp("12 below the error", 12, content.bottom - error.bottom)
        assertTrue(error.bottom - error.top <= 115.dp)
    }

    @Test
    fun unknownToolAwaitingApprovalShowsItsInput() {
        show(tool("frobnicate", """{"level":3}""", ToolState.Running, permission = ToolPermission("p", PermissionStatus.Pending)))
        rule.onNodeWithText("INPUT").assertExists()
        rule.onNodeWithText("{\n  \"level\": 3\n}").assertExists()
        rule.node(PermissionTags.FOOTER).assertExists()
        rule.node(PermissionTags.option(PermissionChoice.AllowForTool)).assertExists()
    }

    // TodoView: 4 apart, each 2 above and below.
    @Test
    fun todos() {
        show(tool("TodoWrite", """{"todos":[{"content":"Write tests","status":"completed"},{"content":"Ship","status":"in_progress"}]}"""))
        rule.onNodeWithText("☑ Write tests").assertExists()
        rule.onNodeWithText("☐ Ship").assertExists()
        val todos = rule.onAllNodesWithTag(ToolTags.TODO, useUnmergedTree = true)
        todos.assertCountEquals(2)
        assertDp("4 apart", 4, todos[1].bounds.top - todos[0].bounds.bottom)
    }

    @Test
    fun taskShowsItsLastThreeTools() {
        val children = (1..5).map { i ->
            ChatMessage.ToolCallMessage("c$i", 0, ToolCall(name = "Read", state = ToolState.Completed, input = Json.parseToJsonElement("""{"file_path":"/f$i"}"""), createdAt = 0))
        }
        val task = tool("Task", """{"description":"Explore"}""", ToolState.Running).copy(children = children)
        show(task)
        rule.onAllNodesWithTag(ToolTags.TASK_ITEM, useUnmergedTree = true).assertCountEquals(3)
        rule.onNodeWithText("Read: /f5").assertExists()
        rule.onNodeWithText("+2 more tools").assertExists()
    }

    @Test
    fun patchFilesHaveHeaders() {
        show(tool("apply_patch", """{"changes":{"/repo/src/a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b"}}}"""))
        rule.node(DiffTags.HEADER).assertExists()
        rule.onNodeWithText("src/").assertExists()
        rule.onNodeWithText("a.ts").assertExists()
        rule.onNodeWithText("+1").assertExists()
        // Patch tools draw no card header of their own.
        rule.onAllNodesWithTag(ToolTags.HEADER, useUnmergedTree = true).assertCountEquals(0)
    }

    // CodexPatchView.tsx: a file's header opens that file's diff, by the patch's own key; the chevron ends the header.
    @Test
    fun patchFilesOpenTheirDiff() {
        val pressed = mutableListOf<Pair<String, String>>()
        show(
            tool("apply_patch", """{"changes":{"/repo/src/a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b"},"/repo/b.ts":{"type":"add","content":"x"}}}"""),
            callbacks = MessageCallbacks(onToolFilePress = { message, file -> pressed += message.id to file }),
        )
        rule.onAllNodesWithTag(ToolTags.FILE_CHEVRON, useUnmergedTree = true).assertCountEquals(2)
        val header = rule.onAllNodesWithTag(ToolTags.FILE_HEADER, useUnmergedTree = true)[1]
        val chevron = rule.onAllNodesWithTag(ToolTags.FILE_CHEVRON, useUnmergedTree = true)[1].bounds
        assertDp("chevron 14", 14, chevron.right - chevron.left)
        assertTrue("chevron at the header's end", chevron.right <= header.bounds.right && header.bounds.right - chevron.right <= 16.dp)
        header.performClick()
        assertEquals(listOf("t" to "/repo/b.ts"), pressed)
    }

    // Without a way to open them (no route), the file headers stay inert and show no chevron.
    @Test
    fun patchFilesAreInertWithoutARoute() {
        show(tool("apply_patch", """{"changes":{"/repo/src/a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b"}}}"""))
        rule.onAllNodesWithTag(ToolTags.FILE_CHEVRON, useUnmergedTree = true).assertCountEquals(0)
        rule.node(ToolTags.FILE_HEADER).assertHasNoClickAction()
    }

    // PermissionFooter: padding 6 / 4 above / 8 below; buttons 7 apart, at least 34 high.
    @Test
    fun permissionFooterAnswers() {
        val answers = mutableListOf<Pair<PermissionAnswer, String?>>()
        show(
            tool("Edit", """{"file_path":"/repo/a.kt","old_string":"a","new_string":"b"}""", ToolState.Running, permission = ToolPermission("r1", PermissionStatus.Pending)),
            callbacks = MessageCallbacks(onPermission = { a, m -> answers += a to m }),
        )
        val footer = rule.node(PermissionTags.FOOTER).bounds
        val yes = rule.node(PermissionTags.option(PermissionChoice.Allow)).bounds
        val all = rule.node(PermissionTags.option(PermissionChoice.AllowAllEdits)).bounds
        val card = rule.node(ToolTags.CARD).bounds
        assertBox("yes", yes, card.left + 6.dp, footer.top + 4.dp, card.right - card.left - 12.dp, yes.bottom - yes.top)
        assertTrue(yes.bottom - yes.top >= 34.dp)
        assertDp("7 apart", 7, all.top - yes.bottom)
        val deny = rule.node(PermissionTags.option(PermissionChoice.Deny)).bounds
        assertDp("8 below", 8, footer.bottom - deny.bottom)
        // TalkBack: each choice is a button reading its text.
        rule.onNode(hasText("Yes, allow all edits during this session") and hasRole(Role.Button)).assertExists()
        rule.assertActionsLabelled()
        rule.onNodeWithText("Yes, allow all edits during this session").performClick()
        rule.waitForIdle()
        assertEquals(listOf(PermissionAnswer("r1", true, mode = "acceptEdits") to "acceptEdits"), answers)
    }
}
