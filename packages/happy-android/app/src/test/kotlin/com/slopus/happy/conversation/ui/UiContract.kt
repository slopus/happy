package com.slopus.happy.conversation.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The chat UI contract as happy-agent's client package publishes it for
 * implementations in other languages, vendored by `tools/chat-ui/vendor.sh`
 * into `src/test/resources/ui`: the catalog's schemas, with secret fields
 * marked, and the package's own conformance vectors.
 */
object UiContract {
    const val SCHEMA = "ui.schema.json"
    const val FIXTURES = "actions.fixtures.json"
    const val RECORD = "vendored.json"

    fun bytes(name: String): ByteArray = requireNotNull(UiContract::class.java.getResource("/ui/$name")) { "missing $name" }.readBytes()

    private fun json(name: String): JsonObject = Json.parseToJsonElement(bytes(name).decodeToString()).jsonObject

    val schema: JsonObject by lazy { json(SCHEMA) }
    val fixtures: JsonObject by lazy { json(FIXTURES) }
    val record: JsonObject by lazy { json(RECORD) }

    /** A section of the vectors, each an object. */
    fun vectors(section: String): List<JsonObject> = fixtures.getValue(section).jsonArray.map { it.jsonObject }.also { check(it.isNotEmpty()) { "no $section vectors" } }

    /** A component type's bundle in the schema: its `props`, and its `actions` by name. */
    fun component(type: String): JsonObject = schema.getValue("components").jsonObject.getValue(type).jsonObject

    /** The name of the keyword that marks a secret field. */
    val secretKeyword: String get() = schema.getValue("secretKeyword").jsonPrimitive.content

    /**
     * Whether [value] passes [schema], for the JSON Schema keywords the
     * catalog's schemas use. A keyword it doesn't know fails loudly, so a
     * schema that grows one is noticed here rather than passed.
     */
    fun passes(schema: JsonObject, value: JsonElement): Boolean {
        for ((keyword, rule) in schema) {
            val ok = when (keyword) {
                "type" -> when (rule.jsonPrimitive.content) {
                    "object" -> value is JsonObject
                    "array" -> value is JsonArray
                    "string" -> value is JsonPrimitive && value.isString
                    "integer" -> number(value)?.let { it % 1.0 == 0.0 } == true
                    "number" -> number(value) != null
                    "boolean" -> value is JsonPrimitive && !value.isString && value.booleanOrNull != null
                    "null" -> value is JsonNull
                    else -> error("unknown type $rule")
                }
                "const" -> value == rule
                "anyOf" -> rule.jsonArray.any { passes(it.jsonObject, value) }
                "required" -> value !is JsonObject || rule.jsonArray.all { it.jsonPrimitive.content in value }
                "properties" -> value !is JsonObject || rule.jsonObject.all { (name, child) -> value[name]?.let { passes(child.jsonObject, it) } ?: true }
                "additionalProperties" -> {
                    check(rule == JsonPrimitive(false)) { "additionalProperties: $rule" }
                    value !is JsonObject || value.keys.all { it in schema["properties"]?.jsonObject.orEmpty() }
                }
                // Any property, of any value.
                "patternProperties" -> rule == Json.parseToJsonElement("""{"^(.*)$":{}}""") || error("patternProperties: $rule")
                "items" -> value !is JsonArray || value.all { passes(rule.jsonObject, it) }
                "minItems" -> value !is JsonArray || value.size >= rule.jsonPrimitive.content.toInt()
                "maxItems" -> value !is JsonArray || value.size <= rule.jsonPrimitive.content.toInt()
                "minLength" -> string(value)?.let { it.length >= rule.jsonPrimitive.content.toInt() } ?: true
                "maxLength" -> string(value)?.let { it.length <= rule.jsonPrimitive.content.toInt() } ?: true
                "pattern" -> string(value)?.let { Regex(rule.jsonPrimitive.content).containsMatchIn(it) } ?: true
                "minimum" -> number(value)?.let { it >= rule.jsonPrimitive.content.toDouble() } ?: true
                "maximum" -> number(value)?.let { it <= rule.jsonPrimitive.content.toDouble() } ?: true
                "exclusiveMinimum" -> number(value)?.let { it > rule.jsonPrimitive.content.toDouble() } ?: true
                // A secret is marked, not constrained.
                else -> keyword == secretKeyword || error("unknown schema keyword \"$keyword\"")
            }
            if (!ok) return false
        }
        return true
    }

    private fun string(value: JsonElement): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun number(value: JsonElement): Double? = (value as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
}
