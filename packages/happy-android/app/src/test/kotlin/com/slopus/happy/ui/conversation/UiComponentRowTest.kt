package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
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

    /** An agent message asking in words, with a suggest_replies call. */
    private fun suggested(): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m2","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"What next?"},
                {"type":"tool_call","id":"c1","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Fix the login redirect","Run the tests"]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false)
    }

    private fun screen(rows: List<ConversationRow>, canSend: Boolean = true, replied: MutableList<Pair<ConversationRow.Replies, Int>> = ArrayList()) {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent),
                ConversationScreenActions(onQuickReply = { replies, index -> replied += replies to index }),
                roleCanSend = canSend,
            )
        }
        rule.waitForIdle()
    }

    @Test fun `suggested replies are pills on the column, and a tap sends the option`() {
        val sent = ArrayList<Pair<ConversationRow.Replies, Int>>()
        screen(suggested(), replied = sent)
        val row = rule.node(UiTags.REPLIES).bounds
        val pills = rule.onAllNodesWithTag(UiTags.REPLY, useUnmergedTree = true)
        val first = pills[0].bounds
        val second = pills[1].bounds
        assertDp("16 in from the side", row.left + 16.dp, first.left)
        assertDp("36 high", 36.dp, first.bottom - first.top)
        assertTrue("8 apart, on one line or wrapped", second.left - first.right == 8.dp || second.top - first.bottom == 8.dp)
        shot("ui-quick-replies")
        rule.onNodeWithText("Run the tests").performClick()
        assertEquals(listOf(1), sent.map { it.second })
        assertEquals(QuickReply("m2", "c1", 1), sent.single().first.reply(1))
    }

    @Test fun `a role that can't write sees no pills`() {
        screen(suggested(), canSend = false)
        rule.node(UiTags.REPLIES).assertDoesNotExist()
    }

    @Test fun `a bubble sent from a reply says who suggested it`() {
        val person = Message.parse(
            Json.parseToJsonElement(
                """{"id":"p1","role":"user","status":"accepted","createdAt":3,"metadata":{},"content":[{"type":"text","text":"Run the tests"}],"quickReply":{"messageId":"m2","toolCallId":"c1","index":1}}""",
            ),
        )!!
        screen(suggested() + ConversationRowBuilder.build(person, "a1", null, streaming = false))
        rule.onNodeWithText("↩ Suggested by Onboarding").assertExists()
        shot("ui-quick-reply-sent")
        val line = rule.node(UiTags.SUGGESTED).bounds
        val texts = rule.onAllNodesWithText("Run the tests", useUnmergedTree = true)
        val bubble = (0 until texts.fetchSemanticsNodes().size).map { texts[it].bounds }.maxBy { it.top }
        assertTrue("over the bubble", line.bottom <= bubble.top)
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
