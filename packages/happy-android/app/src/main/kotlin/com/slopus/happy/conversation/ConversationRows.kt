package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Where a message this phone sent stands. */
@Immutable
sealed interface Delivery {
    data object Sent : Delivery
    /** Not yet taken by the agent's API. */
    data object Sending : Delivery
    /** Taken, waiting for a run to accept it. */
    data object Pending : Delivery
    data class Failed(val reason: String) : Delivery
}

/** One item of a tool's `media` presentation, addressed for `…/tool-calls/:id/media/:index`. */
@Immutable
data class MediaRef(val toolCallId: String, val index: Int, val item: MediaItem) {
    val key: String get() = "$toolCallId/$index"
}

/**
 * One row of a conversation as the phone draws it. A message becomes one
 * row per block it shows, keyed by message and block, so a streaming block
 * recomposes alone. Tool data is never shown: a tool call is its name,
 * status and the one line its presentation gives.
 */
@Immutable
sealed interface ConversationRow {
    val key: String

    data class User(
        override val key: String,
        val messageId: String,
        val text: String,
        val blocks: List<MarkdownBlock>,
        val pictures: List<Block.Image>,
        val delivery: Delivery,
    ) : ConversationRow

    data class Text(override val key: String, val text: String, val blocks: List<MarkdownBlock>) : ConversationRow

    /** The model's thinking summary: folded under one line until opened. */
    data class Reasoning(override val key: String, val text: String, val streaming: Boolean) : ConversationRow

    /**
     * A tool call as the chat's tool row shows it: [input] is what its
     * presentation says (the command, the file, the query) in the input
     * shape the legacy tool titles read, or the raw arguments where none.
     */
    data class Tool(override val key: String, val callId: String?, val name: String, val status: String, val detail: String?, val input: JsonObject?, val createdAt: Long) : ConversationRow

    /** A picture inline in a message. */
    data class Picture(override val key: String, val image: Block.Image) : ConversationRow

    /** Pictures, videos and files a tool presented, read on demand. */
    data class Media(override val key: String, val items: List<MediaRef>) : ConversationRow

    /** An artifact a tool made or changed. */
    data class Artifact(override val key: String, val artifactId: String, val title: String, val type: String?) : ConversationRow

    /** Another agent writing to this one: a collaborator or subtask reporting. */
    data class Collaborator(override val key: String, val senderAgentId: String, val text: String, val blocks: List<MarkdownBlock>) : ConversationRow

    /** A turn that failed, with Retry while it can help and nobody acted on it yet. */
    data class Failure(override val key: String, val messageId: String, val reason: String, val retryable: Boolean, val resolved: Boolean) : ConversationRow

    /** One line of housekeeping worth showing (a compaction). */
    data class Notice(override val key: String, val kind: NoticeKind) : ConversationRow
}

enum class NoticeKind { Compacting, Compacted, CompactionFailed }

/** What the working line says (desktop's `AgentWorkingStatus`), first match wins. */
enum class Activity { AwaitingAnswer, WaitingForModel, Thinking, PreparingTools, RunningTools, Working, Delegating }

/**
 * Builds rows from messages, keeping each built row while its message is
 * unchanged so Markdown is parsed once per change. Not thread-safe; the
 * conversation calls it from its one lane.
 */
class ConversationRowBuilder {
    private val cache = HashMap<String, Pair<Message, List<ConversationRow>>>()

    fun rows(message: Message, agentId: String, parentAgentId: String?, streaming: Boolean): List<ConversationRow> {
        cache[message.id]?.let { (built, rows) -> if (built == message && !streaming) return rows }
        val rows = build(message, agentId, parentAgentId, streaming)
        cache[message.id] = message to rows
        return rows
    }

    fun forget(keep: Set<String>) {
        cache.keys.retainAll(keep)
    }

