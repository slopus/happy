package com.slopus.happy.model

import com.slopus.happy.net.HappyJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

/** A document that does not match its schema: zod's failed `safeParse`. */
class SchemaException(message: String) : Exception(message)

/** One field's value as zod reads it: a JSON value to a typed one, or [SchemaException]. */
typealias FieldReader<T> = (JsonElement) -> T

/**
 * Reads a JSON object the way the zod schemas in happy-app's storageTypes.ts
 * do, so a document this app accepts is one happy-app accepts too:
 *
 * - [required]: present and of the right type (`z.string()`).
 * - [optional]: absent, or of the right type; an explicit null fails, as it
 *   does in zod (`.optional()`).
 * - [nullish]: absent, null, or of the right type (`.nullish()`).
 * - [caught]: anything that does not read is dropped (`.optional().catch(undefined)`).
 *
 * Unknown keys are kept by the caller as the raw object (`.passthrough()`).
 */
class JsonFields(val raw: JsonObject) {
    fun <T> required(key: String, read: FieldReader<T>): T {
        val value = raw[key]
        if (value == null || value is JsonNull) throw SchemaException("$key: required")
        return field(key) { read(value) }
    }

    fun <T> optional(key: String, read: FieldReader<T>): T? {
        val value = raw[key] ?: return null
        if (value is JsonNull) throw SchemaException("$key: null is not allowed")
        return field(key) { read(value) }
    }

    fun <T> nullish(key: String, read: FieldReader<T>): T? {
        val value = raw[key]
        if (value == null || value is JsonNull) return null
        return field(key) { read(value) }
    }

    fun <T> caught(key: String, read: FieldReader<T>): T? = try {
        nullish(key, read)
    } catch (_: SchemaException) {
        null
    }

    private inline fun <T> field(key: String, block: () -> T): T = try {
        block()
    } catch (e: SchemaException) {
        throw SchemaException("$key.${e.message}")
    }
}

object Read {
    val string: FieldReader<String> = { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: fail("string") }

    val boolean: FieldReader<Boolean> = {
        (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.booleanOrNull ?: fail("boolean")
    }

    /** `z.number()`: any finite JSON number. */
    val number: FieldReader<Double> = {
        (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.doubleOrNull?.takeIf { d -> d.isFinite() } ?: fail("number")
    }

    /** A `z.number()` timestamp or count, as a Long (fractions dropped, as JS consumers ignore them). */
    val long: FieldReader<Long> = { number(it).toLong() }

    /** `z.number().int()` */
    val int: FieldReader<Long> = {
        val d = number(it)
        if (d != Math.floor(d)) fail("integer")
        d.toLong()
    }

    /** `z.number().int().nonnegative()` */
    val nonNegativeInt: FieldReader<Long> = { int(it).also { v -> if (v < 0) fail("nonnegative") } }

    /** `z.number().int().positive()` */
    val positiveInt: FieldReader<Long> = { int(it).also { v -> if (v <= 0) fail("positive") } }

    val obj: FieldReader<JsonObject> = { it as? JsonObject ?: fail("object") }

    /** `z.any()`: whatever is there. */
    val any: FieldReader<JsonElement> = { it }

    fun <T> objectOf(read: (JsonFields) -> T): FieldReader<T> = { read(JsonFields(obj(it))) }

    fun <T> arrayOf(read: FieldReader<T>): FieldReader<List<T>> = { element ->
        val array = element as? JsonArray ?: fail("array")
        array.mapIndexed { index, item ->
            try {
                read(item)
            } catch (e: SchemaException) {
                throw SchemaException("[$index].${e.message}")
            }
        }
    }

    /** `z.record(z.string(), schema)` */
    fun <T> recordOf(read: FieldReader<T>): FieldReader<Map<String, T>> = { element ->
        obj(element).mapValues { (key, value) ->
            try {
                read(value)
            } catch (e: SchemaException) {
                throw SchemaException("$key.${e.message}")
            }
        }
    }

    /** `z.enum([...])` */
    fun oneOf(vararg values: String): FieldReader<String> = { string(it).also { v -> if (v !in values) fail("one of ${values.toList()}") } }

    fun fail(expected: String): Nothing = throw SchemaException("expected $expected")
}

/** Parses stored JSON text into an object, or null if it is not one. */
fun parseJsonObject(text: String?): JsonObject? {
    if (text == null) return null
    return try {
        HappyJson.parseToJsonElement(text).jsonObject
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
}
