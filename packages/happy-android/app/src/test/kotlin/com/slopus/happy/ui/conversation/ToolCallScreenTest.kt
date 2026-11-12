package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassBarTags
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.diff.DiffTags
import com.slopus.happy.ui.files.MessageDetailTags
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
import java.io.File

/**
 * A tool call's screen ([ToolCallSpec]) on the 411 phone: the header card
 * 12 under the bar's feather on the 16 inset, its 36 tile and its pill at
 * least 24 high; a command as the terminal's panel; an edit as its files'
 * diffs from the hunks as sent, each file opening on its own; the review;
 * a call without a presentation as its tool's own view or as fields, raw
 * JSON last and folded. A tap on a tool line opens it. With
 * HAPPY_SHOTS_DIR set, each screen is written there.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ToolCallScreenTest {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private fun call(json: String) = Block.parse(Json.parseToJsonElement(json)) as Block.ToolCall

    private val command = call(
        """{"type":"tool_call","id":"c1","name":"exec_command","status":"completed",
            "presentation":{"type":"exec_command","command":"pnpm test","output":"42 passed"},
            "elevated":true,"review":{"outcome":"allowed","reason":"The person asked to run the tests.","risk":"high","userAuthorization":"high"}}""",
    )

    private val edit = call(
        """{"type":"tool_call","id":"c2","name":"apply_patch","status":"completed",
            "presentation":{"type":"file_diff","omittedFiles":1,"files":[
              {"path":"sources/auth/login.ts","kind":"update","added":2,"deleted":1,"omittedLines":4,"hunks":[{"oldStart":12,"newStart":12,"lines":[
                {"kind":"context","text":"function go(user) {"},
                {"kind":"delete","text":"  return legacyLogin(user);"},
                {"kind":"add","text":"  const session = login(user);"},
                {"kind":"add","text":"  return session;"}]}]},
              {"path":"notes.md","kind":"add","added":1,"deleted":0,"hunks":[{"oldStart":0,"newStart":1,"lines":[{"kind":"add","text":"# Notes"}]}]}]}}""",
    )

    private val mystery = call(
        """{"type":"tool_call","id":"c3","name":"mcp__linear__create_issue","status":"completed",
            "arguments":{"title":"Login loops","file_path":"sources/auth/login.ts","labels":["bug","auth"]},
            "result":{"output":"{\"id\":\"LIN-42\",\"url\":\"https://linear.app/i/LIN-42\"}"}}""",
    )

    private val plan = call(
        """{"type":"tool_call","id":"c4","name":"update_plan","status":"completed",
            "arguments":{"explanation":"First pass","plan":[{"step":"Read the callback","status":"completed"},{"step":"Fix the cookie","status":"in_progress"},{"step":"Run the tests","status":"pending"}]}}""",
    )

    private fun show(state: ToolCallScreenState, actions: ToolCallActions = ToolCallActions(), dark: Boolean = false) {
        rule.setHappyContent(dark) {
            // Plain colour, as the diff renderer's own tests draw it.
            androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.diff.LocalDiffSyntax provides null) { ToolCallScreen(state, actions) }
        }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = dir ?: return
        dir.mkdirs()
        rule.mainClock.advanceTimeBy(1_000)
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "tool-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun all(tag: String): List<DpRect> = rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().map { node ->
        with(rule.density) { DpRect(node.boundsInRoot.left.toDp(), node.boundsInRoot.top.toDp(), node.boundsInRoot.right.toDp(), node.boundsInRoot.bottom.toDp()) }
    }

    @Test fun `the header card sits 12 under the feather on the inset, its tile 36 and its pill at least 24`() {
        show(ToolCallScreenState(call = command, reading = false))
        val bar = rule.node(GlassBarTags.BAR).bounds
        val header = rule.node(ToolCallTags.HEADER).bounds
        assertDp("12 under the feather", bar.bottom + GlassSpec.feather + 12.dp, header.top)
        assertDp("on the 16 inset", 16, header.left)
        assertDp("the column less its insets", (PHONE_WIDTH - 32).dp, header.width)
        assertDp("14, the 22 kind and the 18 name over the 36 tile, 14", 68, header.height)
        val tile = rule.node(ToolCallTags.TILE).bounds
        assertDp("the tile is 36", 36, tile.width)
        assertDp("the tile is 14 in", header.left + 14.dp, tile.left)
        assertDp("the kind is 12 after the tile", tile.right + 12.dp, rule.node(ToolCallTags.HEADER_TITLE).bounds.left)
        assertTrue("the pill is at least 24", rule.node(ToolCallTags.STATUS).bounds.height >= 24.dp - 0.34.dp)
        assertDp("the pill ends 14 inside the card", header.right - 14.dp, rule.node(ToolCallTags.STATUS).bounds.right)
        rule.onNodeWithText("Terminal", substring = false).assertIsDisplayed()
        rule.onNodeWithText("Completed").assertIsDisplayed()
        assertEquals("the bar's title and the command", 2, rule.onAllNodesWithText("pnpm test").fetchSemanticsNodes().size)
        rule.onNodeWithText("42 passed").assertIsDisplayed()
        rule.node(MessageDetailTags.COMMAND).assertIsDisplayed()
        shot("command")
    }

    @Test fun `a reviewed call says the decision, risk, what was asked and its access, after what it did`() {
        show(ToolCallScreenState(call = command, reading = false))
        rule.node(ToolCallTags.REVIEW).performScrollTo()
        val review = rule.node(ToolCallTags.REVIEW).bounds
        assertTrue("the review follows the terminal", review.top > rule.node(MessageDetailTags.COMMAND).bounds.bottom)
        rule.onNodeWithText("Allowed").assertIsDisplayed()
        rule.onNodeWithText("Ran with Full access").assertIsDisplayed()
        assertEquals("risk and what was asked", 2, rule.onAllNodesWithText("High").fetchSemanticsNodes().size)
        rule.onNodeWithText("The person asked to run the tests.").assertExists()
    }

    @Test fun `an edit draws each file's hunks with their own line numbers, and each file opens alone`() {
        var opened: String? = null
        show(ToolCallScreenState(call = edit, reading = false), ToolCallActions(onOpenFile = { opened = it }))
        assertEquals("one header a file", 2, all(DiffTags.HEADER).size)
        assertEquals("four lines and one", 5, all(DiffTags.LINE).size)
        rule.onNodeWithText("  return legacyLogin(user);", substring = true).assertExists()
        val opens = rule.onAllNodesWithTag(DiffTags.OPEN_FILE, useUnmergedTree = true)
        assertEquals(2, opens.fetchSemanticsNodes().size)
        val open = all(DiffTags.OPEN_FILE)[1]
        assertDp("a 32 target", 32, open.width)
        opens[1].performClick()
        assertEquals("notes.md", opened)
        rule.onNodeWithText("4 more lines in login.ts aren’t shown").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("1 more file isn’t shown").assertIsDisplayed()
        shot("edit")
    }

    @Test fun `one file of an edit is that file's diff alone, titled with its name`() {
        show(ToolCallScreenState(call = edit, reading = false, file = "sources/auth/login.ts"))
        assertEquals(1, all(DiffTags.HEADER).size)
        assertEquals(0, all(DiffTags.OPEN_FILE).size)
        assertEquals(0, all(ToolCallTags.HEADER).size)
        assertEquals("the bar's title and the file's header", 2, rule.onAllNodesWithText("login.ts").fetchSemanticsNodes().size)
    }

    @Test fun `a call no presentation stands for reads as fields, its result unwrapped, raw JSON last and folded`() {
        show(ToolCallScreenState(call = mystery, reading = false))
        rule.onNodeWithText("Tool call").assertIsDisplayed()
        assertEquals("the bar's title and the header's name", 2, rule.onAllNodesWithText("linear · create_issue").fetchSemanticsNodes().size)
        rule.onNodeWithText("File path").assertIsDisplayed()
        rule.onNodeWithText("sources/auth/login.ts").assertIsDisplayed()
        rule.onNodeWithText("LIN-42").performScrollTo().assertIsDisplayed()
        val fields = all(ToolCallTags.FIELD)
        fields.forEach { assertDp("a field is on the card's inset", 16, it.left) }
        assertEquals("title, path, labels; id, url", 5, fields.size)
        assertEquals("folded", 0, rule.onAllNodesWithText("\"arguments\"", substring = true).fetchSemanticsNodes().size)
        rule.node(ToolCallTags.RAW_TOGGLE).performScrollTo().performClick()
        rule.onNodeWithText("\"arguments\"", substring = true).assertExists()
        shot("fields")
    }

    @Test fun `a plan is its checklist`() {
        show(ToolCallScreenState(call = plan, reading = false))
        rule.onNodeWithText("Plan").assertIsDisplayed()
        assertEquals(3, all(ToolCallTags.STEP).size)
        rule.onNodeWithText("Fix the cookie").assertIsDisplayed()
        rule.onNodeWithText("First pass").assertIsDisplayed()
        shot("plan")
    }

    @Test fun `a historical widget call opens as generic fields with no widget controls`() {
        val historical = call("""{"type":"tool_call","id":"old","name":"show_ui","status":"completed",
            "presentation":{"type":"ui","ui":{"id":"u","components":[{"id":"model","type":"default_model","props":{}}]}},
            "arguments":{"title":"Old widget"},"result":{"output":"Recorded"}}""")
        show(ToolCallScreenState(call = historical, reading = false))
        rule.onNodeWithText("Tool call").assertIsDisplayed()
        rule.onNodeWithText("Old widget").assertIsDisplayed()
        rule.onNodeWithText("Recorded").assertIsDisplayed()
    }

    @Test fun `while reading it whole the screen says so`() {
        show(ToolCallScreenState(call = command.copy(arguments = null), reading = false, readingWhole = true))
        rule.onNodeWithText("Reading the whole call…").performScrollTo().assertIsDisplayed()
    }

    @Test fun `a call that can't be found says so`() {
        show(ToolCallScreenState(reading = false))
        rule.node(ToolCallTags.MISSING).assertIsDisplayed()
    }

    @Test fun `a tap on a tool line opens its call`() {
        var opened: String? = null
        val row = com.slopus.happy.conversation.ConversationRowBuilder.build(
            com.slopus.happy.conversation.Message("m1", "agent", 1, listOf(command)),
            "a1",
            null,
            false,
        ).single() as ConversationRow.Tool
        rule.setHappyContent { ToolLine(row.tool, onOpen = { opened = row.tool.id }) }
        rule.node(TurnRowTags.TOOL).performClick()
        assertEquals("c1", opened)
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithText(text: String, substring: Boolean = false) =
        onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring), useUnmergedTree = true)
}
