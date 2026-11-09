package com.slopus.happy.ui.conversation

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.hasTestTag
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.PHONE
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

/** A copied picture pastes from the field's menu as an attachment, as iOS's AgentInputTextView does. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerPasteTest {
    @get:Rule val rule = createComposeRule()

    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")
    private val catalog = ModeCatalog(
        listOf(ModelChoice("claude", "Current CLI", "claude", "anthropic/opus-5", "Opus 5 1M", listOf("high"), "high", emptyList())),
        mode,
    )

    private fun picture(): Uri {
        val file = File(context.cacheDir, "copied.png")
        file.outputStream().use { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return Uri.fromFile(file)
    }

    private fun copy(clip: ClipData) = context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)

    private fun show(drafts: MutableList<String>) {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, agent = agent, mode = mode, catalog = catalog),
                ConversationScreenActions(onDraftChange = { drafts += it }),
            )
        }
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
    }

    private fun words() = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    private fun pictures() = rule.onAllNodes(hasTestTag(ConversationComposerTags.PICTURE_REMOVE), useUnmergedTree = true).fetchSemanticsNodes().size

    @Test fun `a copied picture offers Paste and attaches, the words left as they were`() {
        val drafts = ArrayList<String>()
        show(drafts)
        copy(ClipData(ClipDescription("image", arrayOf("image/png")), ClipData.Item(picture())))
        val node = rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode()
        assertTrue("Paste offered", node.config.contains(SemanticsActions.PasteText))
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.PasteText)
        rule.waitUntil(5_000) { pictures() == 1 }
        assertEquals("", words())
        assertTrue(drafts.isEmpty())
    }

    @Test fun `a picture copied with its address pastes the picture alone`() {
        show(ArrayList())
        copy(ClipData(ClipDescription("image", arrayOf("image/png", ClipDescription.MIMETYPE_TEXT_PLAIN)), ClipData.Item("https://example.com/orange.png", null, picture())))
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.PasteText)
        rule.waitUntil(5_000) { pictures() == 1 }
        assertEquals("", words())
    }

    @Test fun `copied words paste as words`() {
        val drafts = ArrayList<String>()
        show(drafts)
        copy(ClipData.newPlainText("words", "just words"))
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.PasteText)
        rule.waitForIdle()
        assertEquals("just words", words())
        assertEquals(0, pictures())
    }
}
