package com.slopus.happy.diff

import com.slopus.happy.chat.tools.writtenFileLines
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A new file drawn as a listing (desktop's created-file view), and a Write's NEW +N. */
class DiffNewFileTest {
    @Test
    fun aNewFileListsItsLinesWithoutMarkersOrHunks() {
        val file = DiffSource.Contents("a.kt", "", "import x\n\nfun main() {\n    println(1)\n}\n").build().files.single()
        val listing = DiffLayout.asListing(file.rows)
        assertEquals(
            listOf(1 to "import x", 2 to "", 3 to "fun main() {", 4 to "    println(1)", 5 to "}"),
            listing.map { row -> (row as DiffRow.Line).also { assertEquals(DiffLineType.Ctx, it.type) }.let { it.newNo to it.text } },
        )
    }

    @Test
    fun aWriteCountsTheLinesOfWhatItWrote() {
        assertEquals(3, writtenFileLines(Json.parseToJsonElement("""{"file_path":"/r/a.kt","content":"a\nb\nc\n"}""")))
        assertNull(writtenFileLines(Json.parseToJsonElement("""{"content":"a"}""")))
        assertNull(writtenFileLines(Json.parseToJsonElement("""{"file_path":"/r/a.kt"}""")))
    }
}
