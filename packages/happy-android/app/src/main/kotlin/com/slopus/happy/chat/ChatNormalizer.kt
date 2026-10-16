package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body
import com.slopus.happy.data.MessageRecord
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Decrypted record JSON to [NormalizedMessage], after happy-app's typesRaw.ts,
 * for the formats current producers write:
 *
 * - `user` / `text` (the app's own sends, with every `meta` field)
 * - `session` envelopes, direct or wrapped in `{type: 'session', data}`
 *   (under the `session` role, or the `agent` role as happy-app accepts)
 * - agent `event` (mode switch, message, limit, ready, receipts)
 * - Gemini `acp` records
 *
 * Retired kinds (agent `output` and `codex`, ACP from other providers; see
 * happy-ios AGENTS.md "Record kinds"), unknown kinds and records this device could not
 * decrypt become a [Body.Unsupported] placeholder. A current kind whose fields
 * fail happy-app's schema is dropped, as happy-app drops it; so are the
 * control records happy-app never renders (turn-start, subagent start/stop,
 * ACP task lifecycle and token counts).
 */
object ChatNormalizer {
    private val json = Json { ignoreUnknownKeys = true }

    fun normalize(record: MessageRecord): NormalizedMessage? {
        val raw = record.contentJson?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
        return normalize(record.id, record.localId, record.createdAt, raw)
    }

    /** Null [raw] is a record this device could not open. */
    fun normalize(id: String, localId: String?, createdAt: Long, raw: JsonElement?): NormalizedMessage? {
        fun unsupported(kind: String) = NormalizedMessage(id, localId, createdAt, Body.Unsupported(kind))
        val record = raw.obj ?: return unsupported("undecryptable")
        val role = record["role"].str
        val content = record["content"].obj
        val meta = record["meta"]
        if (!meta.isNullOrAbsent && meta.obj == null) return null
        val messageMeta = MessageMeta.of(meta)
        val type = content?.get("type").str
        when (role) {
            "user" -> {
                if (type != "text") return unsupported("user.${type ?: "unknown"}")
                val text = content?.get("text").str ?: return null
                return NormalizedMessage(id, localId, createdAt, Body.User(text), meta = messageMeta)
            }
            "session" -> {
                content ?: return null
                // New direct shape `{role: 'session', content: envelope}`, or
                // the canonical wrapped one.
                val looksLikeEnvelope = type != "session" &&
                    content["id"].str != null && content["role"].str != null && content.containsKey("ev")
                val envelope = when {
                    looksLikeEnvelope -> content
                    type == "session" -> content["data"].obj ?: return null
                    else -> return unsupported("session.${type ?: "unknown"}")
                }
                return normalizeSessionEnvelope(envelope, localId, messageMeta)
            }
            "agent" -> {
                content ?: return null
                val data = content["data"]
                return when (type) {
                    "event" -> {
                        if (content["id"].str == null) return null
                        val event = AgentEvent.parse(data) ?: return null
                        NormalizedMessage(id, localId, createdAt, Body.Event(event))
                    }
                    // The same envelope under the agent role, as happy-app reads it.
                    "session" -> normalizeSessionEnvelope(data.obj ?: return null, localId, messageMeta)
                    "acp" -> if (content["provider"].str == "gemini") {
                        normalizeGemini(id, localId, createdAt, data.obj ?: return null, messageMeta)
                    } else {
                        unsupported("agent.acp.${content["provider"].str ?: "unknown"}")
                    }
                    else -> unsupported("agent.${type ?: "unknown"}.${data.obj?.get("type").str ?: "unknown"}")
                }
            }
            else -> return unsupported(role ?: "unknown")
        }
    }

    private fun normalizeSessionEnvelope(
        envelope: JsonObject,
        localId: String?,
        meta: MessageMeta?,
    ): NormalizedMessage? {
        val e = SessionEnvelope.parse(envelope) ?: return null
        val ev = e.ev
        val isUsageOnlyServiceEvent = e.role == "agent" && ev is SessionEvent.Service &&
            ev.text.isBlank() && e.usage != null
        // Send outcomes belong to the user message, not an assistant turn.
        val isReceipt = ev is SessionEvent.Accepted || ev is SessionEvent.Rejected
        // Agent envelopes carry a turn id; usage-only updates may arrive after
        // turn-end, when the producer has no turn left to attach them to.
        if (e.role == "agent" && e.turn == null && !isUsageOnlyServiceEvent && !isReceipt) return null

        val parentUUID = e.subagent
        val isSidechain = parentUUID != null
        fun message(body: Body, sidechain: Boolean = isSidechain, turn: String? = e.turn, usage: UsageData? = e.usage) =
            NormalizedMessage(
                id = e.id, localId = localId, createdAt = e.time, body = body, isSidechain = sidechain,
                meta = meta, usage = usage, turn = turn,
            )

        return when (ev) {
            SessionEvent.TurnStart, SessionEvent.Start, SessionEvent.Stop -> null
            is SessionEvent.Accepted ->
                message(Body.Event(AgentEvent.UserMessageAccepted(ev.ref)), sidechain = false, turn = null, usage = null)
            is SessionEvent.Rejected ->
                message(Body.Event(AgentEvent.UserMessageRejected(ev.ref, ev.reason)), sidechain = false, turn = null, usage = null)
            SessionEvent.TurnEnd -> message(Body.Event(AgentEvent.Ready), sidechain = false, usage = null)
            is SessionEvent.Service -> message(
                Body.Agent(if (isUsageOnlyServiceEvent) emptyList() else listOf(AgentContent.Text(ev.text, e.id, parentUUID))),
            )
            is SessionEvent.Text -> {
                val visible = stripLeadingTaskNotificationWrappers(ev.text)
                if (visible != ev.text && visible.isBlank()) return null
                if (e.role == "user") {
                    NormalizedMessage(
                        id = e.id, localId = localId, createdAt = e.time, body = Body.User(visible), meta = meta,
                        claudeUuid = e.claudeUuid, codexItemId = e.codexItemId, author = e.author,
                    )
                } else {
                    val block = if (ev.thinking) {
                        AgentContent.Thinking(visible, e.id, parentUUID)
                    } else {
                        AgentContent.Text(visible, e.id, parentUUID)
                    }
                    message(Body.Agent(listOf(block))).copy(claudeUuid = e.claudeUuid, codexItemId = e.codexItemId)
                }
            }
            is SessionEvent.ToolCallStart -> message(
                Body.Agent(
                    listOf(
                        AgentContent.ToolUse(
                            id = ev.call, name = ev.name.ifEmpty { "unknown" }, title = ev.title, input = ev.args,
                            description = ev.description, uuid = e.id, parentUUID = parentUUID,
                        ),
                    ),
                ),
            )
            is SessionEvent.ToolCallEnd -> message(
                Body.Agent(
                    listOf(
                        AgentContent.ToolResult(
                            toolUseId = ev.call, content = ev.result?.let(::JsonPrimitive), isError = ev.isError,
                            uuid = e.id, parentUUID = parentUUID,
                        ),
                    ),
                ),
            )
            is SessionEvent.File -> {
                val input = buildJsonObject {
                    put("ref", ev.ref)
                    put("name", ev.name)
                    put("size", ev.size)
                    if (ev.image != null) put("image", ev.image)
                }
                val description = if (ev.image != null) {
                    "Attached image: ${ev.name} (${number(ev.image["width"].num!!)}x${number(ev.image["height"].num!!)})"
                } else {
                    "Attached file: ${ev.name}"
                }
                // The upload is finished by the time the event is sent: emit
                // the call and its result together so the tool shows as done.
                message(
                    Body.Agent(
                        listOf(
                            AgentContent.ToolUse(e.id, "file", null, input, description, e.id, parentUUID),
                            AgentContent.ToolResult(e.id, null, false, "${e.id}:result", e.id),
                        ),
                    ),
                )
            }
        }
    }

    private fun normalizeGemini(
        id: String,
        localId: String?,
        createdAt: Long,
        data: JsonObject,
        meta: MessageMeta?,
    ): NormalizedMessage? {
        fun agent(vararg content: AgentContent) =
            NormalizedMessage(id, localId, createdAt, Body.Agent(content.toList()), meta = meta)
        return when (val type = data["type"].str) {
            "message", "reasoning" -> agent(AgentContent.Text(data["message"].str ?: return null, id, null))
            "thinking" -> agent(AgentContent.Thinking(data["text"].str ?: return null, id, null))
            "tool-call" -> {
                val callId = data["callId"].str ?: return null
                val name = data["name"].str ?: return null
                val uuid = data["id"].str ?: return null
                agent(AgentContent.ToolUse(callId, name.ifEmpty { "unknown" }, null, data["input"], null, uuid, null))
            }
            "tool-result", "tool-call-result" -> {
                val callId = data["callId"].str ?: return null
                val uuid = data["id"].str ?: return null
                val isError = type == "tool-result" && data["isError"].bool == true
                if (type == "tool-result" && !data["isError"].isNullOrAbsent && data["isError"].bool == null) return null
                agent(AgentContent.ToolResult(callId, data["output"], isError, uuid, null))
            }
            "file-edit" -> {
                val description = data["description"].str ?: return null
                val filePath = data["filePath"].str ?: return null
                val uuid = data["id"].str ?: return null
                val input = buildJsonObject {
                    put("filePath", filePath)
                    put("description", description)
                    for (key in listOf("diff", "oldContent", "newContent")) {
                        val value = data[key]
                        if (value.isNullOrAbsent) continue
                        put(key, value.str ?: return null)
                    }
                }
                agent(AgentContent.ToolUse(uuid, "file-edit", null, input, description, uuid, null))
            }
            "terminal-output" -> {
                val text = data["data"].str ?: return null
                val callId = data["callId"].str ?: return null
                agent(AgentContent.ToolResult(callId, JsonPrimitive(text), false, id, null))
            }
            "permission-request" -> {
                val permissionId = data["permissionId"].str ?: return null
                val toolName = data["toolName"].str ?: return null
                val description = data["description"].str ?: return null
                val options = data["options"]?.takeUnless { it.isNullOrAbsent } ?: JsonObject(emptyMap())
                agent(AgentContent.ToolUse(permissionId, toolName, null, options, description, id, null))
            }
            // Status and metrics, never rendered.
            "task_started", "task_complete", "turn_aborted", "token_count", "token-count" -> null
            else -> NormalizedMessage(id, localId, createdAt, Body.Unsupported("agent.acp.${type ?: "unknown"}"))
        }
    }

    private fun number(value: Double): String =
        if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()
}

private const val TASK_NOTIFICATION_OPEN = "<task-notification>"
private const val TASK_NOTIFICATION_CLOSE = "</task-notification>"

/**
 * Removes complete leading `<task-notification>` envelopes (background-task
 * control records) and keeps any real text after them (happy-wire
 * controlMessages.ts). Incomplete wrappers are left untouched.
 */
fun stripLeadingTaskNotificationWrappers(text: String): String {
    var remainder = text.trimStart()
    var stripped = false
    while (remainder.startsWith(TASK_NOTIFICATION_OPEN)) {
        var depth = 1
        var cursor = TASK_NOTIFICATION_OPEN.length
        while (depth > 0) {
            val nextOpen = remainder.indexOf(TASK_NOTIFICATION_OPEN, cursor)
            val nextClose = remainder.indexOf(TASK_NOTIFICATION_CLOSE, cursor)
            if (nextClose == -1) return if (stripped) remainder else text
            if (nextOpen != -1 && nextOpen < nextClose) {
                depth += 1
                cursor = nextOpen + TASK_NOTIFICATION_OPEN.length
            } else {
                depth -= 1
                cursor = nextClose + TASK_NOTIFICATION_CLOSE.length
            }
        }
        stripped = true
        remainder = remainder.substring(cursor).trimStart()
    }
    return if (stripped) remainder else text
}
