package com.slopus.happy.ui.conversation

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Chat UI's components in the transcript ([UiComponentRow]), drawn from the wire as the daemon sends it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiComponentRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Onboarding", "idle", null, null, 1, 2, 0, 0)

    /** One agent message: words, then a `ui` block of [components]. */
    private fun offer(vararg components: String): List<ConversationRow> = ConversationRowBuilder.build(
        Message.parse(
            Json.parseToJsonElement(
                """{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"text","text":"Pick one."},
                {"type":"ui","ui":{"id":"u1","components":[${components.joinToString(",")}]}}]}""",
            ),
        )!!,
        "a1", null, streaming = false,
    )

    private fun screen(rows: List<ConversationRow>) {
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent), ConversationScreenActions())
        }
        rule.waitForIdle()
    }

    private fun lines() = rule.onAllNodesWithTag(UiTags.FILE_TREE_LINE, useUnmergedTree = true).let { all -> (0 until all.fetchSemanticsNodes().size).map { all[it].bounds } }

    @Test fun `a file tree is a card of lines under their folders, twelve until all are asked for`() {
        screen(offer(tree(14)))
        val root = rule.onRoot().bounds
        val card = rule.node(UiTags.FILE_TREE).bounds
        assertDp("the row spans the column", root.right - root.left, card.right - card.left)
        val shown = lines()
        assertEquals("the folder and eleven of its files", 12, shown.size)
        assertDp("16 in, 12 in the card", root.left + 28.dp, shown[0].left)
        assertDp("6 above, 12 in the card", card.top + 18.dp, shown[0].top)
        val folder = rule.onNodeWithText("src", useUnmergedTree = true).bounds
        assertDp("its name after the 14 glyph and 6", shown[0].left + 20.dp, folder.left)
        assertDp("a level is 16 in", folder.left + 16.dp, rule.onNodeWithText("file1.ts", useUnmergedTree = true).bounds.left)
        for (line in shown) assertDp("a 20 line", 20.dp, line.bottom - line.top)
        assertDp("one under another", shown[0].bottom, shown[1].top)
        rule.onNodeWithText("file11.ts").assertExists()
        rule.onNodeWithText("file12.ts").assertDoesNotExist()
        val more = rule.node(UiTags.FILE_TREE_MORE).bounds
        rule.onNodeWithText("Show all (15)").assertExists()
        assertDp("4 under the lines", shown.last().bottom + 4.dp, more.top)
        assertDp("its 18 line, 4 above and below", 26.dp, more.bottom - more.top)
        assertDp("12 in the card, 6 below", more.bottom + 18.dp, card.bottom)
        rule.node(UiTags.FILE_TREE_MORE).performClick()
        rule.waitForIdle()
        assertEquals(15, lines().size)
        rule.onNodeWithText("file14.ts").assertExists()
        rule.node(UiTags.FILE_TREE_MORE).assertDoesNotExist()
    }

    @Test fun `a short tree shows whole, and a name too long for its line is cut`() {
        screen(offer("""{"id":"files","type":"file_tree","fallback":"2 files","props":{"paths":["README.md","src/${"a-very-long-name-".repeat(6)}.ts"]}}"""))
        val root = rule.onRoot().bounds
        val shown = lines()
        assertEquals(3, shown.size)
        rule.node(UiTags.FILE_TREE_MORE).assertDoesNotExist()
        for (line in shown) {
            assertDp("a 20 line, however long its name", 20.dp, line.bottom - line.top)
            assert(line.right <= root.right - 28.dp + 0.5.dp) { "inside the card" }
        }
    }

    @Test fun `a type this build does not draw is its fallback line in a card`() {
        screen(offer("""{"id":"claude","type":"provider_sign_in","fallback":"Sign in to Claude in Happy on your computer","props":{"provider":"claude"}}"""))
        val root = rule.onRoot().bounds
        val card = rule.node(UiTags.FALLBACK).bounds
        assertDp("the row spans the column", root.right - root.left, card.right - card.left)
        // 6 + 12 above and below a 20 line.
        assertDp("one line", 56.dp, card.bottom - card.top)
        val words = rule.onNodeWithText("Sign in to Claude in Happy on your computer", useUnmergedTree = true).bounds
        assertDp("16 in, 12 in the card, the 18 mark and 10", root.left + 56.dp, words.left)
        assertDp("to 12 in the card, 16 in", root.right - 28.dp, words.right)
    }

    @Test fun `a fallback too long for a line wraps`() {
        screen(offer("""{"id":"x","type":"team_invite","fallback":"${"Invite a teammate from Settings on your computer. ".repeat(3).trim()}","props":{}}"""))
        val card = rule.node(UiTags.FALLBACK).bounds
        assert(card.bottom - card.top > 56.dp) { "taller than one line" }
    }

    private fun tree(files: Int) =
        """{"id":"files","type":"file_tree","fallback":"$files files","props":{"paths":[${(1..files).joinToString(",") { "\"src/file$it.ts\"" }}]}}"""
}
