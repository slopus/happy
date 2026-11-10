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
import androidx.compose.ui.test.assertCountEquals
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
import com.slopus.happy.agent.ProviderCli
import com.slopus.happy.agent.ProviderCliSource
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.ui.QuickReply
import com.slopus.happy.conversation.ui.UiMediaLayout
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
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

    @Test fun `suggested replies are a left-aligned stack one width, capped at a person's widest bubble, and a tap sends the option`() {
        val sent = ArrayList<Pair<ConversationRow.Replies, Int>>()
        screen(suggested() + ConversationRowBuilder.build(sentReply, "a1", null, streaming = false).map { (it as ConversationRow.User).copy(suggested = false) }, replied = sent)
        val root = rule.onRoot().bounds
        val bounds = pills().map { it.bounds }
        for (pill in bounds) {
            // The long option is wider than the column: every pill stops at a person's widest bubble.
            assertDp("capped: the column less 16 a side", root.right - root.left - 32.dp, pill.right - pill.left)
            assertDp("at the agent's words' edge, 16 in", root.left + 16.dp, pill.left)
        }
        assertDp("6 apart", 6.dp, bounds[1].top - bounds[0].bottom)
        assertDp("6 apart", 6.dp, bounds[2].top - bounds[1].bottom)
        val bubble = rule.node(com.slopus.happy.ui.chat.MessageTags.USER_BUBBLE).bounds
        assertDp("a one-line bubble's height", bubble.bottom - bubble.top, bounds[0].bottom - bounds[0].top)
        assertTrue("the long one wraps, taller", bounds[2].bottom - bounds[2].top > bounds[0].bottom - bounds[0].top)
        shot("ui-quick-replies")
        pills()[1].performClick()
        assertEquals(listOf(1), sent.map { it.second })
        assertEquals(QuickReply("m2", "c1", 1), sent.single().first.reply(1))
    }

    /** A suggestion of short options, the first two about an AI ([ReplyUi.Provider]). */
    private fun aiReplies(live: Boolean = true, chosen: Int? = null): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m3","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"Which AI?"},
                {"type":"tool_call","id":"c3","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies",
                "options":["Sign in to Codex","Sign in to Claude Code","Skip for now"],
                "ui":[{"type":"provider","props":{"provider":"codex"}},{"type":"provider","props":{"provider":"claude"}},null]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false).map { if (it is ConversationRow.Replies) it.copy(live = live, chosen = chosen) else it }
    }

    private val codex = MutableStateFlow<ProviderCliSource.State>(ProviderCliSource.State.Reading)
    private val claude = MutableStateFlow<ProviderCliSource.State>(ProviderCliSource.State.Reading)

    private fun cli(id: String, installed: Boolean = true, signIn: String = "signed_out", accounts: Int? = null) = ProviderCli.parse(
        Json.parseToJsonElement(
            """{"id":"$id","name":"$id","installation":{"status":"${if (installed) "installed" else "missing"}"},"signIn":{"status":"$signIn"},"version":"01b"
            ${accounts?.let { n -> ""","accounts":[${(1..n).joinToString(",") { """{"id":"a$it","label":"a$it@example.com","signIn":"signed_in"}""" }}]""" } ?: ""}}""",
        ).jsonObject,
    )!!

    private fun liveScreen(rows: List<ConversationRow>) {
        shownRows = rows
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = shownRows.asReversed(), agent = agent),
                ConversationScreenActions(onQuickReply = { _, _ -> }),
                uiLive = UiLive(providerCli = { if (it == "codex") codex else claude }, team = false, roles = { emptyList() }),
            )
        }
        rule.waitForIdle()
    }

    @Test fun `short options take the widest one's width, an AI's mark and live note included, and a note that changes moves nothing`() {
        codex.value = ProviderCliSource.State.Read(cli("codex", signIn = "signed_in"))
        claude.value = ProviderCliSource.State.Read(cli("claude", installed = false))
        liveScreen(aiReplies())
        val root = rule.onRoot().bounds
        val before = pills().map { it.bounds }
        assertEquals("one width", 1, before.map { it.right - it.left }.distinct().size)
        assertTrue("narrower than the column: no wider than its options", before[0].right - before[0].left < root.right - root.left - 32.dp)
        for (pill in before) assertDp("left-aligned, 16 in", root.left + 16.dp, pill.left)
        assertEquals(2, rule.onAllNodesWithTag(UiTags.REPLY_MARK, useUnmergedTree = true).fetchSemanticsNodes().size)
        rule.onNodeWithText("1 account", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Not installed", useUnmergedTree = true).assertExists()
        shot("ui-quick-replies-ai")
        // Claude signs in twice over; Codex's program goes: only the notes' words change.
        claude.value = ProviderCliSource.State.Read(cli("claude", signIn = "signed_in", accounts = 12))
        codex.value = ProviderCliSource.State.Read(cli("codex", installed = false))
        rule.waitForIdle()
        rule.onNodeWithText("12 accounts", useUnmergedTree = true).assertExists()
        assertEquals("not a pixel moves", before, pills().map { it.bounds })
        // Answered, the notes go and the marks stay, in the same room.
        shownRows = aiReplies(live = false, chosen = 2)
        rule.waitForIdle()
        rule.onAllNodesWithTag(UiTags.REPLY_NOTE, useUnmergedTree = true).assertCountEquals(0)
        assertEquals("not a pixel moves", before, pills().map { it.bounds })
    }

    /** "Add another Claude Code account", an AI's longest reply, over one that is short. */
    private fun addAccount(live: Boolean = true, chosen: Int? = null): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m4","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"Which should I add?"},
                {"type":"tool_call","id":"c4","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies",
                "options":["Add another Claude Code account","That's all for now"],"ui":[{"type":"provider","props":{"provider":"claude"}},null]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false).map { if (it is ConversationRow.Replies) it.copy(live = live, chosen = chosen) else it }
    }

    /**
     * The long reply stays whole at the stack's one width (two lines at most), its note on a line of
     * its own under the words that every AI pill keeps, blank or not; nothing moves after.
     */
    private fun longReplyFits(width: Int) {
        claude.value = ProviderCliSource.State.Reading
        liveScreen(addAccount())
        val root = rule.onRoot().bounds
        assertDp("the phone", width.dp, root.right - root.left)
        val before = pills().map { it.bounds }
        assertEquals("one width", 1, before.map { it.right - it.left }.distinct().size)
        assertTrue("capped at the column less 16 a side", before[0].right - before[0].left <= root.right - root.left - 32.dp)
        for (pill in before) assertDp("left-aligned, 16 in", root.left + 16.dp, pill.left)
        val words = rule.onNodeWithText("Add another Claude Code account", useUnmergedTree = true).fetchSemanticsNode()
        val layout = ArrayList<androidx.compose.ui.text.TextLayoutResult>().also { words.config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action!!(it) }.single()
        assertTrue("two lines at most", layout.lineCount in 1..2)
        assertTrue("whole, no ellipsis", !layout.hasVisualOverflow && !layout.isLineEllipsized(layout.lineCount - 1))
        val density = rule.density.density
        val label = ((words.boundsInRoot.bottom - words.boundsInRoot.top) / density).dp
        assertDp("its words' height", 25.dp * layout.lineCount, label)
        // The plain pill is one line; the AI's is its words plus the note line, 18, even blank.
        assertDp("words + the note line + the bubble's padding", 25.dp * layout.lineCount + 18.dp + 26.dp, before[0].bottom - before[0].top)
        assertDp("a one-line bubble", 51.dp, before[1].bottom - before[1].top)
        rule.onAllNodesWithTag(UiTags.REPLY_NOTE, useUnmergedTree = true).assertCountEquals(0)
        // The note comes, under the words, at their edge; then changes, then goes with the tap: no height moves.
        claude.value = ProviderCliSource.State.Read(cli("claude", signIn = "signed_in", accounts = 1))
        rule.waitForIdle()
        val note = rule.onNodeWithText("1 account", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertDp("under the words", (words.boundsInRoot.bottom / density).dp, (note.top / density).dp)
        assertDp("at the words' edge", (words.boundsInRoot.left / density).dp, (note.left / density).dp)
        assertEquals("not a pixel moves", before, pills().map { it.bounds })
        shot("ui-quick-replies-long-$width")
        claude.value = ProviderCliSource.State.Read(cli("claude", signIn = "signed_in", accounts = 2))
        rule.waitForIdle()
        rule.onNodeWithText("2 accounts", useUnmergedTree = true).assertExists()
        assertEquals("not a pixel moves", before, pills().map { it.bounds })
        shownRows = addAccount(live = false, chosen = 0)
        rule.waitForIdle()
        rule.onAllNodesWithTag(UiTags.REPLY_NOTE, useUnmergedTree = true).assertCountEquals(0)
        assertEquals("not a pixel moves", before, pills().map { it.bounds })
    }

    @Config(qualifiers = "w360dp-h780dp-xxhdpi")
    @Test fun `a long AI reply stays whole on a 360 phone, its note under it`() = longReplyFits(360)

    @Test fun `a long AI reply stays whole on a 411 phone, its note under it`() = longReplyFits(411)

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

    /** A show_ui call's `media`: [count] items cycling landscape, portrait and square, every third labelled, and a file. */
    private fun mediaRows(count: Int, file: Boolean = false): List<ConversationRow> {
        val sizes = listOf(1600 to 900, 900 to 1200, 1000 to 1000)
        val items = (0 until count).map { val (w, h) = sizes[it % 3]; """{"kind":"image","name":"p$it.png","mimeType":"image/png","width":$w,"height":$h}""" } +
            if (file) listOf("""{"kind":"document","name":"Report.pdf","mimeType":"application/pdf"}""") else emptyList()
        val refs = (0 until items.size).joinToString(",") { if (it % 3 == 0) """{"mediaIndex":$it,"label":"Shot $it"}""" else """{"mediaIndex":$it}""" }
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m4","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"Here they are."},
                {"type":"tool_call","id":"c4","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u4","components":[
                {"id":"pics","type":"media","fallback":"$count images","props":{"items":[$refs]}}]},"items":[${items.joinToString(",")}]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false)
    }

    @Test fun `media lays out by the shared rule at the phone's measure, labels under their items, before any bytes`() {
        screen(mediaRows(4, file = true))
        val flow = rule.node(ConversationMediaTags.FLOW).bounds
        val width = (flow.right - flow.left).value.toDouble()
        val inputs = (0 until 4).map { listOf(1600.0 to 900.0, 900.0 to 1200.0, 1000.0 to 1000.0)[it % 3] }
            .mapIndexed { i, (w, h) -> UiMediaLayout.Input("image", w, h, i % 3 == 0) } + UiMediaLayout.Input("document", null, null, false)
        val laid = UiMediaLayout.layout(inputs, width)
        assertDp("the column less 16 a side", rule.onRoot().bounds.let { it.right - it.left } - 32.dp, flow.right - flow.left)
        assertDp("as tall as the rule says, with nothing loaded", laid.height.dp, flow.bottom - flow.top)
        val tiles = rule.onAllNodesWithTag(ConversationMediaTags.TILE, useUnmergedTree = true).let { all -> (0 until all.fetchSemanticsNodes().size).map { all[it].bounds } }
        tiles.forEachIndexed { i, tile ->
            assertDp("tile $i left", flow.left + laid.frames[i].x.dp, tile.left)
            assertDp("tile $i top", flow.top + laid.frames[i].y.dp, tile.top)
            assertDp("tile $i width", laid.frames[i].width.dp, tile.right - tile.left)
        }
        rule.onNodeWithText("Shot 0").assertExists()
        rule.onNodeWithText("Report.pdf").assertExists()
        shot("ui-media-four")
    }

    @Test fun `ten labelled items, and one alone at most twice the row height`() {
        screen(mediaRows(10))
        shot("ui-media-ten")
        assertEquals(10, rule.onAllNodesWithTag(ConversationMediaTags.TILE, useUnmergedTree = true).fetchSemanticsNodes().size)
        screenAgain(mediaRows(1))
        val tile = rule.node(ConversationMediaTags.TILE).bounds
        assertDp("16:9 at the full measure", (tile.right - tile.left) * 9f / 16f, tile.bottom - tile.top)
    }

    private fun screenAgain(rows: List<ConversationRow>) {
        shownRows = rows
        rule.waitForIdle()
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
