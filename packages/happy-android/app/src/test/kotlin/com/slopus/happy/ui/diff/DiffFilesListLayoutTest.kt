package com.slopus.happy.ui.diff

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.ui.PHONE
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

/**
 * Changes' rows beyond the line diff: the rendered Markdown diff (desktop
 * fdd502ce / 0a740497) on its own and as a changed Markdown file's first
 * face, and a line copied whole on a long press (iOS 3888ac688).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DiffFilesListLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(dark: Boolean = false, content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setHappyContent(dark) { ProvideWindowLayout { CompositionLocalProvider(LocalDiffSyntax provides null) { content() } } }
        rule.waitForIdle()
    }

    /** The diff is worked out off the main thread; idle doesn't wait for it. */
    private fun awaitView() = rule.waitUntil(10_000) { rule.onAllNodesWithTag(MarkdownDiffTags.VIEW, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun bounds(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true)[0].bounds

    @Test
    fun aWashBleedsEightPastTextThatStaysPut() {
        show { MarkdownDiffView("Kept paragraph.\n\nOld words here.", "Kept paragraph.\n\nOld words here.\n\nA new paragraph.") }
        awaitView()
        val view = rule.node(MarkdownDiffTags.VIEW).bounds
        val same = bounds(MarkdownDiffTags.SAME)
        val added = bounds(MarkdownDiffTags.ADDED)
        assertDp("unchanged text is 8 in", view.left + 8.dp, same.left)
        assertDp("the wash starts at the view's edge", view.left, added.left)
        assertDp("and ends at it", view.right, added.right)
        assertDp("its text is where unchanged text is", same.left, rule.onNodeWithText("A new paragraph.", useUnmergedTree = true).bounds.left)
    }

    @Test
    fun aLongUnchangedRunFoldsAndOpensOnTap() {
        val old = (1..8).joinToString("\n\n") { "Paragraph $it." }
        show { MarkdownDiffView(old, old.replace("Paragraph 8.", "Paragraph eight.")) }
        awaitView()
        rule.onAllNodesWithTag(MarkdownDiffTags.FOLD, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Show 5 unchanged blocks", useUnmergedTree = true).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(MarkdownDiffTags.FOLD, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(MarkdownDiffTags.SAME, useUnmergedTree = true).assertCountEquals(7)
        rule.onAllNodesWithTag(MarkdownDiffTags.CHANGED, useUnmergedTree = true).assertCountEquals(1)
    }

    @Test
    fun aChangedMarkdownFileOpensRenderedAndSwitchesToItsLines() {
        val items = listOf(
            DiffFileItem(
                "README.md", FileChangeKind.Modified, 1, 1,
                source = DiffSource.Contents("README.md", "# Happy\n\nThe quick brown fox.\n", "# Happy\n\nThe quick red fox.\n"),
            ),
        )
        show { DiffFilesList(items) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(MarkdownDiffTags.CHANGED, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithTag(DiffTags.MARKDOWN_FACE, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Rendered").assertIsSelected()
        rule.onAllNodesWithTag(DiffTags.COPYABLE, useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("Diff", useUnmergedTree = true).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(MarkdownDiffTags.CHANGED, useUnmergedTree = true).assertCountEquals(0)
        assertTrue(rule.onAllNodesWithTag(DiffTags.COPYABLE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    @Test
    fun anAddedMarkdownFileHasOnlyItsLines() {
        val items = listOf(DiffFileItem("NEW.md", FileChangeKind.Added, 1, 0, source = DiffSource.Contents("NEW.md", "", "# New\n")))
        show { DiffFilesList(items) }
        rule.onAllNodesWithTag(DiffTags.MARKDOWN_FACE, useUnmergedTree = true).assertCountEquals(0)
        assertTrue(rule.onAllNodesWithTag(DiffTags.COPYABLE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    /** iOS 3888ac688: a long press on a Changes code line offers Copy, which takes the whole line. */
    @Test
    fun aChangesLineCopiesWholeOnALongPress() {
        val items = listOf(
            DiffFileItem(
                "a.kt", FileChangeKind.Modified, 1, 1,
                source = DiffSource.Contents("a.kt", "val a = 1\n", "val a = 2\n"),
            ),
        )
        show { DiffFilesList(items) }
        rule.waitForIdle()
        val lines = rule.onAllNodesWithTag(DiffTags.COPYABLE, useUnmergedTree = true)
        lines.assertCountEquals(2)
        lines[1].performTouchInput { longClick() }
        rule.waitForIdle()
        rule.onNodeWithText("Copy", useUnmergedTree = true).performClick()
        rule.waitForIdle()
        val clipboard = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(android.content.ClipboardManager::class.java)
        assertEquals("val a = 2", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    /** The rendered diff of a changed README in Changes, kept as a picture for review (build/files-screens). */
    private fun shotRenderedMarkdownDiff(dark: Boolean) {
        val old = "# Demo app\n\nA small app the test agent works on.\n\n- Greets the user\n- Logs the time\n\nRun it with `npm start`.\n\n## License\n\nMIT\n"
        val new = "# Demo app\n\nA small app the test agent works on every day.\n\n- Greets the user by name\n- Logs the time\n- Says goodbye\n\nRun it with `npm run dev`.\n\n## License\n\nMIT\n"
        val items = listOf(DiffFileItem("README.md", FileChangeKind.Modified, 5, 3, source = DiffSource.Contents("README.md", old, new)))
        show(dark) { DiffFilesList(items) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(MarkdownDiffTags.CHANGED, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
        val dir = java.io.File("build/files-screens").apply { mkdirs() }
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        java.io.File(dir, "markdown-diff-${if (dark) "dark" else "light"}.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun shotRenderedMarkdownDiffLight() = shotRenderedMarkdownDiff(dark = false)

    @Test
    fun shotRenderedMarkdownDiffDark() = shotRenderedMarkdownDiff(dark = true)

    /** The rendered diff reads as a document: its headings step down, h1 the largest; the chat keeps its own ramp. */
    @Test
    fun aRenderedDiffsHeadingsStepDown() {
        val doc = "# One\n\n## Two\n\n### Three\n\nBody."
        show { MarkdownDiffView(doc, "$doc More.") }
        awaitView()
        val heads = rule.onAllNodesWithTag(MarkdownDiffTags.SAME, useUnmergedTree = true)
        val heights = (0 until 3).map { heads[it].bounds.height }
        assertTrue("h1 > h2 > h3: $heights", heights[0] > heights[1] && heights[1] > heights[2])
        assertEquals("the chat's h2 stays iOS's chat 20", 20f, com.slopus.happy.ui.chat.MarkdownSpec.headers[1].first.fontSize.value)
    }
}
