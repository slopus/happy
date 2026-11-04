package com.slopus.happy.documents

import com.slopus.happy.documents.DocumentFixtures.bytes
import com.slopus.happy.documents.DocumentFixtures.doc
import com.slopus.happy.documents.DocumentFixtures.string
import com.slopus.happy.documents.yjs.YDoc
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Yjs port and block reader against documents the daemon's own code
 * made over yjs 13.6 and BlockNote 0.51.4 (iOS's `DocumentFixtureTests`).
 */
class DocumentFixtureTest {
    @Test
    fun everyFixtureReadsAsBlockNoteReadsIt() {
        assertTrue(DocumentFixtures.documents.size > 30)
        for (fixture in DocumentFixtures.documents) {
            val name = string(fixture["name"])!!
            val doc = doc(bytes(fixture["update"]))
            assertFalse(name, doc.hasPending)
            var blocks = DocumentReader.blocks(doc)
            if (name == "outside-model") {
                // BlockNote drops what it can't place; the editor keeps it, unsupported.
                assertEquals(DocumentBlock.Content.Unsupported("futureBlock"), blocks.last().content)
                blocks = blocks.dropLast(1)
            }
            assertEquals(name, BlockNoteJSON.normalize(fixture["blocks"]), BlockNoteJSON.normalize(JsonArray(blocks.map(BlockNoteJSON::block))))
        }
    }

    @Test
    fun reencodedStateReadsTheSame() {
        for (fixture in DocumentFixtures.documents) {
            val name = string(fixture["name"])!!
            val update = bytes(fixture["update"])
            val first = doc(update)
            val again = doc(first.encodeStateAsUpdate())
            assertEquals(name, DocumentReader.blocks(first), DocumentReader.blocks(again))
            assertEquals(name, first.stateVector(), again.stateVector())
            // Only what a state vector lacks: nothing, against itself.
            val none = first.encodeStateAsUpdate(first.stateVector())
            val third = doc(update)
            third.applyUpdate(none)
            assertEquals(name, DocumentReader.blocks(first), DocumentReader.blocks(third))
        }
    }

    @Test
    fun concurrentEditsConvergeAsYjsMerges() {
        assertEquals(8, DocumentFixtures.merges.size)
        for (merge in DocumentFixtures.merges) {
            val name = string(merge["name"])!!
            val merged = merge["merged"]!!.jsonObject["blocks"]
            for (order in listOf(listOf("a", "b"), listOf("b", "a"))) {
                val doc = doc(bytes(merge["base"]))
                for (key in order) doc.applyUpdate(bytes(merge[key]))
                assertEquals("$name $order", BlockNoteJSON.normalize(merged), BlockNoteJSON.normalize(JsonArray(DocumentReader.blocks(doc).map(BlockNoteJSON::block))))
            }
        }
    }

    @Test
    fun updatesArrivingBeforeWhatTheyNeedWaitThenApply() {
        val merge = DocumentFixtures.merges.first { string(it["name"]) == "split-and-edit" }
        val base = bytes(merge["base"])
        val a = bytes(merge["a"])
        val late = YDoc(999)
        late.applyUpdate(a)
        assertTrue(late.hasPending)
        assertEquals(emptyList<DocumentBlock>(), DocumentReader.blocks(late))
        late.applyUpdate(base)
        assertFalse(late.hasPending)
        val expected = doc(base)
        expected.applyUpdate(a)
        assertEquals(DocumentReader.blocks(expected), DocumentReader.blocks(late))
    }

    @Test
    fun stateVectorsEncodeAsYjsDoes() {
        val doc = doc(DocumentFixtures.fixture("desktop-short"))
        val vector = doc.stateVector()
        assertNotEquals(0, vector.size)
        assertEquals(vector, YDoc.decodeStateVector(YDoc.encodeStateVector(vector)))
        assertEquals(vector, YDoc.updateStateVector(doc.encodeStateAsUpdate()))
    }
}
