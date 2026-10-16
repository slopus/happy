package com.slopus.happy.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * A session-protocol envelope, validated like typesRaw.ts
 * `sessionEnvelopeSchema`: [parse] returns null for anything that schema
 * rejects, including its role refinements.
 */
internal data class SessionEnvelope(
    val id: String,
    val time: Long,
    val role: String,
    val turn: String?,
    val author: SessionAuthor?,
    val subagent: String?,
    val claudeUuid: String?,
    val codexItemId: String?,
    val usage: UsageData?,
    val ev: SessionEvent,
) {
    companion object {
        private val CUID = Regex("^[a-z][a-z0-9]{1,31}$")

        fun parse(o: JsonObject): SessionEnvelope? {
            val id = o["id"].str ?: return null
            val time = o["time"].long ?: return null
            val role = o["role"].str?.takeIf { it == "user" || it == "agent" } ?: return null
            val turn = optionalString(o, "turn") ?: return null
            val subagent = optionalString(o, "subagent") ?: return null
            if (subagent.value != null && !CUID.matches(subagent.value)) return null
            val claudeUuid = optionalString(o, "claudeUuid") ?: return null
            val codexItemId = optionalString(o, "codexItemId") ?: return null
            if (claudeUuid.value == "" || codexItemId.value == "") return null
            val author = if (o["author"].isNullOrAbsent) {
                null
            } else {
                val a = o["author"].obj ?: return null
                val owner = a["owner"]
                if (!owner.isNullOrAbsent && owner.bool == null) return null
                SessionAuthor(a["id"].str ?: return null, a["name"].str ?: return null, owner.bool)
            }
            val usage = if (o["usage"].isNullOrAbsent) null else UsageData.parse(o["usage"]) ?: return null
            val ev = SessionEvent.parse(o["ev"].obj ?: return null) ?: return null
            if ((ev is SessionEvent.Service || ev == SessionEvent.Start || ev == SessionEvent.Stop) && role != "agent") {
                return null
            }
            return SessionEnvelope(
                id, time, role, turn.value, author, subagent.value, claudeUuid.value, codexItemId.value, usage, ev,
            )
        }

        private class Optional(val value: String?)

        /** An absent or string field; null when the field holds anything else. */
        private fun optionalString(o: JsonObject, key: String): Optional? {
            val value = o[key]
            if (value.isNullOrAbsent) return Optional(null)
            return value.str?.let(::Optional)
        }
    }
}

internal sealed interface SessionEvent {
    data class Text(val text: String, val thinking: Boolean) : SessionEvent
    data class Service(val text: String) : SessionEvent
    data class ToolCallStart(
        val call: String,
        val name: String,
        val title: String,
        val description: String,
        val args: JsonObject,
    ) : SessionEvent
    data class ToolCallEnd(val call: String, val result: String?, val isError: Boolean) : SessionEvent
    data class File(val ref: String, val name: String, val size: JsonElement, val image: JsonObject?) : SessionEvent
    data object TurnStart : SessionEvent
    data object Start : SessionEvent
    data object TurnEnd : SessionEvent
    data object Stop : SessionEvent
    data class Accepted(val ref: String) : SessionEvent
    data class Rejected(val ref: String, val reason: String) : SessionEvent

    companion object {
        private val TURN_END_STATUSES = setOf("completed", "failed", "cancelled")

        fun parse(ev: JsonObject): SessionEvent? = when (ev["t"].str) {
            "text" -> {
                val thinking = ev["thinking"]
                if (!thinking.isNullOrAbsent && thinking.bool == null) null
                else Text(ev["text"].str ?: return null, thinking.bool == true)
            }
            "service" -> Service(ev["text"].str ?: return null)
            "tool-call-start" -> ToolCallStart(
                call = ev["call"].str ?: return null,
                name = ev["name"].str ?: return null,
                title = ev["title"].str ?: return null,
                description = ev["description"].str ?: return null,
                args = ev["args"].obj ?: return null,
            )
            "tool-call-end" -> {
                val result = ev["result"]
                val isError = ev["isError"]
                if ((!result.isNullOrAbsent && result.str == null) || (!isError.isNullOrAbsent && isError.bool == null)) {
                    null
                } else {
                    ToolCallEnd(ev["call"].str ?: return null, result.str, isError.bool == true)
                }
            }
            "file" -> {
                val image = ev["image"]
                val imageObject = if (image.isNullOrAbsent) {
                    null
                } else {
                    image.obj?.takeIf { it["width"].num != null && it["height"].num != null } ?: return null
                }
                File(ev["ref"].str ?: return null, ev["name"].str ?: return null, ev["size"]?.takeIf { it.num != null } ?: return null, imageObject)
            }
            "turn-start" -> TurnStart
            "start" -> Start
            "turn-end" -> if (ev["status"].str in TURN_END_STATUSES) TurnEnd else null
            "stop" -> Stop
            "user-message-accepted" -> {
                if (ev["id"].str == null || ev["runId"].str == null) null else Accepted(ev["ref"].str ?: return null)
            }
            "user-message-rejected" -> Rejected(ev["ref"].str ?: return null, ev["reason"].str ?: return null)
            else -> null
        }
    }
}
