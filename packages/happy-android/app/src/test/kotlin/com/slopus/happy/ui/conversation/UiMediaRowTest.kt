package com.slopus.happy.ui.conversation

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.ui.UiMediaLayout
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A chat UI `media` component in the transcript ([UiMediaRow]), drawn from the wire as the daemon sends it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiMediaRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Onboarding", "idle", null, null, 1, 2, 0, 0)
    private val sizes = listOf(1600.0 to 900.0, 900.0 to 1200.0, 1000.0 to 1000.0)

    /** A show_ui call's `media`: [count] pictures cycling landscape, portrait and square, every third labelled, then a file where asked. */
    private fun rows(count: Int, file: Boolean = false): List<ConversationRow> {
        val items = (0 until count).map { val (w, h) = sizes[it % 3]; """{"kind":"image","name":"p$it.png","mimeType":"image/png","width":${w.toInt()},"height":${h.toInt()}}""" } +
            if (file) listOf("""{"kind":"document","name":"Report.pdf","mimeType":"application/pdf"}""") else emptyList()
        val refs = items.indices.joinToString(",") { if (it % 3 == 0) """{"mediaIndex":$it,"label":"Shot $it"}""" else """{"mediaIndex":$it}""" }
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m4","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"Here they are."},
                {"type":"tool_call","id":"c4","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u4","components":[
                {"id":"pics","type":"media","fallback":"$count images","props":{"items":[$refs]}}]},"items":[${items.joinToString(",")}]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false)
    }

    /** What the shared rule says of [rows]'s items at [width]. */
    private fun laid(count: Int, file: Boolean, width: Double): UiMediaLayout.Arrangement {
        val inputs = (0 until count).map { UiMediaLayout.Input("image", sizes[it % 3].first, sizes[it % 3].second, it % 3 == 0) } +
            if (file) listOf(UiMediaLayout.Input("document", null, null, count % 3 == 0)) else emptyList()
        return UiMediaLayout.layout(inputs, width)
    }

    private fun screen(rows: List<ConversationRow>) {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent),
                // No byte ever comes: the row is laid out from the items' stated sizes alone.
                ConversationScreenActions(loadMedia = { awaitCancellation() }),
            )
        }
        rule.waitForIdle()
    }

    private fun bounds(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true).let { all -> (0 until all.fetchSemanticsNodes().size).map { all[it].bounds } }

    private fun assertFrame(name: String, flow: DpRect, frame: UiMediaLayout.Frame, box: DpRect) {
        assertDp("$name left", flow.left + 16.dp + frame.x.dp, box.left)
        assertDp("$name top", flow.top + 6.dp + frame.y.dp, box.top)
        assertDp("$name width", frame.width.dp, box.right - box.left)
        assertDp("$name height", frame.height.dp, box.bottom - box.top)
    }

    @Test fun `media lays out by the shared rule at the column's measure, before any bytes, a file among the pictures`() {
        screen(rows(4, file = true))
        val root = rule.onRoot().bounds
        val flow = rule.node(UiMediaTags.FLOW).bounds
        assertDp("the row spans the column", root.right - root.left, flow.right - flow.left)
        val laid = laid(4, file = true, width = (root.right - root.left).value - 32.0)
        assertDp("as tall as the rule says, 6 above and below", laid.height.dp + 12.dp, flow.bottom - flow.top)
        val tiles = bounds(ConversationMediaTags.TILE)
        assertEquals(4, tiles.size)
        tiles.forEachIndexed { index, tile -> assertFrame("tile $index", flow, laid.frames[index], tile) }
        assertFrame("the file", flow, laid.frames[4], rule.node(UiMediaTags.FILE).bounds)
        rule.onNodeWithText("Report.pdf", useUnmergedTree = true).assertExists()
        // Labels on the first and fourth, each on its 18 line 4 under its item.
        val labels = bounds(UiMediaTags.LABEL)
        assertEquals(2, labels.size)
        assertFrame("label 0", flow, laid.labels[0]!!, labels[0])
        assertFrame("label 3", flow, laid.labels[3]!!, labels[1])
        assertDp("4 under its item", tiles[0].bottom + 4.dp, labels[0].top)
        assertDp("one 18 line", 18.dp, labels[0].bottom - labels[0].top)
        rule.onNodeWithText("Shot 0", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Shot 3", useUnmergedTree = true).assertExists()
        rule.node(UiMediaTags.FILE).assertHasClickAction()
    }

    @Test fun `one picture alone is at most twice the row's height, on the left`() {
        screen(rows(1))
        val flow = rule.node(UiMediaTags.FLOW).bounds
        val tile = rule.node(ConversationMediaTags.TILE).bounds
        val width = (flow.right - flow.left).value - 32.0
        assertFrame("the picture", flow, laid(1, file = false, width = width).frames[0], tile)
        assertDp("16:9 at the full measure", (tile.right - tile.left) * 9f / 16f, tile.bottom - tile.top)
        assertDp("on the left, 16 in", flow.left + 16.dp, tile.left)
    }

    @Test fun `ten items fill their rows by the rule`() {
        screen(rows(10))
        val flow = rule.node(UiMediaTags.FLOW).bounds
        val laid = laid(10, file = false, width = (flow.right - flow.left).value - 32.0)
        val tiles = bounds(ConversationMediaTags.TILE)
        assertEquals(10, tiles.size)
        tiles.forEachIndexed { index, tile -> assertFrame("tile $index", flow, laid.frames[index], tile) }
        assertDp("as tall as the rule says", laid.height.dp + 12.dp, flow.bottom - flow.top)
    }
}
