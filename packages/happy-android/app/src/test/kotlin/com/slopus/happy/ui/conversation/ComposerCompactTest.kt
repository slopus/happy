package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.bounds
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
 * The full card goes to one row once it would leave the transcript under 120
 * (iOS ac81745ac): a phone held sideways with the keyboard up, here a 260 dp
 * tall window, as the keyboard leaves it.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerCompactTest {
    @get:Rule val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")
    private val catalog = ModeCatalog(
        listOf(ModelChoice("claude", "Current CLI", "claude", "anthropic/opus-5", "Opus 5 1M", listOf("low", "high"), "high", emptyList())),
        mode,
    )
    private val rows = (1..30).map { ConversationRow.Text("t$it", "Line $it of a long answer", parseMarkdown("Line $it of a long answer")) }

    private fun show() {
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog), ConversationScreenActions())
        }
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
    }

    /** Between the bar's foot and the pill's top. */
    private fun transcript(): Dp = rule.node(ConversationComposerTags.PILL).bounds.top - rule.node(ConversationScreenTags.BAR).bounds.bottom

    private fun pill(): Dp = rule.node(ConversationComposerTags.PILL).bounds.height

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Config(qualifiers = "w731dp-h260dp-xxhdpi")
    @Test fun `sideways with the keyboard up it is one row, two lines then scrolling, and typing never brings the card back`() {
        show()
        assertEquals("one row", 48f, pill().value, 1f)
        val room = transcript()
        assertTrue("the transcript keeps more than the full card would leave: $room", room > 120.dp - 103.dp)
        rule.node(ConversationComposerTags.INPUT).performTextInput("First line\nSecond line")
        rule.waitForIdle()
        val two = pill()
        assertTrue("two lines show: $two", two > 48.dp)
        rule.node(ConversationModeTags.MODEL).assertExists()
        rule.node(ConversationComposerTags.EXPAND).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).performTextInput("\nThird line")
        rule.waitForIdle()
        assertEquals("the third scrolls", two.value, pill().value, 1f)
        rule.node(ConversationComposerTags.EXPAND).assertExists()
        // Send stays at the row's foot.
        val send = rule.node(ConversationComposerTags.PRIMARY).bounds
        val pillBox = rule.node(ConversationComposerTags.PILL).bounds
        assertEquals(pillBox.bottom.value - 6f, send.bottom.value, 1.5f)
        shot("composer-compact-sideways")
    }

    @Config(qualifiers = "w731dp-h411dp-xxhdpi")
    @Test fun `sideways with the keyboard down the full card stays, the transcript over 120`() {
        show()
        assertTrue("full card: ${pill()}", pill() > 90.dp)
        assertTrue("transcript ${transcript()}", transcript() >= 120.dp)
    }

    @Config(qualifiers = "w411dp-h731dp-xxhdpi")
    @Test fun `upright it is the full card`() {
        show()
        assertTrue("full card: ${pill()}", pill() > 90.dp)
    }
}
