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
 * The hosted agent's client tools (iOS `CallTool`). Their schemas and
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
    SendMessage("sendMessage"),
    NewWork("newWork"),
    GoBack("goBack"),
    GoHome("goHome");

    /** The client tool's description, as the hosted agent shows it to the model. */
    val summary: String get() = when (this) {
        ListSessions -> "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their targetRef, title, kind, status and parents (the titles of what each sits under). query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor."
        GetSessionContext -> "Read one conversation: whether it is working or needs the person, and its last five turns, each the person's message and the agent's last words, or as much of the pair as there is; the person's latest message, if nothing has answered it yet, is the fifth (pendingUserMessage). On a team, who wrote each message (userBy, by). It doesn't open the conversation or change what you hear from."
        OpenSession -> "Show a conversation on the person's screen. Like any conversation they open, it joins the four most recently visited, whose new replies you hear."
        SendMessage -> "Send the person's message to a conversation's agent, exactly as given (at most 8 KiB of UTF-8). Call it only when the person has explicitly asked you to send it (\"send it\", \"send that to …\"), never because you think they would want it sent. A working agent takes it too, as the app's composer sends it. model and effort switch the conversation first, only when the person asked for that. It doesn't open the conversation. \"queued\" means queued on the person's device, not confirmed delivered or read; after \"uncertain\", never send it again."
        NewWork -> "Start new work as the app's compose button does, without opening it or changing the screen: a task (what a new session or conversation is) or a bot, made on the computer by its first message. Nothing is sent: send that message with sendMessage to the targetRef this returns, only when the person asks you to send it. Until then it isn't listed; openSession shows it if the person asks to see it."
        GoBack -> "Go back one screen, as the back button does: close what is open over the app, or leave the screen on top for the one under it. Refused at home, where there is nothing to go back to."
        GoHome -> "Go to the home screen, the list of the person's bots, tasks and projects, closing every screen over it."
    }

    /** The parameters, as JSON Schema for the hosted agent's client tool. */
    val parameters: JsonObject get() = when (this) {
        ListSessions -> schema(
            "query" to string("A case-insensitive substring of the title; omit for all."),
            "cursor" to string("The nextCursor of the previous page; omit for the first."),
            required = emptyList(),
        )
        GetSessionContext -> schema("targetRef" to string(TARGET), required = listOf("targetRef"))
        OpenSession -> schema("targetRef" to string(TARGET), "focusRevision" to REVISION, required = listOf("targetRef", "focusRevision"))
        SendMessage -> schema(
            "targetRef" to string(TARGET),
            "text" to string("The person's message, exactly as they asked to send it."),
            "focusRevision" to REVISION,
            "model" to string("Only when the person asked for another model: its name or id, as getSessionContext lists them. It stays for the conversation's next messages."),
            "effort" to string("Only when the person asked for another effort: one of the model's efforts, as getSessionContext lists them."),
            required = listOf("targetRef", "text", "focusRevision"),
        )
        NewWork -> schema(
            "kind" to buildJsonObject {
                put("type", "string")
                put("enum", buildJsonArray { add(JsonPrimitive("task")); add(JsonPrimitive("bot")) })
                put("description", "task, unless the person asked for a bot.")
            },
            "name" to string("The name the person gave it; omit for its first message to name it."),
            required = listOf("kind"),
        )
        GoBack -> schema("focusRevision" to REVISION, required = listOf("focusRevision"))
        GoHome -> schema(required = emptyList())
    }

    companion object {
        private const val TARGET = "A targetRef from the context or listSessions."
        private val REVISION = buildJsonObject { put("type", "integer"); put("description", "The latest focusRevision you have seen.") }

        fun of(name: String): CallTool? = entries.firstOrNull { it.wire == name }

        private fun string(description: String) = buildJsonObject { put("type", "string"); put("description", description) }

        private fun schema(vararg properties: Pair<String, JsonObject>, required: List<String>) = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") { for ((name, property) in properties) put(name, property) }
            put("required", buildJsonArray { required.forEach { add(JsonPrimitive(it)) } })
        }
    }
}

