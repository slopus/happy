package com.slopus.happy.ui.conversation

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.TurnFold
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * A turn's own rows in a Happy Agent chat (desktop bb346adb, 6fe92408,
 * 4dee669d; iOS 7f6355041). Spec ([TurnRowSpec]): a tool call is one 20
 * line 6 above and below, 16 in: a 14 lane for its glyph, the verb 6 after
 * it and the subject 6 after that, a file edit's counts 6 after its name.
 * How the turn ended is a 32 row: the 20 copy button 2 out from the column,
 * the 24 line 8 after it. The fold control is a 16 line 8 under what is
 * above it. Tapping it opens the turn on its work, the control staying
 * where it was under the finger, and again folds it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TurnRowsTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1, 2, 0, 0)

    private fun built(vararg messages: Message): List<ConversationRow> = messages.flatMap { ConversationRowBuilder.build(it, "a1", null, false) }

    /** Earlier work, enough to scroll. */
    private val earlier = (0 until 6).flatMap { index ->
        built(
            Message("e$index", "user", 1, listOf(Block.Text("Earlier question $index"))),
            Message("f$index", "agent", 1, listOf(Block.Text("An earlier answer, long enough to take a few lines of the screen so the list has somewhere to go when a turn opens. ".repeat(2)))),
        )
    }

    private val turn = built(
        Message("m1", "user", 1, listOf(Block.Text("The login page loops back to itself after sign-in. Can you find out why?"))),
        Message(
            "m2", "agent", 2,
            listOf(
                Block.Reasoning("The redirect loop suggests the session cookie is not set before the callback."),
                Block.ToolCall("c1", "exec_command", "completed", Presentation.Command("grep -rn redirect sources/auth", null)),
                Block.ToolCall("c2", "read_file", "completed", Presentation.Exploration.reads("callback.ts", "session.ts")),
                Block.ToolCall("c3", "exec_command", "failed", Presentation.Command("npm test -- auth", null)),
                Block.ToolCall("c4", "apply_patch", "completed", Presentation.FileDiff(listOf(Presentation.FileDiff.File("sources/auth/callback.ts", "update", 3, 1)))),
                Block.Text("Found it: the callback rewrote the URL before the cookie was written. Fixed."),
            ),
        ),
    ).map { if (it.key == "m2:5") (it as ConversationRow.Text).copy(copies = false) else it } +
        ConversationRow.TurnEnd("r1:status", "r1", "completed", 42_000, 4, "Found it: the callback rewrote the URL before the cookie was written. Fixed.")

    /** Still running: shown whole. */
    private val running = built(
        Message("m3", "user", 3, listOf(Block.Text("Run the tests."))),
        Message("m4", "agent", 4, listOf(Block.ToolCall("c5", "exec_command", "running", Presentation.Command("npm test", null)))),
    )

    private fun rows(open: Boolean, live: Boolean = false) =
        (earlier + TurnFold.fold("r1", turn, open) + if (live) running else emptyList()).asReversed()

    private var open by mutableStateOf(false)
    private val toggles = ArrayList<String>()

    private fun setScreen(dark: Boolean = false, live: Boolean = false) {
        rule.setHappyContent(dark) {
            ProvideWindowLayout {
                ConversationScreen(
                    ConversationState(created = true, loaded = true, rows = rows(open, live), agent = agent),
                    null,
                    ConversationScreenActions(
                        onToggleTurn = { turn ->
                            toggles += turn
                            open = !open
                        },
                    ),
                )
            }
        }
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun row(text: String) = rule.onNode(hasTestTag(TurnRowTags.TOOL) and hasContentDescription(text, substring = true), useUnmergedTree = true)

    private fun child(line: androidx.compose.ui.test.SemanticsNodeInteraction, tag: String) =
        rule.onNode(hasTestTag(tag) and androidx.compose.ui.test.hasAnyAncestor(hasTestTag(TurnRowTags.TOOL) and hasContentDescription(lineText(line))), useUnmergedTree = true)

    private fun lineText(line: androidx.compose.ui.test.SemanticsNodeInteraction): String =
        line.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ContentDescription].single()

    @Test
    fun aFoldedTurnShowsTheWordsTheEditTheControlTheAnswerAndHowItEnded() {
        setScreen()
        rule.node(TurnRowTags.TRACE).assertExists()
        rule.onNode(hasText("View traces"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("4 tools"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("Completed in\u00a042s"), useUnmergedTree = true).assertExists()
        // The answer's copy is the turn's: no copy button under the control but the turn's own.
        val control = rule.node(TurnRowTags.TRACE).bounds
        val copies = rule.onAllNodesWithTag(com.slopus.happy.ui.chat.MessageTags.AGENT_COPY, useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue(copies.isNotEmpty())
        assertTrue(copies.all { with(rule.density) { it.boundsInRoot.bottom.toDp() } <= control.top })
        // Only the edit stays out of the trace.
        assertEquals(1, rule.onAllNodesWithTag(TurnRowTags.TOOL, useUnmergedTree = true).fetchSemanticsNodes().size)
        val edit = row("Edit callback.ts")
        val line = edit.bounds
        assertDp("a 20 line, 6 above and below", 32.dp, line.bottom - line.top)
        val glyph = child(edit, TurnRowTags.TOOL_GLYPH).bounds
        assertBox("glyph lane", glyph, 16.dp, line.top + 6.dp + 3.dp, 14.dp, 14.dp)
        val verb = child(edit, TurnRowTags.TOOL_VERB).bounds
        assertDp("verb", 36.dp, verb.left)
        val subject = child(edit, TurnRowTags.TOOL_SUBJECT).bounds
        assertDp("subject", verb.right + 6.dp, subject.left)
        val added = child(edit, TurnRowTags.TOOL_ADDED).bounds
        val deleted = child(edit, TurnRowTags.TOOL_DELETED).bounds
        assertDp("added after the name", subject.right + 6.dp, added.left)
        assertDp("deleted after added", added.right + 6.dp, deleted.left)
        rule.onNode(hasText("+3"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("−1"), useUnmergedTree = true).assertExists()

        val end = rule.node(TurnRowTags.TURN_END).bounds
        assertDp("end row", 32.dp, end.bottom - end.top)
        val copy = rule.node(TurnRowTags.TURN_END_COPY).bounds
        assertBox("copy", copy, 14.dp, end.top + 6.dp, 20.dp, 20.dp)
        val label = rule.node(TurnRowTags.TURN_END_LABEL).bounds
        assertDp("label", copy.right + 8.dp, label.left)
        assertDp("label line", end.top + 4.dp, label.top)

        val trace = rule.node(TurnRowTags.TRACE).bounds
        assertDp("trace row", 24.dp, trace.bottom - trace.top)
        val title = rule.node(TurnRowTags.TRACE_TITLE).bounds
        assertBox("trace title", title, 16.dp, trace.top + 8.dp, title.right - title.left, 16.dp)
        shot("turn-folded-light")
    }

    @Test
    fun tappingTheControlOpensTheTurnUnderTheFingerAndFoldsItAgain() {
        setScreen()
        val before = rule.node(TurnRowTags.TRACE_TITLE).bounds
        rule.node(TurnRowTags.TRACE_TITLE).performClick()
        rule.waitForIdle()
        assertEquals(listOf("r1"), toggles)
        rule.onNode(hasText("Hide traces"), useUnmergedTree = true).assertExists()
        val after = rule.node(TurnRowTags.TRACE_TITLE).bounds
        assertDp("the control stays under the finger", before.top, after.top)
        // Every step now, in plain words.
        row("Shell grep -rn redirect sources/auth").assertExists()
        row("Explored callback.ts, session.ts").assertExists()
        row("Shell npm test -- auth").assertExists()
        rule.node(ConversationRowTags.REASONING).assertExists()
        shot("turn-open-light")

        rule.node(TurnRowTags.TRACE_TITLE).performClick()
        rule.waitForIdle()
        rule.onNode(hasText("View traces"), useUnmergedTree = true).assertExists()
        assertDp("and back", before.top, rule.node(TurnRowTags.TRACE_TITLE).bounds.top)
        assertEquals(1, rule.onAllNodesWithTag(TurnRowTags.TOOL, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    fun theCopyButtonCopiesTheFinalAnswerAndSaysSo() {
        setScreen()
        rule.node(TurnRowTags.TURN_END_COPY).performClick()
        rule.waitForIdle()
        val clipboard = ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java)
        assertEquals("Found it: the callback rewrote the URL before the cookie was written. Fixed.", clipboard.primaryClip!!.getItemAt(0).text.toString())
        rule.onNode(hasContentDescription("Final message copied"), useUnmergedTree = true).assertExists()
        rule.mainClock.advanceTimeBy(TurnRowSpec.COPIED_MILLIS + 100)
        rule.waitForIdle()
        rule.onNode(hasContentDescription("Copy final message"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun aRunningCallSpinsAndSaysItInThePresentTense() {
        setScreen(live = true)
        val line = row("Exec command is running, npm test")
        line.assertExists()
        rule.onNode(hasText("Shell"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun aFailedCallIsInkedAndMarked() {
        open = true
        setScreen()
        rule.node(ConversationScreenTags.LIST).performScrollToNode(hasTestTag(TurnRowTags.TOOL) and hasContentDescription("npm test -- auth", substring = true))
        val failed = row("Shell npm test -- auth").bounds
        val image = rule.onRoot().captureToImage().asAndroidBitmap()
        val density = image.width / 411f
        // The verb's ink is the failed line's, not textSecondary.
        val y = ((failed.top + 10.dp).value * density).toInt()
        val inks = (((failed.left + 20.dp).value * density).toInt() until ((failed.left + 80.dp).value * density).toInt()).map { image.getPixel(it, y) }
        assertTrue(inks.any { (it shr 16 and 0xff) - (it and 0xff) > 0x20 })
    }

    @Test
    fun theTurnInTheDark() {
        open = true
        setScreen(dark = true, live = true)
        shot("turn-open-dark")
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletTheRowsKeepToTheColumn() {
        setScreen(live = true)
        val list = rule.node(ConversationScreenTags.LIST).bounds
        val end = rule.node(TurnRowTags.TURN_END_LABEL).bounds
        assertTrue("the turn's end keeps to the centred column", end.left > list.left + 100.dp)
        shot("turn-tablet")
    }
}
