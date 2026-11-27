package com.slopus.happy.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StoredJsonTest {
    private fun bytes(text: String) = text.encodeToByteArray().size

    @Test
    fun aDocumentThatFitsIsStoredAsItIs() {
        val value = buildJsonObject {
            put("role", "agent")
            put("text", "ünïcode \"quoted\"\n" + "y".repeat(100_000))
        }
        assertEquals(value.toString(), StoredJson.encode(value))
    }

    /** A relay message carrying a 3 MB tool output: the output is cut, the message around it kept. */
    @Test
    fun aHugeToolOutputIsCutAndTheMessageKept() {
        val value = buildJsonObject {
            put("role", "agent")
            putJsonObject("content") {
                put("type", "output")
                putJsonArray("data") {
                    addJsonObject {
                        put("type", "tool_result")
                        put("tool_use_id", "toolu_1")
                        put("content", "ж".repeat(3 * 1024 * 1024))
                    }
                }
            }
        }
        val stored = StoredJson.encode(value)!!
        assertTrue(bytes(stored) <= StoredJson.MAX_BYTES)
        val read = Json.parseToJsonElement(stored).jsonObject
        assertEquals("agent", read["role"]!!.jsonPrimitive.content)
        val result = read["content"]!!.jsonObject["data"]!!.jsonArray.single().jsonObject
        assertEquals("toolu_1", result["tool_use_id"]!!.jsonPrimitive.content)
        assertTrue(result["content"]!!.jsonPrimitive.content.endsWith("…"))
    }

    @Test
    fun aDocumentTooBigEvenCutShortIsNotStored() {
        val value = buildJsonObject { putJsonArray("n") { repeat(200_000) { add(JsonPrimitive(it)) } } }
        assertNull(StoredJson.encode(value))
    }

    /** The old CLI's agent state: every permission ever asked, with its arguments, in `completedRequests`. */
    @Test
    fun anAgentStateTooBigLosesItsPermissionHistoryFirst() {
        val value = buildJsonObject {
            put("controlledByUser", false)
            putJsonObject("requests") {
                putJsonObject("pending") {
                    put("tool", "Write")
                    putJsonObject("arguments") { put("file_path", "/a") }
                }
            }
            putJsonObject("completedRequests") {
                repeat(20_000) { n ->
                    putJsonObject("done-$n") {
                        put("tool", "Edit")
                        put("status", "approved")
                        putJsonObject("arguments") { put("old_string", "a$n"); put("new_string", "b$n") }
                    }
                }
            }
        }
        assertNull(StoredJson.encode(value))
        val stored = StoredJson.encodeAgentState(value)!!
        assertTrue(bytes(stored) <= StoredJson.MAX_BYTES)
        val read = Json.parseToJsonElement(stored).jsonObject
        assertFalse("completedRequests" in read)
        assertEquals("Write", read["requests"]!!.jsonObject["pending"]!!.jsonObject["tool"]!!.jsonPrimitive.content)

        val small = JsonObject(mapOf("controlledByUser" to JsonPrimitive(true)))
        assertEquals(small.toString(), StoredJson.encodeAgentState(small))
    }
}