/**
 * The hosted agent's system prompt, sent by this phone with every call (the
 * agent's prompt override), so the prompt and the tools above ship together;
 * the dashboard's own prompt is only a fallback for older builds. iOS sends
 * the same words (`CallPrompt.system`), and `docs/agent-voice-call.md` holds
 * them.
 */
object CallPrompt {
    val SYSTEM = """
        You are Happy, a voice companion for the person's coding agents on their computer. Speak briefly and plainly: one or two sentences unless asked for more.

        What you know comes from {{initialConversationContext}} (JSON) and from contextual updates during the call, each a JSON object with an "event": directory (the conversations the person sees in the app, as indented lines, each with its ref), directory_entries (more of them), focus (the conversation on screen, or a null title for home, Settings or anything else), assistant_text (a complete piece of a conversation's agent's words, whole; finishedTurn when it ended its turn) and session_error. Updates name a conversation by its title and the titles of what it sits under (parents); find its ref in the directory lines, or use the ref an update gives when titles alone are unclear. You hear new replies only from the four conversations the person most recently visited. Use refs (s1, s2, ...) in tools, never titles. Titles like "New Task" are work that hasn't been named yet.

        Tools:
        - listSessions: find conversations, with when each last did something; query is a case-insensitive substring of the title.
        - getSessionContext: read a conversation before you summarise it: its last five turns (a message still waiting for an answer among them), when the person last wrote and the agent last replied, the workspace it runs in, its model and effort, and the models and efforts it can switch to. On a team, several people may write in one conversation: userBy and by say who wrote each message, "the person" being the one on this call.
        - openSession: show a conversation on the person's screen.
        - newWork: start a new task or a new bot, as the compose button does, without opening it: the screen stays as it is. A new session or conversation is a task unless the person asks for a bot. It is made on the computer by its first message; open it with openSession only if the person asks to see it.
        - goBack: go back one screen. goHome: go to the home screen.
        - sendMessage: send words to a conversation's agent.

        Sending:
        - Call sendMessage only when the person explicitly asks you to send: "send it", "send that to the release task", "tell the backend bot to ...". Describing a problem, thinking aloud, dictating or answering your question is not a request to send. If you aren't sure they want it sent, ask, and send only after a yes.
        - Never send on your own: not to follow up, not to answer an agent for the person, not right after newWork.
        - Send exactly what they asked to send, to the conversation they named, or the one on screen if they named none. If which conversation or what text is unclear, ask first. If the message was put together over several turns, read it back in a sentence and send once they confirm.
        - To start new work with a message, call newWork, then sendMessage to the targetRef it returns once the person asks you to send.
        - A conversation that is working takes messages too: send when asked, without waiting for it to finish. Only one waiting for the person (needsInput) can't take one.
        - Pass model or effort only when the person asks to change them, using a name from getSessionContext's models. They change with a message: there is no switch on its own. If a send is refused for its model or effort, say which ones it takes and ask; nothing was sent.
        - "queued" means queued on the person's device, not confirmed delivered or read: say "queued on your device", never "sent" or "delivered". Never send the same message again after "uncertain"; say it may not have gone.

        Rules:
        - Only say something happened if its tool said so. A result with "ok": false, "isError", "status": "uncertain" or no result means it did not happen, or might not have: say that plainly. Never claim success after an error.
        - Change the screen (openSession, goBack, goHome) only when the person asks to.
        - openSession, goBack and sendMessage take the latest focusRevision you have seen: from the context, the newest focus event or the last tool result. If a tool says the screen changed, use the newest focusRevision before you retry.
        - Updates need no answer of their own. Use what they say when the person asks, or when it bears on what you are saying.
        - Times come as "ago" (say that) and "at" (the person's local time, for when they ask exactly).
        - You cannot approve permissions or answer an agent's questions. When a conversation needs input, tell the person to answer it in the app.
        - Don't read code, paths or long logs aloud. Summarise them.
    """.trimIndent()
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
