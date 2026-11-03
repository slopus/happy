package com.slopus.happy.ui.references

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.References
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.LinkTags
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.DrawnSegment
import com.slopus.happy.ui.conversation.ProseKind
import com.slopus.happy.ui.conversation.ProseSource
import com.slopus.happy.ui.conversation.ProseTags
import com.slopus.happy.ui.conversation.Typesetter
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
 * Happy references in a Happy Agent chat (iOS d95fc8b0f): an agent's tags
 * read as the live names of what they name, underlined; a tap opens the
 * reference through the app's own opener, never the browser, and offers no
 * link menu; a person is set apart in the strong face and opens nothing.
 * Pictures go under build/reference-screens.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReferenceRowsTest {
    @get:Rule
    val rule = createComposeRule()

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val typesetter: Typesetter get() = Typesetter.of(context)
    private val agent = AgentInfo("a1", "w1", null, "Launch plan", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val references = References(
        agents = mapOf("as" to References.Entity("Guest list template", "as")),
        artifacts = mapOf("r1" to References.Artifact.Active("Q3 revenue report", "markdown", 2)),
        users = mapOf("u1" to "Steve"),
    )
    private val message = Message(
        "m", "agent", 1,
        listOf(Block.Text("I put the numbers in <happy-artifact id=\"r1\"/> and started <happy-agent id=\"as\"/> for <happy-user id=\"u1\"/>. <happy-artifact id=\"gone\"/> is still being read.")),
    )
    private val row = ConversationRowBuilder.build(message, "a1", null, false, references = references).single() as ConversationRow.Text

    private class Calls {
        val app = ArrayList<String>()
        val browsed = ArrayList<String>()
    }

    private fun show(calls: Calls, dark: Boolean = false) {
        rule.setHappyContent(dark) {
            val opener = LinkOpener.agent(context, "Studio", app = { url -> HappyReferences.opensInApp(url).also { if (it) calls.app += url } }) { calls.browsed += it }
            ProvideLinks(opener) {
                ConversationScreen(ConversationState(created = true, loaded = true, rows = listOf(row), agent = agent), null, ConversationScreenActions())
            }
        }
    }

    private fun shot(name: String) {
        val dir = File("build/reference-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Where [words] sit on the drawn paragraph, in its segment's pixels. */
    private fun point(words: String): Offset {
        val prose = typesetter.prose(ProseSource(row.key, ProseKind.Answer, row.text, row.blocks), typesetter.geometry.at(Density(context), false))
        val segment = prose.segments.first() as DrawnSegment
        val piece = segment.parts.first().pieces.single()
        val box = piece.layout.getBoundingBox(piece.text.text.indexOf(words) + 1)
        return Offset(piece.x + box.center.x, segment.tops[0] + piece.y + box.center.y)
    }

    @Test fun `the tags read as names, and an artifact's opens in the app`() {
        val calls = Calls()
        show(calls)
        assertEquals(
            "I put the numbers in Q3 revenue report and started Guest list template for @Steve. artifact is still being read.",
            row.text,
        )
        shot("references-chat")
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { click(point("Q3 revenue")) }
        rule.waitForIdle()
        assertEquals(listOf(HappyReferences.Reference("artifact", "r1")), calls.app.map { HappyReferences.reference(it) })
        assertTrue("never the browser", calls.browsed.isEmpty())
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { click(point("Guest list")) }
        rule.waitForIdle()
        assertEquals(HappyReferences.Reference("agent", "as"), HappyReferences.reference(calls.app.last()))
    }

    @Test fun `a reference has no link menu, and a person opens nothing`() {
        val calls = Calls()
        show(calls)
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { longClick(point("Q3 revenue")) }
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithTag(LinkTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertTrue("a long press is not a tap", calls.app.isEmpty())
        rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0].performTouchInput { click(point("@Steve")) }
        rule.waitForIdle()
        assertTrue(calls.app.isEmpty() && calls.browsed.isEmpty())
        val prose = typesetter.prose(ProseSource(row.key, ProseKind.Answer, row.text, row.blocks), typesetter.geometry.at(Density(context), false))
        val text = (prose.segments.first() as DrawnSegment).parts.first().pieces.single().text
        val at = text.text.indexOf("@Steve")
        assertTrue("a mention is in the strong face", text.spanStyles.any { it.start <= at && it.end > at && it.item.fontWeight == FontWeight.SemiBold })
        assertTrue("and no link", text.getLinkAnnotations(at, at + 1).isEmpty())
    }

    @Test fun `dark`() {
        show(Calls(), dark = true)
        shot("references-chat-dark")
    }
}
