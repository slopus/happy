package com.slopus.happy.ui.conversation

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.LiftSelected
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageLiftTags
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Code in a Happy Agent chat, as desktop's (3365ef9f, 3e08585d): a fenced
 * block offers a quiet copy icon that is a check for 1.6 s, and a long
 * press on inline code takes the span whole. Pictures go under
 * build/conversation-screens.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CodeCopyTest {
    @get:Rule
    val rule = createComposeRule()

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val typesetter: Typesetter get() = Typesetter.of(context)
    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val clipboard get() = RuntimeEnvironment.getApplication().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private val markdown = """
        Run `npm test -- --watch` before you push.

        ```ts
        await setSession(token)
        redirect(next)
        ```
    """.trimIndent()
    private val answer = ConversationRow.Text("a:0", markdown, parseMarkdown(markdown))

    @After fun relax() {
        ProseSelection.selected = null
        LiftSelected.selected = null
    }

    private fun showScreen(dark: Boolean = false) {
        rule.setHappyContent(dark) {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = listOf(answer), agent = agent), ConversationScreenActions())
        }
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun said(label: String) = SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(label))

    /** Where inline code sits on the drawn paragraph, in its segment's pixels. */
    private fun codePoint(): Offset {
        val prose = typesetter.prose(ProseSource(answer.key, ProseKind.Answer, answer.text, answer.blocks), typesetter.geometry.at(Density(context), false))
        val segment = prose.segments.first() as DrawnSegment
        val piece = segment.parts.first().pieces.single()
        val box = piece.layout.getBoundingBox(piece.text.text.indexOf("test"))
        return Offset(piece.x + box.center.x, segment.tops[0] + piece.y + box.center.y)
    }

    @Test fun `a fenced block's copy is a 24 icon 6 in from its corner, a check for 1·6 s once copied`() {
        showScreen()
        rule.onNodeWithText("Copy").assertDoesNotExist()
        val block = rule.node(MarkdownTags.CODE_BLOCK).bounds
        val glyph = rule.node(MarkdownTags.CODE_COPY_GLYPH).bounds
        assertDp("glyph", 14, glyph.width)
        // The 24 box sits 6 in from the top and right: the 14 glyph 5 inside it.
        assertDp("from the right", 6 + 5, block.right - glyph.right)
        assertDp("from the top", 6 + 5, glyph.top - block.top)
        val copy = rule.node(MarkdownTags.CODE_COPY)
        copy.assert(said("Copy code"))
        assertDp("reached 40 around", 40, copy.bounds.height)
        shot("code-copy-icon")
        copy.performClick()
        rule.waitForIdle()
        assertEquals("await setSession(token)\nredirect(next)", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        rule.node(MarkdownTags.CODE_COPY).assert(said("Copied"))
        shot("code-copy-copied")
        rule.mainClock.advanceTimeBy(1_450)
        rule.node(MarkdownTags.CODE_COPY).assert(said("Copied"))
        rule.mainClock.advanceTimeBy(200)
        rule.waitForIdle()
        rule.node(MarkdownTags.CODE_COPY).assert(said("Copy code"))
    }

    @Test fun `dark, the icon is on the code's own colour`() {
        showScreen(dark = true)
        rule.node(MarkdownTags.CODE_COPY).assert(said("Copy code"))
        shot("code-copy-icon-dark")
    }

    @Test fun `outside a Happy Agent chat the block keeps its Copy pill`() {
        rule.setHappyContent { ConversationRowView(answer, userMessageBubblePalette(null, false), ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) })) }
        rule.onNodeWithText("Copy", useUnmergedTree = true).assertExists()
        rule.node(MarkdownTags.CODE_COPY_GLYPH).assertDoesNotExist()
    }

    @Test fun `a long press on inline code selects the span whole, not its word`() {
        val selected = ArrayList<String>()
        ProseSelection.selected = { selected += it }
        // No lift here: the answer selects in place.
        rule.setHappyContent { ConversationRowView(answer, userMessageBubblePalette(null, false), ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) })) }
        val at = codePoint()
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { longClick(at) }
        rule.mainClock.advanceTimeBy(200)
        rule.waitForIdle()
        assertEquals(listOf("npm test -- --watch"), selected)
    }

    @Test fun `held on inline code, the lift's Select takes the span whole`() {
        val selected = ArrayList<String>()
        LiftSelected.selected = { selected += it }
        showScreen()
        val at = codePoint()
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { longClick(at) }
        rule.waitForIdle()
        rule.node(MessageLiftTags.SELECT).performClick()
        rule.waitForIdle()
        assertEquals(listOf("npm test -- --watch"), selected)
        shot("code-inline-selected")
    }

    @Test fun `held elsewhere, Select still takes everything`() {
        val selected = ArrayList<String>()
        LiftSelected.selected = { selected += it }
        showScreen()
        val at = codePoint()
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { longClick(Offset(8f, at.y)) }
        rule.waitForIdle()
        rule.node(MessageLiftTags.SELECT).performClick()
        rule.waitForIdle()
        assertEquals(1, selected.size)
        assertEquals(true, selected.single().startsWith("Run npm test -- --watch before you push."))
    }
}
