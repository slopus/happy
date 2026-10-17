package com.slopus.happy.ui.diff

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import com.slopus.happy.diff.DiffBuilder
import com.slopus.happy.diff.DiffFile
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.syntax.SyntaxService
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.ceil

/**
 * The diff renderer against happy-app's components/diff (DiffFileView,
 * DiffChunk, DiffFileHeader, DiffFilesList, DiffImageView, DiffHeaderRight):
 * rows round(12 x 1.5) = 18 high; a gutter of ceil((digits + 2) x char
 * width) + 12 with line numbers (+ 4 without, digits at least 2); code 6
 * in; `@@` rows one line high on hunkBg; past the collapse a "Show N more
 * lines" bar padded 10; the header padded 12/9 with a 16 icon, items 8
 * apart; image panes 160 high under a label 6 above, padded 12.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DiffViewLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun file(old: String, new: String, path: String = "a.txt"): DiffFile =
        DiffBuilder.fromContents(path, old, new).files.single()

    /** Plain colour unless a test asks for syntax. */
    private fun show(syntax: SyntaxService? = null, dark: Boolean = false, content: @Composable () -> Unit) {
        rule.setHappyContent(dark) {
            CompositionLocalProvider(LocalDiffSyntax provides syntax) {
                Column(Modifier.fillMaxWidth()) { content() }
            }
        }
    }

    private fun charWidth() = 12 * 0.6f

    @Test
    fun scrollLayoutRows() {
        val f = file("a\nb\nc\n", "a\nB\nc\n")
        show { DiffFileView(f) }
        rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true).assertCountEquals(4)
        val gutter = rule.node(DiffTags.GUTTER).bounds
        // Two digits: ceil(4 x 7.2) + 12 = 41; the measured advance may round by a pixel.
        val expected = ceil(4 * charWidth()) + 12
        val width = gutter.width.value
        assertTrue("gutter $width", width >= expected - 0.5f && width <= expected + 1.5f)
        val lines = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)
        // The `@@` row, then the lines.
        assertBox("hunk", rule.node(DiffTags.HUNK).bounds, gutter.right, 0.dp, PHONE_WIDTH.dp - gutter.right, 18.dp)
        val first = lines[0].bounds
        assertBox("first line", first, gutter.right, 18.dp, PHONE_WIDTH.dp - gutter.right, 18.dp)
        assertDp("second row under the first", 36, lines[1].bounds.top)
        assertDp("gutter is as tall as the rows", 90, gutter.height)
        rule.onNodeWithText("−", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("+", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("B", useUnmergedTree = true).assertExists()
    }

    @Test
    fun withoutLineNumbersTheGutterIsTheMarker() {
        val f = file("a\n", "b\n")
        show { DiffFileView(f, showLineNumbers = false) }
        val gutter = rule.node(DiffTags.GUTTER).bounds
        val expected = ceil(2 * charWidth()) + 4
        assertTrue("gutter ${gutter.width}", gutter.width.value >= expected - 0.5f && gutter.width.value <= expected + 1.5f)
    }

    @Test
    fun hunkRowsAndCollapse() {
        val old = (1..200).joinToString("\n") { "line $it" } + "\n"
        val new = old.replace("line 5\n", "line five\n").replace("line 150\n", "line 150!\n")
        val f = file(old, new)
        show { DiffFileView(f, collapseAfter = 10) }
        // Two hunks; each header says how much it skipped.
        val hunks = rule.onAllNodesWithTag(DiffTags.HUNK, useUnmergedTree = true)
        hunks.assertCountEquals(2)
        assertDp("hunk row", 18, hunks[0].bounds.height)
        rule.onAllNodesWithText("···", useUnmergedTree = true).assertCountEquals(2)
        val bar = rule.node(DiffTags.SHOW_MORE).bounds
        assertBox("show more", bar, 0.dp, bar.top, PHONE_WIDTH.dp, bar.height)
        assertTrue("bar padded 10 around 13 text: ${bar.height}", bar.height.value in 36f..42f)
        rule.onNodeWithText("Show 8 more lines").assertExists()
        rule.node(DiffTags.SHOW_MORE).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(DiffTags.SHOW_MORE, useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("line 150!", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("⋯ 138 unchanged", substring = true, useUnmergedTree = true).assertExists()
    }

    @Test
    fun scrollLayoutSlidesLongLines() {
        val long = "x".repeat(200)
        val f = file("a\n", "$long\n")
        show { DiffFileView(f) }
        val line = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)[1].bounds
        val expected = ceil((200 + 2) * charWidth()) + 8
        assertTrue("content ${line.width}", line.width.value >= expected - 2 && line.width.value <= expected + 205 * 0.34f)
        assertDp("still one line", 18, line.height)
    }

    @Test
    fun wrapLayoutGrowsRows() {
        val long = "word ".repeat(80)
        val f = file("a\n", "$long\n")
        show { DiffFileView(f, layout = DiffLayoutMode.Wrap) }
        val lines = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)
        assertDp("short line", 18, lines[0].bounds.height)
        val wrapped = lines[1].bounds
        assertTrue("wrapped ${wrapped.height}", wrapped.height.value >= 36f && wrapped.height.value % 18f < 0.5f)
        assertTrue("within the screen", wrapped.right.value <= PHONE_WIDTH + 0.5f)
    }

    @Test
    fun splitLayoutPairsSides() {
        val f = file("a\nb\n", "a\nc\nd\n")
        show { DiffFileView(f, layout = DiffLayoutMode.Split) }
        // ctx a | a, del b | add c, filler | add d.
        rule.onAllNodesWithTag(DiffTags.SPLIT_ROW, useUnmergedTree = true).assertCountEquals(3)
        val rows = rule.onAllNodesWithTag(DiffTags.SPLIT_ROW, useUnmergedTree = true)
        // Under the `@@` bar.
        assertBox("row", rows[0].bounds, 0.dp, 18.dp, PHONE_WIDTH.dp, 18.dp)
        val lines = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)
        lines.assertCountEquals(5)
        // Each side is half of what's left after the 1 divider.
        val half = (PHONE_WIDTH - 1) / 2f
        val left = rule.onNodeWithText("b", useUnmergedTree = true).bounds
        val right = rule.onNodeWithText("c", useUnmergedTree = true).bounds
        assertTrue("left side ends before the middle", left.right.value <= half + 0.5f)
        assertDp("right side starts after the divider", (half + 1).dp + (left.left.value).dp, right.left)
    }

    @Test
    fun syntaxColoursRowsBeforeTheyShow() {
        val f = file("val a = 1\n", "val a = 2\n", path = "a.kt")
        show(syntax = SyntaxService()) { DiffFileView(f) }
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(DiffTags.SYNTAX_READY, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithTag(DiffTags.SYNTAX_PENDING, useUnmergedTree = true).assertCountEquals(0)
        val text = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)[0].fetchSemanticsNode()
            .config.getOrNull(SemanticsProperties.Text)!!.single()
        val keyword = LightKeyword
        assertTrue("keyword coloured: ${text.spanStyles}", text.spanStyles.any { it.item.color == keyword && text.substring(it.start, it.end) == "val" })
        // Word emphasis: the changed digit sits on wordDel.
        assertTrue("word emphasis", text.spanStyles.any { it.item.background == Color(0xFFFFC1C0) })
    }

    /** DiffFileView: rows held back by the syntax gate can't be reached by a screen reader either. */
    @Test
    fun pendingRowsAreHiddenFromTalkBack() {
        val stalled = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) = Unit
        }
        rule.mainClock.autoAdvance = false
        show(syntax = SyntaxService(stalled)) { DiffFileView(file("val a = 1\n", "val a = 2\n", path = "c.kt")) }
        rule.mainClock.advanceTimeByFrame()
        val pending = rule.onAllNodesWithTag(DiffTags.SYNTAX_PENDING, useUnmergedTree = true)
        assertTrue("held back", pending.fetchSemanticsNodes().isNotEmpty())
        pending[0].assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.HideFromAccessibility))
        rule.mainClock.advanceTimeBy(1_100)
        rule.onAllNodesWithTag(DiffTags.SYNTAX_READY, useUnmergedTree = true)[0]
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.HideFromAccessibility))
    }

    @Test
    fun cachedSyntaxPaintsAtOnce() {
        val f = file("fun a() {}\n", "fun b() {}\n", path = "b.kt")
        val service = SyntaxService()
        val body = DiffFileBody(f, syntax = service)
        runBlocking { for (hunk in com.slopus.happy.diff.syntax.DiffSyntax.plan(f, body.rows)) service.highlight(hunk.input) }
        assertTrue("cached before the first frame", !DiffFileBody(f, syntax = service).pending)
    }

    @Test
    fun lazyRowsShareOneHorizontalScroll() {
        val long = "y".repeat(300)
        val f = file("$long\n", "$long!\n")
        lateinit var body: DiffFileBody
        rule.setHappyContent {
            val palette = diffPalette()
            val metrics = rememberDiffMetrics()
            val scope = rememberCoroutineScope()
            body = androidx.compose.runtime.remember { DiffFileBody(f) }
            DisposableEffect(body) { body.start(scope); onDispose { body.stop() } }
            LazyColumn { diffFileItems(body, palette, metrics, keyPrefix = "f") }
        }
        val lines = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)
        lines.assertCountEquals(2)
        val before = lines[1].bounds.left
        rule.runOnIdle { runBlocking { body.scroll.scrollTo(300) } }
        rule.waitForIdle()
        val shift = 300 / 3f
        assertDp("first row slid", before - shift.dp, lines[0].bounds.left)
        assertDp("second row slid with it", before - shift.dp, lines[1].bounds.left)
    }

    private fun showLazy(f: DiffFile, layout: DiffLayoutMode) {
        rule.setHappyContent {
            val palette = diffPalette()
            val metrics = rememberDiffMetrics()
            val scope = rememberCoroutineScope()
            val body = androidx.compose.runtime.remember { DiffFileBody(f) }
            DisposableEffect(body) { body.start(scope); onDispose { body.stop() } }
            LazyColumn { diffFileItems(body, palette, metrics, keyPrefix = "f", layout = layout) }
        }
    }

    /** The changes screen's lazy rows paint their `@@` and line bands to the screen's edge however short the lines, as [DiffFileView] does. */
    @Test
    fun lazyScrollRowsOfShortLinesFillTheViewport() {
        showLazy(file("a\nb\nc\n", "a\nB\nc\n"), DiffLayoutMode.Scroll)
        val lines = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(4, lines.size)
        val gutterRight = rule.node(DiffTags.HUNK).bounds.left
        assertTrue("a gutter before the code", gutterRight > 20.dp)
        assertBox("hunk", rule.node(DiffTags.HUNK).bounds, gutterRight, 0.dp, PHONE_WIDTH.dp - gutterRight, 18.dp)
        rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true).let { nodes ->
            repeat(4) { i -> assertBox("line $i", nodes[i].bounds, gutterRight, (18 * (i + 1)).dp, PHONE_WIDTH.dp - gutterRight, 18.dp) }
        }
    }

    @Test
    fun lazyScrollRowsKeepTheLongestLinesWidth() {
        val long = "y".repeat(300)
        showLazy(file("$long\n", "$long!\n"), DiffLayoutMode.Scroll)
        val line = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)[1].bounds
        assertTrue("wider than the screen: ${line.width}", line.width > PHONE_WIDTH.dp)
    }

    @Test
    fun lazyWrapRowsFillTheViewport() {
        showLazy(file("a\nb\nc\n", "a\nB\nc\n"), DiffLayoutMode.Wrap)
        assertBox("hunk", rule.node(DiffTags.HUNK).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 18.dp)
        val lines = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)
        val count = lines.fetchSemanticsNodes().size
        assertEquals(4, count)
        repeat(count) { i -> assertDp("wrapped line $i reaches the edge", PHONE_WIDTH, lines[i].bounds.right) }
    }

    @Test
    fun lazySplitRowsFillTheViewport() {
        showLazy(file("a\nb\nc\n", "a\nB\nc\n"), DiffLayoutMode.Split)
        assertBox("hunk", rule.node(DiffTags.HUNK).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 18.dp)
        val rows = rule.onAllNodesWithTag(DiffTags.SPLIT_ROW, useUnmergedTree = true)
        val count = rows.fetchSemanticsNodes().size
        assertEquals(3, count)
        repeat(count) { i -> assertBox("split row $i", rows[i].bounds, 0.dp, rows[i].bounds.top, PHONE_WIDTH.dp, rows[i].bounds.height) }
    }

    @Test
    fun chunkDrawsEveryFileWithoutHeaders() {
        val patch = "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n" +
            "diff --git a/y.txt b/y.txt\n--- a/y.txt\n+++ b/y.txt\n@@ -1 +1 @@\n-c\n+d\n"
        show { DiffChunk(DiffSource.Patch(patch)) }
        rule.onAllNodesWithTag(DiffTags.FILE, useUnmergedTree = true).assertCountEquals(2)
        // One hunk each: no `@@` bars.
        rule.onAllNodesWithTag(DiffTags.HUNK, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(DiffTags.HEADER, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun chunkWithNothingDrawsNothing() {
        show { DiffChunk(patch = null, oldText = null, newText = null) }
        rule.onAllNodesWithTag(DiffTags.CHUNK, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun fileHeader() {
        var toggled by mutableStateOf(0)
        show {
            DiffFileHeader(DiffFileSummary("src/app/main.kt", FileChangeKind.Added, 3, 1), collapsed = true, onToggle = { toggled++ })
        }
        val header = rule.node(DiffTags.HEADER).bounds
        assertBox("header", header, 0.dp, 0.dp, PHONE_WIDTH.dp, header.height)
        val chevron = rule.node(DiffTags.CHEVRON).bounds
        assertDp("chevron 12 in", 12, chevron.left)
        assertDp("chevron 14", 14, chevron.width)
        val icon = rule.node(com.slopus.happy.ui.files.FileIconTags.ICON).bounds
        assertBox("icon", icon, chevron.right + 8.dp, icon.top, 16.dp, 16.dp)
        rule.onNodeWithText("src/app/").assertExists()
        rule.onNodeWithText("main.kt").assertExists()
        rule.onNodeWithText("NEW").assertExists()
        rule.onNodeWithText("+3").assertExists()
        val minus = rule.onNodeWithText("−1", useUnmergedTree = true).bounds
        assertDp("stats end 12 in", PHONE_WIDTH - 12, minus.right)
        rule.node(DiffTags.HEADER).performClick()
        assertEquals(1, toggled)
    }

    @Test
    fun imagePanes() {
        val png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        show { DiffImageView(before = png, after = png) }
        val box = rule.node(DiffTags.IMAGE).bounds
        assertBox("panes", box, 0.dp, 0.dp, PHONE_WIDTH.dp, box.height)
        val before = rule.onNodeWithText("BEFORE").bounds
        val after = rule.onNodeWithText("AFTER").bounds
        assertDp("padded 12", 12, before.left)
        val half = (PHONE_WIDTH - 24 - 12) / 2f
        assertDp("second pane 12 after the first", (12 + half + 12).dp, after.left)
        assertDp("160 boxes 6 under the labels", (before.bottom.value + 6 + 160 + 12).dp, box.bottom)
    }

    @Test
    fun noImageSaysBinary() {
        show { DiffImageView(before = null, after = null) }
        rule.onNodeWithText("Binary file not shown").assertExists()
    }

    @Test
    fun headerRight() {
        var ignore by mutableStateOf(false)
        var refreshed = 0
        show {
            Row { DiffHeaderRight(fileCount = 3, ignoreWhitespace = ignore, onIgnoreWhitespaceChange = { ignore = it }, onRefresh = { refreshed++ }) }
        }
        rule.onNodeWithText("3 changed files").assertExists()
        rule.onNodeWithText("·→").assertExists()
        rule.node(DiffHeaderRightTags.WHITESPACE).performClick()
        assertTrue(ignore)
        rule.node(DiffHeaderRightTags.REFRESH).performClick()
        assertEquals(1, refreshed)
        assertDp("refresh 18", 18, rule.node(DiffHeaderRightTags.REFRESH).bounds.width)
    }

    private companion object {
        val LightKeyword = Color(0xFFCF222E)
    }
}
