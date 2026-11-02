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
    data class Failed(val reason: Problem) : Delivery
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
        /** The time the bubble shows: the send's own, kept when its echo comes. */
        val createdAt: Long = 0,
    ) : ConversationRow

    /**
     * An answer's text. While it streams, [live] carries its words as they
     * grow and [text] and [blocks] are what it read when the row was built:
     * a delta changes [live] only, so the list and everything around it stay
     * as they are and only this row redraws. Read [current] for the words now.
     */
    data class Text(override val key: String, val text: String, val blocks: List<MarkdownBlock>, val live: LiveText? = null) : ConversationRow {
        val current: String get() = live?.content?.value?.text ?: text
    }

    /** The model's thinking summary: folded under one line until opened; [live] as [Text]'s. */
    data class Reasoning(override val key: String, val text: String, val streaming: Boolean, val live: LiveText? = null) : ConversationRow {
        val current: String get() = live?.content?.value?.text ?: text
    }

    /**
     * A tool call as the chat's tool row shows it: [input] is what its
     * presentation says (the command, the file, the query) in the input
     * shape the legacy tool titles read, or the raw arguments where none.
     */
    data class Tool(override val key: String, val callId: String?, val name: String, val status: String, val detail: String?, val input: JsonObject?, val createdAt: Long) : ConversationRow

    /** A picture inline in a message. */
    data class Picture(override val key: String, val image: Block.Image) : ConversationRow

    /** Pictures, videos and files a tool presented, read on demand; [columns] as the tool asked (0: justified rows). */
    data class Media(override val key: String, val items: List<MediaRef>, val columns: Int = 0) : ConversationRow

    /** An artifact a tool made or changed; `shows: "latest"` follows it, else it opens [version]. */
    data class Artifact(
        override val key: String,
        val artifactId: String,
        val title: String,
        val type: String?,
        val version: Int? = null,
        val shows: String? = null,
    ) : ConversationRow {
        val ref: com.slopus.happy.artifacts.ArtifactRef get() = com.slopus.happy.artifacts.ArtifactRef.presented(artifactId, version, type, title, shows)
    }

    /** Another agent writing to this one: a collaborator or subtask reporting. */
    data class Collaborator(override val key: String, val senderAgentId: String, val text: String, val blocks: List<MarkdownBlock>) : ConversationRow

    /** A turn that failed, with Retry while it can help and nobody acted on it yet. */
    data class Failure(override val key: String, val messageId: String, val reason: FailureReason, val retryable: Boolean, val resolved: Boolean) : ConversationRow

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
class ConversationRowBuilder(
    /** Lays out a streaming block's words before its row reads them; null where nothing does. */
    private val typesetter: RowTypesetter? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Built(val message: Message, val streaming: Boolean, val rows: List<ConversationRow>)

    private val cache = HashMap<String, Built>()

    /** The streaming blocks' live words, by row key; a block keeps its holder for as long as it streams. */
    private val lives = HashMap<String, LiveText>()

    fun rows(message: Message, agentId: String, parentAgentId: String?, streaming: Boolean): List<ConversationRow> {
        cache[message.id]?.let { if (!streaming && !it.streaming && it.message == message) return it.rows }
        val rows = build(message, agentId, parentAgentId, streaming, if (streaming) ::live else null)
        // The pictures are read here, on the lane, so the rows find them read on the main thread.
        for (row in rows) when (row) {
            is ConversationRow.User -> row.pictures.forEach(InlinePicture::of)
            is ConversationRow.Picture -> InlinePicture.of(row.image)
            else -> Unit
        }
        if (!streaming) lives.keys.removeAll { it.startsWith(message.id + ":") }
        cache[message.id] = Built(message, streaming, rows)
        return rows
    }

    private fun live(key: String, text: String, markdown: Boolean): LiveText {
        val live = lives.getOrPut(key) {
            val prepare = typesetter?.let { t -> { content: LiveText.Content, md: Boolean -> t.live(key, content, md) } }
            LiveText(text, if (markdown) parseMarkdown(text) else emptyList(), now, prepare).also { created ->
                // Its first words, too, are laid out before a row reads them.
                prepare?.invoke(created.content.value, markdown)
            }
        }
        live.update(text, markdown)
        return live
    }

    /**
     * [message] grew in its block [index], which streams in a row of its own:
     * the row's [LiveText] takes the words, and the rows as built stand. False
     * when that can't be, because the block has no live row yet (its first
     * words make one) or no longer streams, so the rows must be built again.
     */
    fun grow(message: Message, index: Int): Boolean {
        val built = cache[message.id] ?: return false
        if (!built.streaming) return false
        val live = lives["${message.id}:$index"] ?: return false
        if (built.rows.none { (it as? ConversationRow.Text)?.live === live || (it as? ConversationRow.Reasoning)?.live === live }) return false
        val text = when (val block = message.content.getOrNull(index)) {
            is Block.Text -> block.text.trim()
            is Block.Reasoning -> block.text.trim()
            else -> return false
        }
        if (text.isEmpty()) return false
        live.update(text, message.content[index] is Block.Text)
        cache[message.id] = Built(message, true, built.rows)
        return true
    }

    fun forget(keep: Set<String>) {
        cache.keys.retainAll(keep)
        lives.keys.retainAll { key -> key.substringBeforeLast(':') in keep }
    }

    companion object {
        /** [live] gives a streaming block's holder ([LiveText]); without one, rows carry their words only. */
        fun build(
            message: Message,
            agentId: String,
            parentAgentId: String?,
            streaming: Boolean,
            live: ((key: String, text: String, markdown: Boolean) -> LiveText)? = null,
        ): List<ConversationRow> {
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
                return listOf(ConversationRow.User("$id:user", id, text, parseMarkdown(text), pictures, delivery, message.createdAt))
            }
            val rows = ArrayList<ConversationRow>()
            message.content.forEachIndexed { index, block ->
                val key = "$id:$index"
                // Only the block being written streams; one a later block followed is done.
                val growing = live?.takeIf { streaming && index == message.content.lastIndex }
                when (block) {
                    is Block.Text -> block.text.trim().takeIf { it.isNotEmpty() }?.let { text ->
                        val holder = growing?.invoke(key, text, true)
                        rows += ConversationRow.Text(key, text, holder?.content?.value?.blocks ?: parseMarkdown(text), holder)
                    }
                    is Block.Reasoning -> block.text.trim().takeIf { it.isNotEmpty() }?.let {
                        rows += ConversationRow.Reasoning(key, it, streaming && index == message.content.lastIndex, growing?.invoke(key, it, false))
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
                    listOf(ConversationRow.Media(key, p.items.mapIndexed { index, item -> MediaRef(call.id, index, item) }, p.columns))
                }
                is Presentation.Artifact -> listOf(ConversationRow.Artifact(key, p.artifactId, p.title.orEmpty(), p.artifactType, p.version, p.shows))
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
            val reason = written
                ?: text.ifEmpty { null }?.let(FailureReason::Said)
                ?: failure?.get("message").str?.let(FailureReason::Said)
                ?: FailureReason.Unknown
            return ConversationRow.Failure(
                key = "${message.id}:failure",
                messageId = message.id,
                reason = reason,
                retryable = failure?.get("kind").str != "context_too_long",
                resolved = failure?.get("resolution").obj != null,
            )
        }

        /** Desktop's `conversationFailureMessage` as a case; null where the daemon's words stand. */
        private fun reason(failure: JsonObject): FailureReason? {
            val provider = failure["provider"].obj
            val vendor = provider?.get("vendorName").str
            val label = provider?.get("label").str
            return when (failure["kind"].str) {
                "signin_missing" -> label?.let {
                    val command = failure["command"].str
                    val product = failure["product"].str
                    if (command != null && product != null) FailureReason.SignInMissing(product, command)
                    else FailureReason.CannotAuthenticate(it)
                }
                "usage_limit" -> vendor?.let(FailureReason::UsageLimit)
                "no_account_available" -> failure["poolName"].str?.let(FailureReason::NoAccountAvailable)
                "rate_limited" -> vendor?.let(FailureReason::RateLimited)
                "provider_unavailable" -> vendor?.let(FailureReason::ProviderUnavailable)
                "network" -> vendor?.let(FailureReason::Network)
                "context_too_long" -> failure["modelId"].str?.let(FailureReason::ContextTooLong)
                "provider_disabled" -> label?.let(FailureReason::ProviderDisabled)
                "internal" -> failure["detail"].str?.let(FailureReason::Internal)
                else -> failure["message"].str?.let(FailureReason::Said)
            }
        }
    }
}
