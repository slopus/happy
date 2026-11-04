package com.slopus.happy.ui.documents

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.text.Spanned
import android.text.TextPaint
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.documents.DocumentBlock
import com.slopus.happy.documents.DocumentLine
import com.slopus.happy.documents.DocumentRun
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A table in a document as iOS draws it (`DocumentObjectLayout.Table`):
 * its cells' text on a grid, 32 a row, and its name for TalkBack.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentObjectsTest {
    private val resources = InstrumentationRegistry.getInstrumentation().targetContext.resources

    @Test
    fun aTableIsItsCellsOnAGridThirtyTwoARow() {
        val cells = listOf(listOf("Name", "Due"), listOf("Login fix", "Monday"), listOf("Notes", ""))
        val table = DocumentLine(DocumentBlock("t1", "table", content = DocumentBlock.Content.Table(cells.map { row -> row.map { listOf(DocumentRun(it)) } })))
        val style = DocumentStyle(resources, dark = false)
        val text = style.document(listOf(table)) as Spanned
        val span = text.getSpans(0, text.length, DocumentObjectSpan::class.java).single()
        assertEquals(cells, span.rows)
        val fm = Paint.FontMetricsInt()
        span.getSize(TextPaint(), text, 0, 1, fm)
        val density = resources.displayMetrics.scaledDensity
        assertEquals("three rows of 32", 96 * density, (fm.descent - fm.ascent).toFloat(), 1f)
        // It draws without throwing, at its size.
        val canvas = Canvas(Bitmap.createBitmap(1000, 400, Bitmap.Config.ARGB_8888))
        span.draw(canvas, text, 0, 1, 0f, 0, fm.descent - fm.ascent, fm.descent - fm.ascent, TextPaint())
        assertEquals(listOf("Table"), text.getSpans(0, text.length, DocumentObjectSpeech::class.java).map { it.spoken })
    }
}
