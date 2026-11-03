package com.slopus.happy.ui.files

import android.graphics.Bitmap
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.R
import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.text.Words
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.diff.LocalDiffSyntax
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
import java.io.ByteArrayOutputStream

/**
 * The workspace browser against Telegram's document row
 * (SharedDocumentCell `VIEW_TYPE_DEFAULT`, FlickerLoadingView `FILES_TYPE`)
 * on the 411 phone, and the file viewer's Markdown and picture faces
 * (desktop's FilePreview).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkspaceFilesLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setHappyContent { ProvideWindowLayout { CompositionLocalProvider(LocalDiffSyntax provides null) { content() } } }
    }

    private val entries = listOf(
        WorkspaceFiles.Entry("sources", "sources", directory = true, size = 0),
        WorkspaceFiles.Entry("README.md", "README.md", directory = false, size = 2048),
    )

    @Test
    fun aRowIsTelegramsDocumentRow() {
        val opened = ArrayList<String>()
        show { WorkspaceFilesScreen("happy", WorkspaceFolder.State(entries, loading = false), onBack = {}, onOpen = { opened += it.path }) }
        val bar = rule.node(HeaderTags.BAR).bounds
        val rows = rule.onAllNodesWithTag(WorkspaceFilesTags.ROW, useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(2, rows.size)
        val first = rule.onAllNodesWithTag(WorkspaceFilesTags.ROW, useUnmergedTree = true)[0].bounds
        assertBox("the first row under the bar's feather, full width, 56 high", first, 0.dp, bar.bottom + GlassSpec.feather, PHONE_WIDTH.dp, 56.dp)
        val icon = rule.onAllNodesWithTag(WorkspaceFilesTags.ROW_ICON, useUnmergedTree = true)[0].bounds
        assertBox("a 40 tile, 12 in and 8 down", icon, 12.dp, first.top + 8.dp, 40.dp, 40.dp)
        val name = rule.onAllNodesWithTag(WorkspaceFilesTags.ROW_NAME, useUnmergedTree = true)[0].bounds
        assertDp("the name starts at 72", 72, name.left)
        rule.onNodeWithText("Folder", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("2.0 kB", useUnmergedTree = true).assertExists()
        val second = rule.onAllNodesWithTag(WorkspaceFilesTags.ROW, useUnmergedTree = true)[1].bounds
        assertDp("rows follow each other", first.bottom, second.top)
        rule.onNodeWithText("README.md", useUnmergedTree = true).performClick()
        rule.onNodeWithText("sources", useUnmergedTree = true).performClick()
        assertEquals(listOf("README.md", "sources"), opened)
        rule.assertActionsLabelled()
    }

    @Test
    fun loadingFlickers() {
        show { WorkspaceFilesScreen("happy", WorkspaceFolder.State(), onBack = {}, onOpen = {}) }
        rule.node(WorkspaceFilesTags.PLACEHOLDER).assertExists()
        rule.onAllNodesWithTag(WorkspaceFilesTags.ROW, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun anEmptyFolderSaysSo() {
        show { WorkspaceFilesScreen("happy", WorkspaceFolder.State(loading = false), onBack = {}, onOpen = {}) }
        rule.onNodeWithText("This folder is empty", useUnmergedTree = true).assertExists()
    }

    @Test
    fun aFailureSaysWhyWithRetry() {
        var retried = 0
        show { WorkspaceFilesScreen("happy", WorkspaceFolder.State(loading = false, error = Words.ours(R.string.workspace_unreachable)), onBack = {}, onOpen = {}, onRetry = { retried += 1 }) }
        rule.onNodeWithText("Can't reach the computer right now.", useUnmergedTree = true).assertExists()
        rule.node(WorkspaceFilesTags.RETRY).performClick()
        assertEquals(1, retried)
    }

    @Test
    fun aPageStillToComeShowsASpinnerAtTheEnd() {
        var more = 0
        show { WorkspaceFilesScreen("happy", WorkspaceFolder.State(entries, loading = false, nextCursor = "c2"), onBack = {}, onOpen = {}, onMore = { more++ }) }
        rule.node(WorkspaceFilesTags.MORE).assertExists()
        rule.waitForIdle()
        assertEquals("the end is in view, so the next page is asked for", 1, more)
    }

    @Test
    fun aMarkdownFileOpensRenderedWithItsSourceATabAway() {
        show { FileScreen(FileLoad.Loaded("# Title\n\nSome **bold** text.", null), "docs/README.md", onBack = {}) }
        rule.node(FileTags.RENDERED_TAB).assertIsSelected()
        rule.node(FileTags.RENDERED).assertExists()
        rule.onNodeWithText("Title", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Source", useUnmergedTree = true).performClick()
        rule.waitForIdle()
        rule.node(FileTags.CODE).assertExists()
        rule.onAllNodesWithTag(FileTags.DIFF_TAB, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun aSourceFileHasNoTabs() {
        show { FileScreen(FileLoad.Loaded("val a = 1\n", null), "a.kt", onBack = {}) }
        rule.onAllNodesWithTag(FileTags.TOGGLE_BAR, useUnmergedTree = true).assertCountEquals(0)
        rule.node(FileTags.CODE).assertExists()
    }

    @Test
    fun aPictureIsShownAtItsSizeNeverEnlarged() {
        val png = ByteArrayOutputStream().also { Bitmap.createBitmap(120, 60, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        val load = fileLoadOf("art/logo.png", png)
        assertTrue(load is FileLoad.Picture)
        show { FileScreen(load, "art/logo.png", onBack = {}) }
        val picture = rule.node(FileTags.PICTURE).bounds
        // 120 px on an xxhdpi phone is 40 dp: fitted to the width it would be 379.
        assertDp("its own width", 40, picture.width)
        assertDp("its own height", 20, picture.height)
        assertDp("centred", (PHONE_WIDTH.dp - 40.dp) / 2, picture.left)
    }

    @Test
    fun bytesReadAsTextBinaryOrPicture() {
        assertEquals(FileLoad.Loaded("hello\n", null), fileLoadOf("a.txt", "hello\n".toByteArray()))
        assertEquals(FileLoad.Binary, fileLoadOf("a.dat", byteArrayOf(1, 0, 2)))
        assertEquals(FileLoad.Binary, fileLoadOf("broken.png", byteArrayOf(1, 2, 3)))
    }

    /** A file is a document: iOS's document heading ramp (DocumentTokens.headingSize 30 / 24 / 20), h1 the largest. */
    @Test
    fun aMarkdownFilesHeadingsStepDown() {
        show { FileScreen(FileLoad.Loaded("# One\n\n## Two\n\n### Three\n\nBody.\n", null), "README.md", onBack = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(com.slopus.happy.ui.chat.MarkdownTags.HEADER, useUnmergedTree = true).fetchSemanticsNodes().size == 3 }
        val heads = rule.onAllNodesWithTag(com.slopus.happy.ui.chat.MarkdownTags.HEADER, useUnmergedTree = true)
        val heights = (0 until 3).map { heads[it].bounds.height }
        assertTrue("h1 > h2 > h3: $heights", heights[0] > heights[1] && heights[1] > heights[2])
        val sizes = com.slopus.happy.ui.chat.MarkdownSpec.documentHeaders.map { it.first.fontSize.value }
        assertEquals(listOf(30f, 24f, 20f, 18f, 18f, 18f), sizes)
    }

    /** desktop d122790d: the bar's download control says what pressing it did; a failed one tries again. */
    @Test
    fun theDownloadControlSaysHowItWent() {
        val written = ArrayList<android.net.Uri>()
        var fail = true
        lateinit var save: FileSave
        show {
            val scope = androidx.compose.runtime.rememberCoroutineScope()
            save = androidx.compose.runtime.remember {
                FileSave(scope) { uri -> if (fail) throw java.io.IOException("disk") else written += uri }
            }
            FileScreen(FileLoad.Binary, "out/report.zip", onBack = {}, save = save)
        }
        val picked = android.net.Uri.parse("content://saves/report.zip")
        rule.node(FileTags.SAVE).assertContentDescriptionEquals("Download")
        rule.node(FileTags.SAVE).performClick()
        assertEquals(FileSaveState.Pending, save.state)
        rule.node(FileTags.SAVE).assertContentDescriptionEquals("Downloading…")
        save.picked(null)
        rule.waitForIdle()
        assertEquals("backing out of the picker is no failure", FileSaveState.Idle, save.state)
        rule.node(FileTags.SAVE).performClick()
        save.picked(picked)
        rule.waitForIdle()
        rule.node(FileTags.SAVE).assertContentDescriptionEquals("Download failed. Tap to try again.")
        fail = false
        rule.node(FileTags.SAVE).performClick()
        save.picked(picked)
        rule.waitForIdle()
        assertEquals(FileSaveState.Saved, save.state)
        rule.node(FileTags.SAVE).assertContentDescriptionEquals("Saved")
        assertEquals(listOf(picked), written)
    }

    @Test
    fun aFailedReadOffersRetryWithoutAnAlert() {
        var retried = 0
        show { FileScreen(FileLoad.Failed(Words.ours(R.string.workspace_unreachable)), "a.txt", onBack = {}, onRetry = { retried += 1 }) }
        rule.onAllNodesWithText("OK", useUnmergedTree = true).assertCountEquals(0)
        rule.node(FileTags.RETRY).performClick()
        assertEquals(1, retried)
        rule.onAllNodesWithTag(FileTags.SAVE, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun aSaveSuggestsTheFilesType() {
        assertEquals("application/zip", saveMimeType("report.zip"))
        assertEquals("application/octet-stream", saveMimeType("Makefile"))
    }
}
