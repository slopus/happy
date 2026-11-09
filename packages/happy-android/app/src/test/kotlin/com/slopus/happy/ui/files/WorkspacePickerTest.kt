package com.slopus.happy.ui.files

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.attach.AttachTags
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
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
 * The attach sheet's Workspace source (F10): in an agent conversation the
 * File tab can name a file already on the computer. The picker walks the
 * workspace a folder at a time, back goes up one, and a picked file goes
 * into the composer's words as `./path`, the sheet closing with nothing
 * uploaded.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkspacePickerTest {
    @get:Rule val rule = createComposeRule()

    private val mode = Mode("claude", "opus", "high", null, "auto")
    private val catalog = ModeCatalog(listOf(ModelChoice("claude", "Claude", "claude", "opus", "Opus", listOf("low", "high"), "high", emptyList())), mode)
    private fun agent(workspaceId: String?) = AgentInfo("a1", workspaceId, null, "Fix it", "idle", null, null, 1, 2, 0, 0)

    private val tree = mapOf(
        "" to listOf(WorkspaceFiles.Entry("README.md", "README.md", false, 120), WorkspaceFiles.Entry("src", "src", true, 0)),
        "src" to listOf(WorkspaceFiles.Entry("main.kt", "src/main.kt", false, 2048)),
    )
    private val asked = ArrayList<String>()
    private val source = WorkspaceSource("demo-app") { path, _ ->
        asked += path
        WorkspaceFiles.Page(tree.getValue(path), null)
    }

    private fun show(workspaceId: String?, draft: String = "", drafts: MutableList<String> = ArrayList(), dark: Boolean = false) {
        rule.setHappyContent(dark) {
            ConversationScreen(
                ConversationState(created = true, loaded = true, agent = agent(workspaceId), mode = mode, catalog = catalog, draft = draft, draftArrivals = 1),
                ConversationScreenActions(onDraftChange = { drafts += it }, workspace = { id -> assertEquals("w1", id); source }),
                opensAttach = true,
            )
        }
        rule.waitForIdle()
        rule.node(AttachTags.tab(AttachTabKind.Files)).performClick()
        rule.waitForIdle()
    }

    private fun shot(tag: String, name: String) {
        val dir = File("build/files-screens").apply { mkdirs() }
        rule.mainClock.advanceTimeBy(1_000)
        val bitmap = rule.node(tag).captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun back() = rule.onNode(hasTestTag(HeaderTags.LEFT) and hasAnyAncestor(hasTestTag(WorkspacePickerTags.PICKER))).performClick()

    @Test fun `a picked workspace file goes into the words as its path and the sheet closes`() {
        val drafts = ArrayList<String>()
        show("w1", draft = "look at", drafts = drafts)
        rule.node(AttachTags.WORKSPACE).performClick()
        rule.waitForIdle()
        rule.node(WorkspacePickerTags.PICKER).assertExists()
        rule.onNodeWithText("demo-app").assertExists()
        rule.onNodeWithText("src").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("main.kt").performClick()
        rule.mainClock.advanceTimeBy(2_000)
        rule.waitForIdle()
        rule.node(WorkspacePickerTags.PICKER).assertDoesNotExist()
        rule.node(AttachTags.SHEET).assertDoesNotExist()
        assertEquals("look at ./src/main.kt", rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        assertEquals("look at ./src/main.kt", drafts.last())
        assertEquals(listOf("", "src"), asked)
    }

    @Test fun `back goes up a folder without reading it again, then out of the picker to the sheet`() {
        show("w1")
        rule.node(AttachTags.WORKSPACE).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("src").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("main.kt").assertExists()
        back()
        rule.waitForIdle()
        rule.onNodeWithText("README.md").assertExists()
        back()
        rule.waitForIdle()
        rule.node(WorkspacePickerTags.PICKER).assertDoesNotExist()
        rule.node(AttachTags.SHEET).assertExists()
        assertEquals(listOf("", "src"), asked)
    }

    @Test fun `a conversation with no workspace offers no Workspace source`() {
        show(null)
        rule.node(AttachTags.BROWSE).assertExists()
        rule.node(AttachTags.WORKSPACE).assertDoesNotExist()
    }

    @Test fun `the Workspace source heads the File tab`() {
        show("w1")
        assertTrue(rule.node(AttachTags.WORKSPACE).bounds.bottom <= rule.node(AttachTags.BROWSE).bounds.top + 1.dp)
        shot(AttachTags.SHEET, "attach-workspace-source-light")
    }

    @Test fun `the picker is the Files list over the sheet, dark`() {
        show("w1", dark = true)
        rule.node(AttachTags.WORKSPACE).performClick()
        rule.waitForIdle()
        shot(WorkspacePickerTags.PICKER, "workspace-picker-dark")
    }

    @Test fun `the path follows what was typed a space apart`() {
        assertEquals("./a.txt", withWorkspacePath("", "a.txt"))
        assertEquals("see ./a.txt", withWorkspacePath("see", "/a.txt"))
        assertEquals("see\n./a.txt", withWorkspacePath("see\n", "a.txt"))
    }
}