    companion object {
        fun build(message: Message, agentId: String, parentAgentId: String?, streaming: Boolean): List<ConversationRow> {
            val id = message.id
            if (message.role == "service") {
                failureOf(message)?.let { return listOf(it) }
                val compaction = message.content.filterIsInstance<Block.Compaction>().firstOrNull() ?: return emptyList()
                val kind = when (compaction.status) {
                    "completed" -> NoticeKind.Compacted
                    "failed" -> NoticeKind.CompactionFailed
                    else -> NoticeKind.Compacting
                }
                return listOf(ConversationRow.Notice("$id:notice", kind))
            }
            if (message.role != "user" && message.role != "agent") return emptyList()
            val sender = message.senderAgentId
            if (sender != null && sender != agentId && sender != parentAgentId) {
                val text = inboundText(message.text, sender).trim()
                return listOf(ConversationRow.Collaborator("$id:from", sender, text, parseMarkdown(text)))
            }
            // The agent that manages this one gives it its work: it reads as the person's lane.
            val fromManager = message.role == "agent" && sender != null && sender != agentId
            if (message.role == "user" || fromManager) {
                val text = message.content.filterIsInstance<Block.Text>().joinToString("\n") { it.text }
                    .let { if (fromManager && sender != null) inboundText(it, sender) else it }.trim()
                val pictures = message.content.filterIsInstance<Block.Image>()
                if (text.isEmpty() && pictures.isEmpty()) return emptyList()
                val delivery = if (message.status == "pending") Delivery.Pending else Delivery.Sent
                return listOf(ConversationRow.User("$id:user", id, text, parseMarkdown(text), pictures, delivery))
            }
            val rows = ArrayList<ConversationRow>()
            message.content.forEachIndexed { index, block ->
                val key = "$id:$index"
                when (block) {
                    is Block.Text -> block.text.trim().takeIf { it.isNotEmpty() }?.let { rows += ConversationRow.Text(key, it, parseMarkdown(it)) }
                    is Block.Reasoning -> block.text.trim().takeIf { it.isNotEmpty() }?.let {
                        rows += ConversationRow.Reasoning(key, it, streaming && index == message.content.lastIndex)
                    }
                    is Block.Image -> rows += ConversationRow.Picture(key, block)
                    is Block.ToolCall -> rows += toolRows(key, block, message.createdAt)
                    is Block.Compaction, is Block.Unknown -> Unit
                }
            }
            return rows
        }

        private fun toolRows(key: String, call: Block.ToolCall, createdAt: Long): List<ConversationRow> {
            fun tool(detail: String?, input: JsonObject?) =
                listOf(ConversationRow.Tool(key, call.id, call.name, call.status, detail, input ?: call.arguments as? JsonObject, createdAt))
            return when (val p = call.presentation) {
                is Presentation.Media -> if (call.id == null || p.items.isEmpty()) {
                    tool(null, null)
                } else {
                    listOf(ConversationRow.Media(key, p.items.mapIndexed { index, item -> MediaRef(call.id, index, item) }))
                }
                is Presentation.Artifact -> listOf(ConversationRow.Artifact(key, p.artifactId, p.title.orEmpty(), p.artifactType))
                is Presentation.Command -> tool(p.command, buildJsonObject { put("command", p.command); put("cmd", p.command) })
                is Presentation.Exploration -> p.operations.joinToString(", ").ifEmpty { null }.let { detail ->
                    tool(detail, detail?.let { buildJsonObject { put("file_path", it); put("path", it); put("pattern", it) } })
                }
                is Presentation.Search -> tool(p.query, buildJsonObject { put("query", p.query) })
                null -> tool(null, null)
            }
        }

        /** What another agent said, without the addressing line the daemon puts ahead of it. */
        fun inboundText(text: String, agentId: String): String {
            val lead = "Message from agent $agentId:"
            return if (text.startsWith(lead)) text.removePrefix(lead).trimStart() else text
        }

        /** An error service message as desktop's failure card has it; null for anything else. */
        fun failureOf(message: Message): ConversationRow.Failure? {
            if (message.role != "service" || (message.failure == null && message.error == null)) return null
            val failure = message.failure
            val written = failure?.let(::reason)
            val text = message.text.trim()
            val reason = written ?: text.ifEmpty { failure?.get("message").str ?: "Something went wrong." }
            return ConversationRow.Failure(
                key = "${message.id}:failure",
                messageId = message.id,
                reason = reason,
                retryable = failure?.get("kind").str != "context_too_long",
                resolved = failure?.get("resolution").obj != null,
            )
        }

        /** Desktop's `conversationFailureMessage`, without clock times; null where the daemon's words stand. */
        private fun reason(failure: JsonObject): String? {
            val provider = failure["provider"].obj
            val vendor = provider?.get("vendorName").str
            val label = provider?.get("label").str
            return when (failure["kind"].str) {
                "signin_missing" -> label?.let {
                    val command = failure["command"].str
                    val product = failure["product"].str
                    if (command != null && product != null) "$product isn't signed in. Run `$command`, then retry."
                    else "$it couldn't authenticate. Check its sign-in settings, then retry."
                }
                "usage_limit" -> vendor?.let { "$it usage limit reached." }
                "no_account_available" -> failure["poolName"].str?.let { "Every account in “$it” is out of usage." }
                "rate_limited" -> vendor?.let { "$it is rate-limited. Try again in a minute." }
                "provider_unavailable" -> vendor?.let { "$it is overloaded right now. Try again in a moment." }
                "network" -> vendor?.let { "Couldn't reach $it. Check your connection, then retry." }
                "context_too_long" -> failure["modelId"].str?.let { "This conversation is too long for $it, even after a reset." }
                "provider_disabled" -> label?.let { "$it is turned off. Turn it on in Settings, then retry." }
                "internal" -> failure["detail"].str?.let { "Something went wrong: $it" }
                else -> failure["message"].str
            }
        }
    }
}
