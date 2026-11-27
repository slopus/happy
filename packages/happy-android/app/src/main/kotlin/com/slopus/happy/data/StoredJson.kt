package com.slopus.happy.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Decrypted JSON as the store keeps it. A cursor reads a row through a
 * 2 MB window: a bigger row throws SQLiteBlobTooBigException on every read
 * of its session, and a few rows near that size run the app out of memory.
 * A huge tool output in a message got there, and so did a long session's
 * permission history in its agent state (the old CLI keeps every
 * `completedRequests` entry with its arguments).
 *
 * A document over [MAX_BYTES] is stored with its long strings cut, shorter
 * until it fits, or not at all; it is measured before it is written out, so
 * the huge text is never built either.
 */
object StoredJson {
    /** The longest document stored, in UTF-8 bytes. */
    const val MAX_BYTES = 512 * 1024

    /**
     * The longest column HappyStore reads back; a longer one reads as null.
     * Rows stored before [MAX_BYTES] can be up to the window and past it;
     * two columns at this size still fit one window.
     */
    const val MAX_READ_BYTES = 768 * 1024

    /** Characters kept of each long string, tried in order. */
    private val STRING_LIMITS = intArrayOf(16 * 1024, 1024, 128)

    /** [value] as JSON text no longer than [MAX_BYTES], or null when even cut short it isn't. */
    fun encode(value: JsonElement): String? {
        if (fits(value)) return value.toString()
        for (limit in STRING_LIMITS) {
            val cut = cut(value, limit)
            if (fits(cut)) return cut.toString()
        }
        return null
    }

    /**
     * A session's agent state, as [encode]. When cutting strings is not
     * enough, the permission history (`completedRequests`) goes, so pending
     * requests and the rest still reach the chat.
     */
    fun encodeAgentState(value: JsonElement): String? {
        encode(value)?.let { return it }
        val state = value as? JsonObject ?: return null
        if ("completedRequests" !in state) return null
        return encode(JsonObject(state - "completedRequests"))
    }

    private fun fits(value: JsonElement): Boolean = size(value, MAX_BYTES.toLong()) <= MAX_BYTES

    /** At least [value]'s UTF-8 JSON length, counted only until it passes [budget]. */
    private fun size(value: JsonElement, budget: Long): Long = when (value) {
        is JsonObject -> {
            var n = 2L
            for ((key, entry) in value) {
                n += textSize(key) + 2 + size(entry, budget - n)
                if (n > budget) break
            }
            n
        }
        is JsonArray -> {
            var n = 2L
            for (entry in value) {
                n += 1 + size(entry, budget - n)
                if (n > budget) break
            }
            n
        }
        is JsonPrimitive -> if (value.isString) textSize(value.content) else value.content.length.toLong()
    }

    /** Escapes and non-ASCII counted at their most: three bytes a char, six an escaped control. */
    private fun textSize(text: String): Long {
        var n = 2L
        for (c in text) {
            n += when {
                c == '"' || c == '\\' -> 2
                c < ' ' -> 6
                c < '\u0080' -> 1
                else -> 3
            }
        }
        return n
    }

    private fun cut(value: JsonElement, limit: Int): JsonElement = when (value) {
        is JsonObject -> JsonObject(value.mapValues { cut(it.value, limit) })
        is JsonArray -> JsonArray(value.map { cut(it, limit) })
        is JsonPrimitive -> if (value.isString && value.content.length > limit) {
            // Never half of a surrogate pair.
            val end = if (value.content[limit - 1].isHighSurrogate()) limit - 1 else limit
            JsonPrimitive(value.content.substring(0, end) + "…")
        } else {
            value
        }
    }
}
