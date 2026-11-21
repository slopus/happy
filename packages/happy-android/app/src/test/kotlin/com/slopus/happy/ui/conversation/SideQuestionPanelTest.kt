package com.slopus.happy.ui.conversation

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.conversation.SideAnswer
import com.slopus.happy.conversation.SideExchange
import com.slopus.happy.conversation.SideThread
import com.slopus.happy.conversation.Problem
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.TOLERANCE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.GlassBarTags
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.DarkColors
import com.slopus.happy.ui.theme.LightColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlin.math.roundToInt

/**
 * The `/btw` panel over a Happy Agent chat ([SideQuestionPanel]'s spec):
 * under the bar where the transcript's first row rests, 12 in from the
 * column as the composer, at most 60% of the room under its top that the
 * keyboard leaves and never under the composer, scrolling inside and
 * opening at its latest answer; each answer copies alone; touches on it stop
 * at it; it takes no Back, and the chat stays usable under it. Pictures go
 * under build/conversation-screens.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SideQuestionPanelTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val clipboard get() = RuntimeEnvironment.getApplication().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private var thread by mutableStateOf<SideThread?>(null)
    private val sent = ArrayList<String>()
    private lateinit var compose: View

    private fun show(first: SideThread?, actions: SideQuestionActions = SideQuestionActions(served = { true }), dark: Boolean = false) {
        thread = first
        rule.setHappyContent(dark) {
            compose = LocalView.current
            ProvideWindowLayout {
                ConversationScreen(
                    SideQuestionFixtures.conversation(),
                    ConversationScreenActions(sideQuestions = actions, onSend = { words, _ -> sent += words; true }),
                    sideThread = thread,
                )
            }
        }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun inPanel(tag: String) = rule.onAllNodes(hasTestTag(tag) and hasAnyAncestor(hasTestTag(SideQuestionTags.PANEL)), useUnmergedTree = true)

    /** The card's own ground, above the title at mid-width: clear of its words and its rounded corners. */
    private fun cardGround(): Int {
        val card = rule.node(SideQuestionTags.PANEL).captureToImage().asAndroidBitmap()
        return card.getPixel(card.width / 2, (6 * rule.density.density).roundToInt())
    }

    /** Where the panel's top rests: the transcript's, the glass bar and its feather down. */
    private fun restingTop(): Dp = rule.node(GlassBarTags.BAR).bounds.bottom + GlassSpec.feather

    @Test fun `it rests under the bar on the composer's edges, and wraps a short thread`() {
        show(SideThread(listOf(SideQuestionFixtures.answered(response = "The retry loop in `uploader.ts`."))))
        val panel = rule.node(SideQuestionTags.PANEL).bounds
        val bar = rule.node(GlassBarTags.BAR).bounds
        assertTrue("the bar is never covered: $panel under $bar", panel.top >= bar.bottom)
        assertBox("panel", panel, 12.dp, restingTop(), (411 - 24).dp, panel.height)
        val composer = rule.node(ConversationComposerTags.PILL).bounds
        assertDp("on the composer's left edge", composer.left, panel.left)
        assertDp("and its right", composer.right, panel.right)
        // Header: the title 16 in and 14 down, close 48 at 4 in from the top end.
        val title = rule.node(SideQuestionTags.TITLE).bounds
        assertDp("title left", panel.left + 16.dp, title.left)
        assertDp("title top", panel.top + 14.dp, title.top)
        assertDp("subtitle under it", title.bottom + 2.dp, rule.node(SideQuestionTags.SUBTITLE).bounds.top)
        assertBox("close", rule.node(SideQuestionTags.CLOSE).bounds, panel.right - 4.dp - 48.dp, panel.top + 4.dp, 48.dp, 48.dp)
        // The question at the thread's end in a bubble at most 85% wide; the answer 8 under it, its copy 4 under that.
        val thread = rule.node(SideQuestionTags.THREAD).bounds
        val question = rule.node(SideQuestionTags.QUESTION).bounds
        assertDp("question at the end", thread.right - 16.dp, question.right)
        assertTrue("at most 85% wide", question.width.value <= (thread.width - 32.dp).value * 0.85f + TOLERANCE.value)
        val answer = rule.node(SideQuestionTags.ANSWER).bounds
        assertDp("answer under the question", question.bottom + 8.dp, answer.top)
        assertDp("answer from the thread's start", thread.left + 16.dp, answer.left)
        val copy = inPanel(SideQuestionTags.COPY)[0].bounds
        assertDp("copy under the answer", answer.bottom + 4.dp, copy.top)
        assertDp("copy at the answer's start", answer.left, copy.left)
        // The field 12 in, Ask 36 after it, 2 above the row's foot.
        val field = rule.node(SideQuestionTags.FIELD).bounds
        val ask = rule.node(SideQuestionTags.ASK).bounds
        assertDp("field left", panel.left + 12.dp, field.left)
        assertTrue("field at least 40", field.height.value >= 40f - TOLERANCE.value)
        assertBox("ask", ask, panel.right - 12.dp - 36.dp, panel.bottom - 12.dp - 2.dp - 36.dp, 36.dp, 36.dp)
        assertDp("ask 8 after the field", field.right + 8.dp, ask.left)
        // A short thread is its own height, well under the cap.
        assertTrue("wraps: $panel", panel.height.value < (891.dp - restingTop()).value * SideQuestionSpec.MAX_SHARE)
        assertEquals("the light card's ground", LightColors.surfaceHigh.toArgb(), cardGround())
        shot("side-question-short")
    }

    @Test fun `touches on it stop at it and never reach the chat under it`() {
        var under = 0
        rule.setHappyContent {
            Box(Modifier.fillMaxSize()) {
                // The chat under the panel.
                Box(Modifier.fillMaxSize().clickable { under++ }.testTag(UNDER))
                SideQuestionPanel(
                    SideThread(listOf(SideQuestionFixtures.answered(response = "The retry loop in `uploader.ts`."))),
                    SideQuestionActions(served = { true }),
                    top = 100.dp,
                    keyboard = rememberKeyboardLift(),
                    bubble = userMessageBubblePalette(null, false),
                    dock = { 0 },
                )
            }
        }
        rule.waitForIdle()
        // Its words, and the room above the follow-up field.
        rule.node(SideQuestionTags.TITLE).performClick()
        rule.node(SideQuestionTags.SUBTITLE).performClick()
        val panel = rule.node(SideQuestionTags.PANEL)
        val above = rule.node(SideQuestionTags.FIELD).bounds.top - panel.bounds.top - 6.dp
        panel.performTouchInput { click(Offset(width / 2f, above.toPx())) }
        rule.waitForIdle()
        assertEquals("nothing reached the chat", 0, under)
        // Under it, the chat takes the tap.
        rule.node(UNDER).performTouchInput { click(Offset(width / 2f, height - 20f)) }
        rule.waitForIdle()
        assertEquals(1, under)
    }

    @Test fun `a long thread takes at most 60 percent of the room under its top, scrolls inside, and opens at its latest answer`() {
        show(SideQuestionFixtures.long())
        val panel = rule.node(SideQuestionTags.PANEL).bounds
        val cap = maxOf(SideQuestionSpec.minHeight.value, (891.dp - restingTop()).value * SideQuestionSpec.MAX_SHARE).dp
        assertDp("its cap", cap, panel.height)
        val thread = rule.node(SideQuestionTags.THREAD).bounds
        val questions = inPanel(SideQuestionTags.QUESTION)
        val count = questions.fetchSemanticsNodes().size
        assertEquals(SideQuestionFixtures.LONG, count)
        assertTrue("the first has scrolled away under the header", questions[0].bounds.bottom < thread.top)
        val lastCopy = inPanel(SideQuestionTags.COPY)[count - 1].bounds
        assertTrue("the latest answer is in view: $lastCopy in $thread", lastCopy.bottom <= thread.bottom + TOLERANCE && lastCopy.top >= thread.top)
        // The composer and the transcript under the panel are still there, clear of it.
        assertTrue(rule.node(ConversationComposerTags.PILL).bounds.top > panel.bottom)
        rule.node(ConversationScreenTags.LIST).assertExists()
        shot("side-question-long")
    }

    @Test @Config(qualifiers = PHONE, sdk = [35])
    fun `the keyboard is not room it may take`() {
        show(SideQuestionFixtures.long())
        val density = compose.resources.displayMetrics.density
        val keyboardPx = 900
        val navigationPx = 63
        rule.runOnUiThread {
            compose.rootView.dispatchApplyWindowInsets(
                WindowInsets.Builder()
                    .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, navigationPx))
                    .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, keyboardPx))
                    .setVisible(WindowInsets.Type.ime(), true)
                    .build(),
            )
        }
        rule.waitForIdle()
        val panel = rule.node(SideQuestionTags.PANEL).bounds
        val room = 891.dp - restingTop() - (keyboardPx / density).dp
        assertDp("60% of what the keyboard leaves", maxOf(SideQuestionSpec.minHeight.value, room.value * SideQuestionSpec.MAX_SHARE).dp, panel.height)
        assertTrue("clear of the keyboard", panel.bottom.value < 891 - keyboardPx / density)
        shot("side-question-keyboard")
    }

    @Test @Config(qualifiers = "w891dp-h411dp-land-xxhdpi", sdk = [35])
    fun `on its side with the keyboard up it ends above the composer, its field in view`() {
        show(SideQuestionFixtures.long())
        rule.runOnUiThread {
            compose.rootView.dispatchApplyWindowInsets(
                WindowInsets.Builder()
                    .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, 450))
                    .setVisible(WindowInsets.Type.ime(), true)
                    .build(),
            )
        }
        rule.waitForIdle()
        val panel = rule.node(SideQuestionTags.PANEL).bounds
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        val field = rule.node(SideQuestionTags.FIELD).bounds
        assertTrue("above the composer: $panel over $composer", panel.bottom <= composer.top + TOLERANCE)
        assertTrue("the 160 gave way: $panel", panel.height < SideQuestionSpec.minHeight)
        assertTrue("its field in view: $field in $panel", field.top >= panel.top - TOLERANCE && field.bottom <= panel.bottom + TOLERANCE)
        shot("side-question-landscape-keyboard")
    }

    @Test fun `copy takes the answer alone`() {
        show(SideThread(listOf(SideQuestionFixtures.answered())))
        inPanel(MessageTags.AGENT_COPY)[0].performClick()
        rule.waitForIdle()
        assertEquals(SideQuestionFixtures.ANSWER, clipboard.primaryClip!!.getItemAt(0).text.toString())
    }

    @Test fun `a canned answer is said as it is, with nothing to copy`() {
        show(SideThread(listOf(SideExchange("Which file?", SideAnswer.Answered("I can't answer that from here.", synthetic = true)))))
        rule.onNode(hasText("I can't answer that from here.") and hasTestTag(SideQuestionTags.LINE), useUnmergedTree = true).assertExists()
        assertTrue(inPanel(SideQuestionTags.COPY).fetchSemanticsNodes().isEmpty())
        assertTrue(inPanel(SideQuestionTags.ANSWER).fetchSemanticsNodes().isEmpty())
    }

    @Test fun `it says what keeps an answer away, plainly`() {
        show(SideQuestionFixtures.states())
        listOf(
            "Claude is answering…",
            "Waiting for the answer above…",
            "Claude Code has nothing to answer from in this chat yet. Send a message first; after that, /btw works even while Claude is busy.",
            "This chat's model can't answer side questions.",
            "This side question is no longer available. Ask it again.",
            "Could not reach the agent. Check its connection and try again.",
            "Claude had no answer.",
        ).forEach { rule.onNode(hasText(it) and hasTestTag(SideQuestionTags.LINE), useUnmergedTree = true).assertExists() }
        rule.onNode(hasText("Couldn’t get an answer: Rate limited.") and hasTestTag(SideQuestionTags.FAILURE), useUnmergedTree = true).assertExists()
        shot("side-question-states")
    }

    @Test fun `close ends the thread, and Back is left to leave the chat`() {
        var closed = 0
        show(SideThread(listOf(SideQuestionFixtures.answered())), SideQuestionActions(served = { true }, onClose = { closed++ }))
        val withPanel = rule.activity.onBackPressedDispatcher.hasEnabledCallbacks()
        thread = null
        rule.waitForIdle()
        val without = rule.activity.onBackPressedDispatcher.hasEnabledCallbacks()
        assertEquals("the panel takes no Back of its own", without, withPanel)
        assertEquals(0, closed)
        thread = SideThread(listOf(SideQuestionFixtures.answered()))
        rule.waitForIdle()
        rule.node(SideQuestionTags.CLOSE).performClick()
        assertEquals(1, closed)
    }

    @Test fun `the follow-up field asks what is typed, and Ask waits for words`() {
        val asked = ArrayList<String>()
        show(
            SideThread(listOf(SideQuestionFixtures.answered())),
            SideQuestionActions(
                served = { true },
                onDraftChange = { draft -> thread = thread?.copy(draft = draft) },
                onAskDraft = {
                    val now = thread!!
                    asked += now.draft.trim()
                    thread = now.copy(draft = "", exchanges = now.exchanges + SideExchange(now.draft.trim(), SideAnswer.Queued))
                },
            ),
        )
        rule.node(SideQuestionTags.ASK).assertIsNotEnabled()
        rule.node(SideQuestionTags.FIELD).performTextInput("And the tests?")
        rule.waitForIdle()
        assertEquals("And the tests?", thread!!.draft)
        rule.node(SideQuestionTags.ASK).assertIsEnabled().performClick()
        rule.waitForIdle()
        assertEquals(listOf("And the tests?"), asked)
        assertEquals("", rule.node(SideQuestionTags.FIELD).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        rule.onNode(hasText("Waiting for the answer above…"), useUnmergedTree = true).assertExists()
        rule.node(SideQuestionTags.ASK).assertIsNotEnabled()
    }

    @Test fun `the chat and its composer stay usable while it is open`() {
        show(SideThread(listOf(SideQuestionFixtures.answered())))
        rule.node(ConversationComposerTags.INPUT).performTextInput("Ship it")
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("Ship it"), sent)
        rule.node(SideQuestionTags.PANEL).assertExists()
    }

    @Test fun `in the dark it is the dark theme's card`() {
        show(SideThread(listOf(SideQuestionFixtures.answered())), dark = true)
        assertEquals(DarkColors.surfaceHigh.toArgb(), cardGround())
        shot("side-question-dark")
    }

    @Test fun `with no thread there is no panel`() {
        show(null)
        assertFalse(rule.onAllNodesWithTag(SideQuestionTags.PANEL, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    private companion object {
        /** What stands for the chat under the panel in a test of touches alone. */
        const val UNDER = "test.under"
    }
}
