package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.ui.QuickReply
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
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

/** Chat UI and suggested replies in the transcript ([UiComponentRow], [QuickRepliesRow]), drawn from the wire as the daemon sends it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiComponentRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Onboarding", "idle", null, null, 1, 2, 0, 0)

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** One agent message: words, then a `ui` block of [components]. */
    private fun offer(vararg components: String): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"text","text":"Pick one."},
                {"type":"ui","ui":{"id":"u1","components":[${components.joinToString(",")}]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false)
    }

    private val signIn = """{"id":"claude","type":"provider_sign_in","fallback":"Sign in to Claude in Happy on your computer","props":{"provider":"claude"}}"""
    private val phone = """{"id":"app","type":"phone_app","fallback":"Get Happy on your phone","props":{}}"""
    private val tree = """{"id":"files","type":"file_tree","fallback":"14 files","props":{"paths":[${(1..14).joinToString(",") { "\"src/file$it.ts\"" }}]}}"""

    /** An agent message asking in words, with a suggest_replies call, laid over as the conversation would. */
    private fun suggested(chosen: Int? = null, live: Boolean = true): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m2","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"What next?"},
                {"type":"tool_call","id":"c1","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Fix the login redirect","Run the tests","Something much longer than a phone's line can hold in one go"]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false).map { if (it is ConversationRow.Replies) it.copy(chosen = chosen, live = live) else it }
    }

    private val sentReply = Message.parse(
        Json.parseToJsonElement(
            """{"id":"p1","role":"user","status":"accepted","createdAt":3,"metadata":{},"content":[{"type":"text","text":"Run the tests"}],"quickReply":{"messageId":"m2","toolCallId":"c1","index":1}}""",
        ),
    )!!

    private var shownRows by mutableStateOf<List<ConversationRow>>(emptyList())

    private fun screen(rows: List<ConversationRow>, canSend: Boolean = true, replied: MutableList<Pair<ConversationRow.Replies, Int>> = ArrayList()) {
        shownRows = rows
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = shownRows.asReversed(), agent = agent),
                ConversationScreenActions(onQuickReply = { replies, index -> replied += replies to index }),
                roleCanSend = canSend,
            )
        }
        rule.waitForIdle()
    }

    private fun pills() = rule.onAllNodesWithTag(UiTags.REPLY, useUnmergedTree = true).let { all -> (0 until all.fetchSemanticsNodes().size).map { all[it] } }

    @Test fun `suggested replies are a stack of person-wide bubbles against the right, and a tap sends the option`() {
        val sent = ArrayList<Pair<ConversationRow.Replies, Int>>()
        screen(suggested() + ConversationRowBuilder.build(sentReply, "a1", null, streaming = false).map { (it as ConversationRow.User).copy(suggested = false) }, replied = sent)
        val root = rule.onRoot().bounds
        val bounds = pills().map { it.bounds }
        for (pill in bounds) {
            assertDp("a person's widest bubble: the column less 16 a side", root.right - root.left - 32.dp, pill.right - pill.left)
            assertDp("against the right, 16 in", root.right - 16.dp, pill.right)
        }
        assertDp("6 apart", 6.dp, bounds[1].top - bounds[0].bottom)
        assertDp("6 apart", 6.dp, bounds[2].top - bounds[1].bottom)
        val bubble = rule.node(com.slopus.happy.ui.chat.MessageTags.USER_BUBBLE).bounds
        assertDp("a one-line bubble's height", bubble.bottom - bubble.top, bounds[0].bottom - bounds[0].top)
        assertDp("the long one stays one line", bounds[0].bottom - bounds[0].top, bounds[2].bottom - bounds[2].top)
        shot("ui-quick-replies")
        pills()[1].performClick()
        assertEquals(listOf(1), sent.map { it.second })
        assertEquals(QuickReply("m2", "c1", 1), sent.single().first.reply(1))
    }

    @Test fun `the option sent takes the bubble's fill and a tick, and nothing moves`() {
        screen(suggested())
        val before = pills().map { it.bounds }
        rule.node(UiTags.REPLY_TICK).assertDoesNotExist()
        shownRows = suggested(chosen = 1, live = false) + ConversationRowBuilder.build(sentReply, "a1", null, streaming = false)
        rule.waitForIdle()
        // The message sent comes in under them, so the list moves up as one; within it, nothing moves.
        val after = pills().map { it.bounds }
        val shift = after[0].top - before[0].top
        assertEquals("not a pixel moves", before, after.map { DpRect(it.left, it.top - shift, it.right, it.bottom - shift) })
        pills()[1].assertIsSelected()
        pills()[0].assertIsNotSelected()
        val tick = rule.node(UiTags.REPLY_TICK).bounds
        assertDp("16 in from the pill's right", before[1].right - 12.dp, tick.right)
        rule.onNodeWithText("↩ Suggested reply").assertExists()
        shot("ui-quick-reply-sent")
        // An answered stack takes no more taps.
        pills()[0].assertIsNotEnabled()
    }

    @Test fun `each pill is a button, and a role that can't write can't tap one`() {
        val sent = ArrayList<Pair<ConversationRow.Replies, Int>>()
        screen(suggested(), canSend = false, replied = sent)
        pills()[0].assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
        pills()[0].assertIsNotEnabled()
        pills()[0].performClick()
        assertTrue(sent.isEmpty())
    }

    @Test fun `without live sources live components are their fallback line, and phone_app is not on a phone`() {
        val rows = offer(signIn, phone, tree)
        assertEquals(listOf("provider_sign_in", "file_tree"), rows.filterIsInstance<ConversationRow.Ui>().map { it.component.type })
        screen(rows)
        rule.onNodeWithText("Sign in to Claude in Happy on your computer").assertExists()
        rule.onNodeWithText("Get Happy on your phone").assertDoesNotExist()
        // Twelve lines of the tree (its folder and eleven files), then all of them.
        rule.onNodeWithText("file11.ts").assertExists()
        rule.onNodeWithText("file12.ts").assertDoesNotExist()
        rule.onNodeWithText("Show all (15)").assertExists()
        shot("ui-fallback-and-tree")
        rule.node(UiTags.FILE_TREE_MORE).performClick()
        rule.onNodeWithText("file14.ts").assertExists()
    }
}
