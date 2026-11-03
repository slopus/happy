package com.slopus.happy.call

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * The hosted agent's five client tools (iOS `CallTool`). Their schemas live
 * here, the one place both the hosted agent's configuration and this phone
 * read them from; the relay's tools (`sendMessageToSession`,
 * `processPermissionRequest`) are not among them and never run for this
 * agent. There is no tool for permissions or questions: those stay in the app.
 */
enum class CallTool(val wire: String) {
    ListSessions("listSessions"),
    GetSessionContext("getSessionContext"),
    OpenSession("openSession"),
    SetSessionWatch("setSessionWatch"),
    SendMessage("sendMessage");

    /** The parameters, as JSON Schema for the hosted agent's client tool. */
    val parameters: JsonObject get() = when (this) {
        ListSessions -> schema(
            "query" to "Words in the conversation's name, or empty for all.",
            "cursor" to "The nextCursor of the previous page.",
            required = emptyList(),
        )
        GetSessionContext -> schema("targetRef" to "A targetRef from the context or listSessions.", required = listOf("targetRef"))
        OpenSession -> schema(
            "targetRef" to "The conversation to show on screen.",
            required = listOf("targetRef", "focusRevision"),
            revision = true,
        )
        SetSessionWatch -> buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("targetRef") { put("type", "string"); put("description", "The conversation to follow, or stop following.") }
                putJsonObject("enabled") { put("type", "boolean"); put("description", "true to follow, false to stop.") }
            }
            put("required", buildJsonArray { add(JsonPrimitive("targetRef")); add(JsonPrimitive("enabled")) })
        }
        SendMessage -> schema(
            "targetRef" to "The conversation to send to.",
            "text" to "The person's message, exactly as they asked to send it.",
            required = listOf("targetRef", "text", "focusRevision"),
            revision = true,
        )
    }

    companion object {
        fun of(name: String): CallTool? = entries.firstOrNull { it.wire == name }

        private fun schema(vararg properties: Pair<String, String>, required: List<String>, revision: Boolean = false) = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                for ((name, description) in properties) putJsonObject(name) { put("type", "string"); put("description", description) }
                if (revision) putJsonObject("focusRevision") { put("type", "integer"); put("description", "The context's focusRevision this request was made under.") }
            }
            put("required", buildJsonArray { required.forEach { add(JsonPrimitive(it)) } })
        }
    }
}

/** One tool call as the SDK hands it over. */
data class CallToolCall(val id: String, val name: String, val parameters: JsonObject, val expectsResponse: Boolean = true)

data class CallToolResult(val text: String, val isError: Boolean = false) {
    companion object {
        fun json(value: JsonObject, isError: Boolean = false) = CallToolResult(CallJson.encode(value), isError)
        fun refused(reason: String) = json(buildJsonObject { put("ok", false); put("reason", reason) }, isError = true)
    }
}

/** The SDK's parameters (Gson's maps, lists and numbers) as JSON. */
internal fun Any?.toJson(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (key, value) -> key.toString() to value.toJson() })
    is Iterable<*> -> buildJsonArray { this@toJson.forEach { add(it.toJson()) } }
    is Array<*> -> buildJsonArray { this@toJson.forEach { add(it.toJson()) } }
    else -> JsonPrimitive(toString())
}
