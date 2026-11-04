package com.slopus.happy.ui.documents

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.DocumentPeer
import com.slopus.happy.documents.DocumentRun
import com.slopus.happy.documents.yjs.YDoc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The editor as the keyboard drives it (iOS's DocumentTextController
 * tests): typing is read back into the document, Enter and Backspace at a
 * line's start are line edits, Markdown typed becomes what it means, the
 * bar formats the selection, a task's box ticks it, and a change from
 * elsewhere leaves the caret where it was in the text.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentTextControllerTest {
    private lateinit var view: DocumentTextView
    private lateinit var editor: DocumentEditor
    private lateinit var controller: DocumentTextController
    private val updates = ArrayList<ByteArray>()

    @Before
    fun setUp() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        view = DocumentTextView(activity)
        activity.setContentView(view)
        editor = DocumentEditor(YDoc(11))
        editor.onLocalUpdate = { updates += it }
        val style = DocumentStyle(activity.resources, dark = false)
        controller = DocumentTextController(view, editor, style)
        controller.install(editor, style.document(editor.lines))
        view.requestFocus()
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** Types as a keyboard does: into the text at the caret, a character at a time. */
    private fun type(text: String) {
        for (c in text) {
            val at = view.selectionStart
            view.text.insert(at, c.toString())
            idle()
        }
    }

    private val texts get() = editor.lines.map { it.block.plainText }

    /** Each line is one paragraph with its own line span, none reaching into the next (whose margins would stack). */
    private fun assertParagraphs() {
        val text = view.text
        val spans = text.getSpans(0, text.length, DocumentLineSpan::class.java).sortedBy { text.getSpanStart(it) }
        val shown = spans.joinToString { "${editor.lines.indexOfFirst { l -> l.id == it.id }}@${text.getSpanStart(it)}-${text.getSpanEnd(it)}" }
        assertEquals("${text.toString().replace("\n", "|")} $shown", editor.lines.map { it.id }, spans.map { it.id })
        var start = 0
        for ((i, line) in editor.lines.withIndex()) {
            val end = start + (if (line.block.isInline) line.block.plainText.length else 1) + 1
            assertEquals("line $i starts its span", start, text.getSpanStart(spans[i]))
            assertEquals("line $i ends its span", end, text.getSpanEnd(spans[i]))
            start = end
        }
        assertEquals(text.length, start)
    }

    @Test
    fun typingIsReadBackIntoTheDocument() {
        assertEquals("An empty document still has a line to type in", listOf(""), texts)
        type("Hello")
        assertEquals(listOf("Hello"), texts)
        assertEquals("Hello\n", view.text.toString())
        assertTrue("Each change goes out as an update", updates.isNotEmpty())
    }

    @Test
    fun enterSplitsTheLineAndBackspaceAtItsStartJoinsIt() {
        type("Hello world")
        view.setSelection(5)
        type("\n")
        assertEquals(listOf("Hello", " world"), texts)
        assertEquals("The caret starts the new line", 6, view.selectionStart)
        // Backspace at the line's start deletes the "\n" before it.
        view.text.delete(5, 6)
        idle()
        assertEquals(listOf("Hello world"), texts)
        assertEquals(5, view.selectionStart)
    }

    @Test
    fun markdownTypedAtALinesStartMakesItAHeading() {
        type("# ")
        val line = editor.lines.single()
        assertEquals("heading", line.block.type)
        assertEquals(1, line.block.level)
        assertEquals("The marker is gone", "", line.block.plainText)
        type("Plan")
        assertEquals(listOf("Plan"), texts)
        assertEquals("heading", editor.lines.single().block.type)
    }

    @Test
    fun listsAndHeadingsKeepTheirParagraphsToThemselves() {
        type("# Plan")
        type("\n")
        type("- one")
        type("\n")
        type("two")
        type("\n")
        assertEquals(listOf("heading", "bulletListItem", "bulletListItem", "bulletListItem"), editor.lines.map { it.block.type })
        assertParagraphs()
        // Enter on an empty list item ends the list, as BlockNote does.
        type("\n")
        assertEquals("paragraph", editor.lines.last().block.type)
        type("Done")
        assertEquals(listOf("Plan", "one", "two", "Done"), texts)
        assertParagraphs()
        val margins = editor.lines.indices.map { i ->
            val span = view.text.getSpans(0, view.text.length, DocumentLineSpan::class.java).first { it.id == editor.lines[i].id }
            span.getLeadingMargin(true)
        }
        assertEquals("No margin stacks onto the lines below", listOf(0, margins[1], margins[1], 0), margins)
    }

    @Test
    fun theBarBoldsTheSelectionAndLightsUp() {
        type("Hello there")
        view.setSelection(0, 5)
        controller.run(DocumentTool.Bold)
        val runs = editor.lines.single().block.runs
        assertEquals(listOf("Hello", " there"), runs.map { it.text })
        assertTrue("bold" in runs[0].marks)
        assertFalse("bold" in runs[1].marks)
        assertTrue(DocumentTool.Bold in controller.activeTools)
        assertEquals("The selection stays", 0 to 5, view.selectionStart to view.selectionEnd)
    }

    @Test
    fun aChecklistItemsBoxTicksIt() {
        type("Milk")
        controller.run(DocumentTool.Checklist)
        val id = editor.lines.single().id
        assertEquals("checkListItem", editor.lines.single().block.type)
        assertFalse(editor.lines.single().block.checked)
        controller.toggle(id)
        assertTrue(editor.lines.single().block.checked)
        assertEquals("Milk", editor.lines.single().block.plainText)
    }

    @Test
    fun aChangeFromElsewhereKeepsTheCaretInItsText() {
        type("world")
        view.setSelection(3)
        // Another replica, the same document, puts text before the caret.
        val other = DocumentEditor(YDoc(22))
        other.doc.applyUpdate(editor.doc.encodeStateAsUpdate())
        val remote = ArrayList<ByteArray>()
        other.onLocalUpdate = { remote += it }
        other.setRuns(other.lines.single().id, listOf(DocumentRun("Hello, world")))
        remote.forEach(controller::applyRemote)
        assertEquals(listOf("Hello, world"), texts)
        assertEquals("Hello, world\n", view.text.toString())
        assertEquals("Still between the same two letters", 10, view.selectionStart)
    }

    @Test
    fun anotherEditorsCaretFollowsTheTextAndItsNameFades() {
        type("world")
        val other = DocumentEditor(YDoc(22))
        other.doc.applyUpdate(editor.doc.encodeStateAsUpdate())
        val line = other.lines.single().id
        // Ann's caret after "wor".
        val head = other.relativePosition(com.slopus.happy.documents.DocumentCaret(line, 3))
        controller.showPeers(listOf(DocumentPeer("ann", 22, "Ann", "#958DF1", head, head)))
        assertEquals(listOf(DocumentCursor("ann", 3, 0xFF958DF1.toInt(), "Ann", labelled = true)), view.cursors)
        // Text typed before it here moves it with its letters.
        view.setSelection(0)
        type("Hi ")
        assertEquals(listOf(6), view.cursors.map { it.offset })
        // Three seconds after Ann last moved, only the bar stays.
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(3_200))
        assertEquals(listOf(false), view.cursors.map { it.labelled })
        controller.showPeers(emptyList())
        assertTrue(view.cursors.isEmpty())
    }

    @Test
    fun talkBackSaysAnObjectsNameNotItsPlaceholder() {
        type("Above")
        controller.run(DocumentTool.Divider)
        idle()
        val spoken = view.text.getSpans(0, view.text.length, DocumentObjectSpeech::class.java)
        assertEquals(listOf("Divider"), spoken.map { it.spoken })
        val node = view.createAccessibilityNodeInfo()
        val read = node.text as android.text.Spanned
        assertEquals("The name rides into what TalkBack reads", listOf("Divider"), read.getSpans(0, read.length, android.text.style.TtsSpan::class.java).map { it.args.getString(android.text.style.TtsSpan.ARG_TEXT) })
    }

    @Test
    fun aPictureIsReadOnceThenShownAtItsOwnShape() {
        val asked = ArrayList<String>()
        controller.loadPicture = { url, done ->
            asked += url
            DocumentPictures.keep(url, DocumentPicture(android.graphics.Bitmap.createBitmap(40, 60, android.graphics.Bitmap.Config.ARGB_8888), 40, 60))
            done()
        }
        val url = "/v0/surfaces/doc/files/picture-${System.nanoTime()}.png"
        val picture = com.slopus.happy.documents.DocumentLine(
            com.slopus.happy.documents.DocumentBlock(DocumentEditor.newID(), "image", mapOf("url" to com.slopus.happy.documents.yjs.YAny.Str(url)), com.slopus.happy.documents.DocumentBlock.Content.None),
        )
        editor.replaceLines(0 until 1, listOf(picture, editor.lines.single()))
        idle()
        assertEquals("Asked for once", listOf(url), asked)
        val span = view.text.getSpans(0, view.text.length, DocumentObjectSpan::class.java).single()
        assertTrue("The line shows the picture once read", span.picture != null)
        // 40 by 60, a pixel to a point: 40 dp across and 60 tall, and its line as tall (not a line of text's 22).
        val density = view.resources.displayMetrics.density
        val fm = android.graphics.Paint.FontMetricsInt()
        span.getSize(view.paint, view.text, view.text.getSpanStart(span), view.text.getSpanEnd(span), fm)
        assertEquals(60 * density, (fm.descent - fm.ascent).toFloat(), 1f)
        val line = view.layout.getLineForOffset(view.text.getSpanStart(span))
        assertTrue("The line holds the picture", view.layout.getLineBottom(line) - view.layout.getLineTop(line) >= 60 * density - 1)
        editor.replaceLines(1 until 2, listOf(editor.lines[1]))
        idle()
        assertEquals("Kept, not asked for again", listOf(url), asked)
    }

    /** A hardware key as a keyboard sends it: down, with its modifiers held. */
    private fun press(code: Int, meta: Int = 0) {
        view.dispatchKeyEvent(android.view.KeyEvent(0, 0, android.view.KeyEvent.ACTION_DOWN, code, 0, meta))
        view.dispatchKeyEvent(android.view.KeyEvent(0, 0, android.view.KeyEvent.ACTION_UP, code, 0, meta))
        idle()
    }

    @Test
    fun hardwareKeysFormatAsDocumentEditorMdSays() {
        val ctrl = android.view.KeyEvent.META_CTRL_ON or android.view.KeyEvent.META_CTRL_LEFT_ON
        val shift = android.view.KeyEvent.META_SHIFT_ON or android.view.KeyEvent.META_SHIFT_LEFT_ON
        val alt = android.view.KeyEvent.META_ALT_ON or android.view.KeyEvent.META_ALT_LEFT_ON
        type("Hello there")
        view.setSelection(0, 5)
        press(android.view.KeyEvent.KEYCODE_B, ctrl)
        assertTrue("Ctrl+B bolds", "bold" in editor.lines.single().block.runs[0].marks)
        press(android.view.KeyEvent.KEYCODE_I, ctrl)
        assertTrue("Ctrl+I slants", "italic" in editor.lines.single().block.runs[0].marks)
        press(android.view.KeyEvent.KEYCODE_S, ctrl or shift)
        assertTrue("Ctrl+Shift+S strikes", "strike" in editor.lines.single().block.runs[0].marks)
        press(android.view.KeyEvent.KEYCODE_E, ctrl)
        assertTrue("Ctrl+E is code", "code" in editor.lines.single().block.runs[0].marks)
        press(android.view.KeyEvent.KEYCODE_2, ctrl or alt)
        assertEquals("Ctrl+Alt+2 is a heading 2", "heading" to 2, editor.lines.single().block.type to editor.lines.single().block.level)
        press(android.view.KeyEvent.KEYCODE_0, ctrl or alt)
        assertEquals("Ctrl+Alt+0 is text again", "paragraph", editor.lines.single().block.type)
        press(android.view.KeyEvent.KEYCODE_8, ctrl or shift)
        assertEquals("Ctrl+Shift+8 bullets", "bulletListItem", editor.lines.single().block.type)
        press(android.view.KeyEvent.KEYCODE_7, ctrl or shift)
        assertEquals("Ctrl+Shift+7 numbers", "numberedListItem", editor.lines.single().block.type)
        press(android.view.KeyEvent.KEYCODE_9, ctrl or shift)
        assertEquals("Ctrl+Shift+9 is a checklist", "checkListItem", editor.lines.single().block.type)
        // Shift+Enter breaks the line inside its paragraph.
        view.setSelection(view.text.length - 1)
        press(android.view.KeyEvent.KEYCODE_ENTER, shift)
        assertEquals("Still one block", 1, editor.lines.size)
        assertTrue("with a hard break", editor.lines.single().block.plainText.endsWith("\n"))
        // Tab nests a second item under the first; Shift+Tab brings it back.
        view.setSelection(view.text.length - 1)
        type("\n")
        type("Two")
        press(android.view.KeyEvent.KEYCODE_TAB)
        assertEquals("Tab nests it", listOf(0, 1), editor.lines.map { it.depth })
        press(android.view.KeyEvent.KEYCODE_TAB, shift)
        assertEquals("Shift+Tab brings it back", listOf(0, 0), editor.lines.map { it.depth })
    }
}
