package com.slopus.happy.ui.documents

import android.os.Looper
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.documents.DocumentBlock
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.DocumentLine
import com.slopus.happy.documents.DocumentRun
import com.slopus.happy.documents.DocumentText
import com.slopus.happy.documents.yjs.YAny
import com.slopus.happy.documents.yjs.YDoc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * How much a keystroke and a change from elsewhere cost on a 10,000-word
 * document (iOS's `testTypingLatencyOnALongDocument` workload, DOCUMENT-EDITOR.md
 * "Performance"), counted in lines laid out rather than timed: the edited
 * paragraph's, whatever the document's length. Every paragraph after the
 * caret used to be laid out again, twice, on each keystroke
 * ([DocumentEditable]).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentWorkTest {
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** iOS's: 12 to 20 words a block, every tenth a heading and every seventh a bullet. */
    private fun longDocument(): List<DocumentLine> {
        val words = listOf("the", "editor", "keeps", "every", "block", "as", "it", "was", "written", "and", "merges", "changes", "from", "desktop", "without", "losing", "place")
        val lines = ArrayList<DocumentLine>()
        var count = 0
        var i = 0
        while (count < 10_000) {
            val length = 12 + (i % 9)
            count += length
            val type = if (i % 10 == 0) "heading" else if (i % 7 == 0) "bulletListItem" else "paragraph"
            val props = if (type == "heading") mapOf("level" to YAny.Number(2.0)) else emptyMap()
            lines += DocumentLine(DocumentBlock(DocumentEditor.newID(), type, props, DocumentBlock.Content.Inline(listOf(DocumentRun((0 until length).joinToString(" ") { words[(it + i) % words.size] })))))
            i++
        }
        return lines
    }

    @Test
    fun aKeystrokeAndARemoteChangeLayOutOnlyTheirParagraph() {
        val lines = longDocument()
        val editor = DocumentEditor(YDoc(9))
        editor.replaceLines(0 until editor.lines.size, lines)
        val desktop = DocumentEditor(YDoc(10))
        desktop.doc.applyUpdate(editor.doc.encodeStateAsUpdate())
        val updates = ArrayList<ByteArray>()
        desktop.onLocalUpdate = { updates += it }
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val view = DocumentTextView(activity)
        activity.setContentView(FrameLayout(activity).apply { addView(view, FrameLayout.LayoutParams(-1, -1)) })
        idle()
        val style = DocumentStyle(activity.resources, dark = false)
        val controller = DocumentTextController(view, editor, style)
        controller.install(editor, style.document(editor.lines))
        view.requestFocus()
        idle()
        assertTrue(view.text is DocumentEditable)
        // Near the top, so nearly all of it follows the caret.
        view.setSelection(DocumentText.starts(controller.lines)[2] + 10)
        idle()

        val perKeystroke = ArrayList<Int>()
        for (c in "typing near the top") {
            DocumentLineSpan.linesLaidOut = 0
            view.text.insert(view.selectionStart, c.toString())
            idle()
            perKeystroke += DocumentLineSpan.linesLaidOut
        }
        assertEquals("typed", true, controller.lines[2].block.plainText.contains("typing near the top"))
        assertTrue("a keystroke lays out its own paragraph's few lines, not the ${lines.size} after it: $perKeystroke", perKeystroke.max() <= 8)

        val perRemote = ArrayList<Int>()
        repeat(5) {
            updates.clear()
            val line = desktop.lines[3]
            desktop.setRuns(line.id, listOf(DocumentRun("x" + line.block.plainText)))
            DocumentLineSpan.linesLaidOut = 0
            updates.forEach(controller::applyRemote)
            idle()
            perRemote += DocumentLineSpan.linesLaidOut
        }
        assertTrue("x".repeat(5) + " reached the text", view.text.toString().contains("xxxxx"))
        assertTrue("a change from elsewhere lays out its paragraph and its neighbours only: $perRemote", perRemote.max() <= 16)
    }
}
