package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.DeliveryTags
import com.slopus.happy.ui.chat.MessageSpec
import com.slopus.happy.ui.chat.MessageTags
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
import kotlin.math.abs

/**
 * A person's message shows whole; only one past [UserFold.FOLD_LINES] (70)
 * lines folds behind Show full (iOS 3928f0f21); each test writes its
 * picture under build/conversation-screens.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UserFoldTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Release notes", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val long = (1..100).joinToString("\n") { "Step $it of the plan" }
    private val opens = ArrayList<String>()

    private fun user(key: String, text: String) =
        ConversationRow.User(key, key.substringBefore(':'), text, parseMarkdown(text), emptyList(), Delivery.Sent, 1_755_400_000_000)

    private fun answer(key: String, text: String) = ConversationRow.Text(key, text, parseMarkdown(text))

    /** [rows], newest first; a tap on a fold opens or cuts it back as the screen would. */
    private fun show(vararg rows: ConversationRow, dark: Boolean = false) {
        var shown by mutableStateOf(rows.toList())
        rule.setHappyContent(dark) {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = shown, agent = agent),
                null,
                ConversationScreenActions(
                    onToggleMessage = { key ->
                        opens += key
                        shown = shown.map { if (it is ConversationRow.User && it.key == key) it.copy(opened = !it.opened) else it }
                    },
                ),
            )
        }
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun near(message: String, expected: Dp, actual: Dp, slack: Dp = 1.dp) =
        assertTrue("$message: $actual, not $expected", abs((expected - actual).value) <= slack.value)

    @Test fun `past seventy lines the bubble shows seventy, Show full 8 under them, and the time on its line`() {
        show(user("m1:user", long))
        val control = rule.node(ConversationRowTags.USER_FOLD)
        control.assertTextEquals("Show full")
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        val fold = control.bounds
        // Seventy lines, each its own paragraph (8 over, 25 tall, 10 under), over the 8 gap and the 16 line, in the bubble's padding.
        val top = bubble.top + MessageSpec.bubblePaddingVertical
        near("cut at the seventieth line's foot, 8 over the control", (8 + 69 * 43 + 25 + 8).dp, fold.top - top)
        assertDp("control line", 16, fold.height)
        near("bubble foot", fold.bottom + MessageSpec.bubblePaddingVertical, bubble.bottom)
        // Step 30 is not drawn, but read: a screen reader has it whole.
        rule.onNodeWithText("Step 100 of the plan", substring = true, useUnmergedTree = true).assertExists()
        // The time rides on the control's line.
        val status = rule.node(DeliveryTags.STATUS).bounds
        assertTrue("time on the control's line: $status vs $fold", status.bottom > fold.top && status.top < fold.bottom)
        assertTrue("time right of the control", status.left > fold.right)
        shot("user-fold-cut")
    }

    @Test fun `a tap on the bubble opens it down to the end and another cuts it back, the same width`() {
        show(user("m1:user", long))
        val cut = rule.node(MessageTags.USER_BUBBLE).bounds
        rule.node(MessageTags.USER_BUBBLE).assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Button))
        rule.node(MessageTags.USER_BUBBLE).performClick()
        rule.waitForIdle()
        assertEquals(listOf("m1:user"), opens)
        rule.node(ConversationRowTags.USER_FOLD).assertTextEquals("Show less")
        val open = rule.node(MessageTags.USER_BUBBLE).bounds
        assertDp("as wide open as cut", cut.width, open.width)
        assertTrue("taller open: ${open.height} vs ${cut.height}", open.height > cut.height + 400.dp)
        shot("user-fold-open")
        rule.node(MessageTags.USER_BUBBLE).performClick()
        rule.waitForIdle()
        rule.node(ConversationRowTags.USER_FOLD).assertTextEquals("Show full")
        assertDp("cut back", cut.height, rule.node(MessageTags.USER_BUBBLE).bounds.height)
    }

    @Test fun `opened, it grows down from its top, the row over it staying put`() {
        // History above it, so the list has somewhere to go.
        val older = (1..12).map { answer("h$it:0", "Earlier answer $it, a line or two of it to read.") }
        show(user("m1:user", long), answer("a:0", "Ready when you are."), *older.toTypedArray())
        // Seventy lines are taller than the screen, so the row over it is out of sight: the bubble's top stands for it.
        val top = rule.node(MessageTags.USER_BUBBLE).bounds.top
        rule.node(MessageTags.USER_BUBBLE).performClick()
        rule.waitForIdle()
        assertDp("bubble top", top, rule.node(MessageTags.USER_BUBBLE).bounds.top)
        shot("user-fold-opened-in-place")
    }

    @Test fun `an ordinary paste of thirty lines shows whole, the plain bubble a tap does nothing to, and a hold still copies`() {
        show(user("m1:user", (1..30).joinToString("\n") { "Line $it" }))
        rule.node(ConversationRowTags.USER_FOLD).assertDoesNotExist()
        rule.node(MessageTags.USER_BUBBLE).assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
        rule.node(MessageTags.USER_BODY).assert(SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick))
        assertTrue(opens.isEmpty())
    }

    @Test fun `a wrapped paragraph and code count their own lines`() {
        // Seventy-one: six of words wrapped in the bubble, then sixty-five of code.
        val words = List(6) { "word" }.joinToString(" ") { it.repeat(6) }
        show(user("m1:user", "$words\n\n```\n${(1..65).joinToString("\n") { "line($it)" }}\n```"))
        rule.node(ConversationRowTags.USER_FOLD).assertTextEquals("Show full")
        shot("user-fold-code")
    }

    @Test fun `folded, a hold still copies the whole message`() {
        show(user("m1:user", long))
        rule.node(MessageTags.USER_BUBBLE).assert(SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick))
    }

    @Test fun `dark, the control is the secondary ink`() {
        show(user("m1:user", long), dark = true)
        rule.node(ConversationRowTags.USER_FOLD).assertTextEquals("Show full")
        shot("user-fold-dark")
    }
}
