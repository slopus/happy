package com.slopus.happy.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

// Strict readers for decrypted record JSON. Each returns null unless the value
// has exactly the JSON type asked for, the way a zod schema would reject it:
// a number is never read as a string, nor a string as a number.

internal val JsonElement?.obj: JsonObject? get() = this as? JsonObject

internal val JsonElement?.arr: JsonArray? get() = this as? JsonArray

internal val JsonElement?.str: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal val JsonElement?.bool: Boolean?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

internal val JsonElement?.num: Double?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

/** A finite number that fits a Long (timestamps, sizes), truncated. */
internal val JsonElement?.long: Long?
    get() = num?.takeIf { it >= Long.MIN_VALUE.toDouble() && it < Long.MAX_VALUE.toDouble() }?.toLong()

internal val JsonElement?.isNullOrAbsent: Boolean get() = this == null || this is JsonNull

/** A list of strings, or null if the value is not an array of strings only. */
internal val JsonElement?.strings: List<String>?
    get() {
        val array = arr ?: return null
        return array.map { it.str ?: return null }
    }

private val PrettyJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

/** JSON.stringify(value, null, 2): every dump and copy of tool, session and metadata JSON. */
internal fun prettyJson(element: JsonElement): String = PrettyJson.encodeToString(JsonElement.serializer(), element)
