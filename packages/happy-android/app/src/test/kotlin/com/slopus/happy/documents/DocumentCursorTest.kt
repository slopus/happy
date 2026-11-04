package com.slopus.happy.documents

import com.slopus.happy.documents.DocumentFixtures.bytes
import com.slopus.happy.documents.DocumentFixtures.json
import com.slopus.happy.documents.DocumentFixtures.string
import com.slopus.happy.documents.DocumentFixtures.yany
import com.slopus.happy.documents.yjs.YAwarenessState
import com.slopus.happy.documents.yjs.YID
import com.slopus.happy.documents.yjs.YRelativePosition
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Carets and presence against what desktop's y-prosemirror and y-protocols
 * produce (iOS's `DocumentCursorTests`).
 */
class DocumentCursorTest {
    @Test
    fun caretsBecomeTheRelativePositionsDesktopMakes() {
        val cases = DocumentFixtures.cursors
        assertEquals(6, cases.size)
        for (c in cases) {
            val name = string(c["name"])
            val (editor, _) = DocumentFixtures.editor(bytes(c["base"]))
            val positions = c["positions"]!!.jsonArray.map { it.jsonObject }
            val relatives = ArrayList<YRelativePosition>()
            for (p in positions) {
                val caret = DocumentCaret(string(p["id"])!!, p["offset"]!!.jsonPrimitive.int)
                val ours = editor.relativePosition(caret)
                assertNotNull("$name $caret", ours)
                assertEquals("$name $caret", BlockNoteJSON.normalize(p["relative"]), BlockNoteJSON.normalize(json(ours!!.json)))
                assertEquals(name, ours, YRelativePosition.fromJson(yany(p["relative"]!!)))
                assertEquals("$name resolves back", caret, editor.caret(ours))
                relatives += ours
            }
            editor.applyRemote(bytes(c["edit"]))
            positions.zip(relatives).forEach { (p, relative) ->
                val expected = (p["after"] as? JsonObject)?.let { DocumentCaret(string(it["id"])!!, it["offset"]!!.jsonPrimitive.int) }
                assertEquals("$name ${p["id"]} ${p["offset"]} after the edit", expected, editor.caret(relative))
            }
        }
    }

    @Test
    fun awarenessUpdatesReadAndWriteAsYProtocols() {
        val presence = DocumentFixtures.presence
        val bytes = bytes(presence["update"])
        val states = YAwarenessState.decode(bytes)
        assertEquals(1, states.size)
        assertEquals(presence["clientID"]!!.jsonPrimitive.long, states[0].clientID)
        assertEquals(BlockNoteJSON.normalize(presence["state"]), BlockNoteJSON.normalize(json(states[0].state!!)))
        assertArrayEquals(bytes, YAwarenessState.encode(states))
        val anchor = states[0].state?.get("cursor")?.get("anchor")?.let(YRelativePosition::fromJson)
        assertEquals(YID(4242, 6), anchor!!.item)
        assertArrayEquals(byteArrayOf(1, 9, 3, 4) + "null".toByteArray(), YAwarenessState.encode(listOf(YAwarenessState(9, 3, null))))
    }
}
