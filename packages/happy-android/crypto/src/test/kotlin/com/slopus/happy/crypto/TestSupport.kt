package com.slopus.happy.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals

/** Replays the exact random bytes a vector recorded, in order, and checks they were all used. */
class ScriptedRandom(vararg chunks: ByteArray) : RandomSource {
    private val queue = ArrayDeque(chunks.toList())

    override fun nextBytes(size: Int): ByteArray {
        val chunk = queue.removeFirstOrNull() ?: error("Unscripted random request for $size bytes")
        assertEquals("scripted random chunk length", size, chunk.size)
        return chunk.copyOf()
    }

    fun assertDrained() = assertEquals("unused scripted random chunks", 0, queue.size)
}

/** crypto/src/test/resources/happy-ts-vectors.json, produced from happy-app's TypeScript by tools/testvectors. */
object TsVectors {
    private val root: JsonObject by lazy {
        val text = requireNotNull(TsVectors::class.java.getResource("/happy-ts-vectors.json")) {
            "happy-ts-vectors.json missing from test resources"
        }.readText()
        Json.parseToJsonElement(text).jsonObject
    }

    fun group(name: String): List<JsonObject> = root.getValue(name).jsonArray.map { it.jsonObject }
}

fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content
fun JsonObject.hex(key: String): ByteArray = decodeHex(str(key))
fun JsonObject.strings(key: String): List<String> = (getValue(key) as JsonArray).map { it.jsonPrimitive.content }

fun ByteArray.toHex(): String = encodeHex(this).lowercase()
