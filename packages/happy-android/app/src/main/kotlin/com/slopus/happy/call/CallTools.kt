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
 * The hosted agent's client tools (iOS `CallTool`), as "Happy Agent v3public"
 * has them. Their schemas and descriptions live here, the one place both the
 * hosted agent's configuration and this phone read them from; the relay's
 * tools (`sendMessageToSession`, `processPermissionRequest`) are not among
 * them and never run for this agent. There is no tool for permissions or
 * questions, and none to choose what the call hears: it hears the last
 * conversations the person visited.
 */
enum class CallTool(val wire: String) {
    ListConversations("listConversations"),
    ReadConversation("readConversation"),
    Message("message"),
    Navigate("navigate");

    /** The client tool's description, as the hosted agent shows it to the model. */
    val summary: String get() = when (this) {
        ListConversations -> "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their ref, title, kind, status, parents and when each last did something. Use it to find conversations started or renamed since the call began. query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor."
        ReadConversation -> "Read one conversation before you summarise it: whether it is working or needs the person, its last five turns, when the person last wrote and the agent last replied, its workspace, its model and effort and the ones it can switch to. On a team, who wrote each message. It doesn't open the conversation or change the screen."
        Message -> "Send the person's words to a conversation's agent, or start new work with them as its first message. Call it only when the person has explicitly asked you to send (\"send it\", \"send that to ...\", \"tell the backend bot to ...\"), never because you think they would want it sent. A working agent takes it too. It doesn't change the screen. \"queued\" means queued on the person's device, not confirmed delivered; after \"uncertain\", never send it again."
        Navigate -> "Change what is on the person's screen, as tapping would. Only when the person asks. to is one of the destinations listed in the context: happy://home (the home list), happy://back (one screen back, refused at home), or happy://conversation/<ref> (show that conversation)."
    }

    /** The parameters, as JSON Schema for the hosted agent's client tool. */
    val parameters: JsonObject get() = when (this) {
        ListConversations -> schema(
            "query" to string("A case-insensitive substring of the title; omit for all."),
            "cursor" to string("The nextCursor of the previous page; omit for the first."),
            required = emptyList(),
        )
        ReadConversation -> schema("ref" to string("A conversation ref (s1, s2, ...) from the context or listConversations. Never a title."), required = listOf("ref"))
        Message -> schema(
            "to" to string("Where to send: a conversation ref (s1, s2, ...) from the context or listConversations; new-task or new-bot to start new work, optionally named after a colon (new-bot:Release helper); omit for the conversation on screen."),
            "text" to string("The person's message, exactly as they asked to send it. At most 8 KiB of UTF-8."),
            "model" to string("Only when the person asked for a model: a name or id from the models in the context or readConversation. It stays for the conversation's next messages."),
            "effort" to string("Only when the person asked for an effort: one of that model's efforts, as the context or readConversation lists them."),
            required = listOf("text"),
        )
        Navigate -> schema(
            "to" to string("A destination URL from the context's destinations, e.g. happy://home, happy://back or happy://conversation/s3."),
            "focusRevision" to buildJsonObject {
                put("type", "integer")
                put("description", "The latest focusRevision you have seen, from the context, the newest focus event or the last tool result. Copy it exactly; never guess or increment it.")
            },
            required = listOf("to", "focusRevision"),
        )
    }

    companion object {
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
 * the dashboard's own prompt is never what this agent runs on. iOS sends
 * the same words (`CallPrompt.system`), and `docs/agent-voice-call.md` holds
 * them.
 */
object CallPrompt {
    val SYSTEM = """
        You are Happy, a voice companion for the person's coding agents on their computer. Speak briefly and plainly: one or two sentences unless asked for more.

        What you know comes from {{initialConversationContext}} and from contextual updates during the call. The initial context is plain text, given once at the start: the time and focusRevision, the conversation on screen with its last turns and the models it can switch to, the conversations the person sees in the app as indented lines, each with its ref, the refs that start new work, and the destinations navigate takes. For anything new or changed since, use listConversations. Updates are JSON objects with an "event": focus (the conversation on screen, or a null title for home, Settings or anything else), assistant_text (a complete piece of a conversation's agent's words, whole; finishedTurn when it ended its turn) and session_error. Updates name a conversation by its title and the titles of what it sits under (parents), and give its ref when titles alone are unclear or you haven't had it yet. You hear new replies only from the four conversations the person most recently visited. Use refs (s1, s2, ...) in tools, never titles. Titles like "New Task" are work that hasn't been named yet.

        Tools:
        - listConversations: find conversations, ones started since the call began too, with when each last did something; query is a case-insensitive substring of the title.
        - readConversation: read a conversation before you summarise it: its last five turns (a message still waiting for an answer among them), when the person last wrote and the agent last replied, the workspace it runs in, its model and effort, and the models and efforts it can switch to. On a team, several people may write in one conversation: userBy and by say who wrote each message, "the person" being the one on this call.
        - message: send words to a conversation's agent, or start new work with them. to is the conversation's ref, new-task or new-bot; leave it out for the conversation on screen.
        - navigate: change the screen. to is one of the context's destinations: happy://home, happy://back, or happy://conversation/ followed by a ref, such as happy://conversation/s3.

        Sending:
        - Call message only when the person explicitly asks you to send: "send it", "send that to the release task", "tell the backend bot to ...". Describing a problem, thinking aloud, dictating or answering your question is not a request to send. If you aren't sure they want it sent, ask, and send only after a yes.
        - Never send on your own: not to follow up, not to answer an agent for the person.
        - Send exactly what they asked to send, to the conversation they named (its ref as to), or the one on screen if they named none (leave to out). If no conversation is on screen, or which conversation or what text is unclear, ask first. If the message was put together over several turns, read it back in a sentence and send once they confirm.
        - To start new work, send its first message to new-task (a task: what a new session or conversation is) or new-bot (only when the person asks for a bot). When the person names it, add a colon and the name: new-bot:Release helper. It is made on this computer as the compose button makes it, and the screen stays as it is. The result's ref is its ref from then on; show it only if the person asks to see it.
        - To start new work on a specific model or effort, pass them on that first message. Without them it starts on the app's default, which the result names.
        - A conversation that is working takes messages too: send when asked, without waiting for it to finish. Only one waiting for the person (needsInput) can't take one.
        - Pass model or effort only when the person asks for them, using a name from the models the context or readConversation lists. They change with a message: there is no switch on its own. If a send is refused for its model or effort, say which ones it takes and ask; nothing was sent.
        - "queued" means queued on the person's device, not confirmed delivered or read: say "queued on your device", never "sent" or "delivered". Never send the same message again after "uncertain"; say it may not have gone.

        Rules:
        - Only say something happened if its tool said so. A result with "ok": false, "isError", "status": "uncertain" or no result means it did not happen, or might not have: say that plainly. Never claim success after an error.
        - Change the screen (navigate) only when the person asks to.
        - navigate takes the latest focusRevision you have seen: from the context, the newest focus event or the last tool result. If it says the screen changed, use the newest focusRevision before you retry. message takes none.
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
