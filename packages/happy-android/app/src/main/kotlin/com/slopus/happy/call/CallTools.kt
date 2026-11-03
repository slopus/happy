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
 * The hosted agent's four client tools (iOS `CallTool`). Their schemas and
 * descriptions live here, the one place both the hosted agent's
 * configuration and this phone read them from; the relay's tools
 * (`sendMessageToSession`, `processPermissionRequest`) are not among them and
 * never run for this agent. There is no tool for permissions or questions,
 * and none to choose what the call hears: it hears the last conversations
 * the person visited.
 */
enum class CallTool(val wire: String) {
    ListSessions("listSessions"),
    GetSessionContext("getSessionContext"),
    OpenSession("openSession"),
    SendMessage("sendMessage");

    /** The client tool's description, as the hosted agent shows it to the model. */
    val summary: String get() = when (this) {
        ListSessions -> "List the person's conversations (tasks, bots and chats) with their targetRef, title, kind and status. query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor."
        GetSessionContext -> "Read one conversation: whether it is working or needs the person, its last two finished turns (the person's message and the agent's final answer), and the person's latest message if nothing has answered it yet. It doesn't open the conversation or change what you hear from."
        OpenSession -> "Show a conversation on the person's screen. Like any conversation they open, it joins the four most recently visited, whose new replies you hear."
        SendMessage -> "Send the person's message to a conversation's agent, exactly as given (at most 8 KiB of UTF-8). It doesn't open the conversation. \"queued\" means queued on the person's device, not confirmed delivered or read; after \"uncertain\", never send it again."
    }

    /** The parameters, as JSON Schema for the hosted agent's client tool. */
    val parameters: JsonObject get() = when (this) {
        ListSessions -> schema(
            "query" to "A case-insensitive substring of the title; omit for all.",
            "cursor" to "The nextCursor of the previous page; omit for the first.",
            required = emptyList(),
        )
        GetSessionContext -> schema("targetRef" to TARGET, required = listOf("targetRef"))
        OpenSession -> schema("targetRef" to TARGET, required = listOf("targetRef", "focusRevision"), revision = true)
        SendMessage -> schema(
            "targetRef" to TARGET,
            "text" to "The person's message, exactly as they asked to send it.",
            required = listOf("targetRef", "text", "focusRevision"),
            revision = true,
        )
    }

    companion object {
        private const val TARGET = "A targetRef from the context or listSessions."

        fun of(name: String): CallTool? = entries.firstOrNull { it.wire == name }

        private fun schema(vararg properties: Pair<String, String>, required: List<String>, revision: Boolean = false) = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                for ((name, description) in properties) putJsonObject(name) { put("type", "string"); put("description", description) }
                if (revision) putJsonObject("focusRevision") { put("type", "integer"); put("description", "The latest focusRevision you have seen.") }
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
