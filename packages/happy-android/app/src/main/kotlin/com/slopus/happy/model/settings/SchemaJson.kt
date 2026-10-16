package com.slopus.happy.model.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * Readers for zod-style schemas over JSON. A value that doesn't match throws
 * [SchemaMismatch], which fails the whole parse as zod's `safeParse` does.
 * JSON has no `undefined`: an absent key is zod's undefined, and `null` is
 * only accepted where the schema says `.nullable()` / `.nullish()`.
 */
internal class SchemaMismatch(message: String) : Exception(message)

internal val EmptyJson = JsonObject(emptyMap())

internal fun JsonElement.asBoolean(): Boolean =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: throw SchemaMismatch("not a boolean: $this")

internal fun JsonElement.asString(): String =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw SchemaMismatch("not a string: $this")

internal fun JsonElement.asNumber(): Double =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: throw SchemaMismatch("not a number: $this")

internal fun JsonElement.asObject(): JsonObject = this as? JsonObject ?: throw SchemaMismatch("not an object: $this")

internal fun JsonElement.asArray(): JsonArray = this as? JsonArray ?: throw SchemaMismatch("not an array: $this")

/** `.nullable()`: null reads as null, anything else as [read] says. */
internal inline fun <T> JsonElement.orNull(read: JsonElement.() -> T): T? = if (this is JsonNull) null else read()

internal fun JsonElement.asEnum(values: Collection<String>): String =
    asString().also { if (it !in values) throw SchemaMismatch("not one of $values: $it") }

internal fun Boolean?.toJson(): JsonElement = this?.let(::JsonPrimitive) ?: JsonNull
internal fun String?.toJson(): JsonElement = this?.let(::JsonPrimitive) ?: JsonNull
