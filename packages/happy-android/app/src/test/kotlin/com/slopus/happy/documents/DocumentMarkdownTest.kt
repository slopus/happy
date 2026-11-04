package com.slopus.happy.documents

import com.slopus.happy.documents.DocumentFixtures.bytes
import com.slopus.happy.documents.DocumentFixtures.doc
import com.slopus.happy.documents.DocumentFixtures.string
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Markdown this phone projects is the daemon's, over the whole corpus (iOS's `DocumentMarkdownTests`). */
class DocumentMarkdownTest {
    @Test
    fun markdownMatchesTheDaemonsProjection() {
        var compared = 0
        for (fixture in DocumentFixtures.documents) {
            val doc = doc(bytes(fixture["update"]))
            assertEquals(string(fixture["name"]), string(fixture["markdown"]), DocumentMarkdown.markdown(DocumentReader.blocks(doc)))
            compared++
        }
        for (merge in DocumentFixtures.merges) {
            val doc = doc(bytes(merge["base"]))
            doc.applyUpdate(bytes(merge["a"]))
            doc.applyUpdate(bytes(merge["b"]))
            assertEquals(string(merge["name"]), string(merge["merged"]!!.jsonObject["markdown"]), DocumentMarkdown.markdown(DocumentReader.blocks(doc)))
            compared++
        }
        assertEquals(42, compared)
    }

    @Test
    fun omittedFormattingIsNamed() {
        val fixture = DocumentFixtures.document("formatting")
        val doc = doc(bytes(fixture["update"]))
        assertEquals(fixture["omitted"]!!.jsonArray.map { string(it)!! }.toSet(), DocumentMarkdown.omitted(DocumentReader.blocks(doc)))
    }
}
