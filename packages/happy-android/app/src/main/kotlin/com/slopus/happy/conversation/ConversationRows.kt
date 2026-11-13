package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.References
import kotlinx.serialization.json.JsonObject

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
 * A tool call as its line reads it (iOS `ChatItem.Tool`): its name, where it
 * stands (`running`, `completed` or `failed`), its short label and what it presented.
 */
@Immutable
data class ToolUse(
    val name: String,
    val status: String,
    val presentation: Presentation? = null,
    /** The skill a `read_skill` call reads, from its arguments: its line names it. */
    val skill: String? = null,
    /** The call's id, which opens it ([ToolCallRoute][com.slopus.happy.ui.conversation.ToolCallRoute]); null where the daemon sent none. */
    val id: String? = null,
    /** What its arguments say for its line where no presentation does (a plan's progress, a page's address). */
    val hint: ToolHint? = null,
    /** Short builtin label, projected before raw arguments leave the row state; never MCP input. */
    val summary: String? = null,
) {
    val running: Boolean get() = status == "running"
    val failed: Boolean get() = status == "failed"

    /** A file edit, presented media or an artifact is a result to open: it stays when its turn folds. */
    val isResult: Boolean get() = presentation is Presentation.FileDiff || presentation is Presentation.Media || presentation is Presentation.Artifact
}

/**
 * One row of a conversation as the phone draws it. A message becomes one
 * row per block it shows, keyed by message and block, so a streaming block
 * recomposes alone. Tool data is never shown: a tool call is the one line
 * its bounded label, name, status and presentation give.
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
        /** Shown whole: a long one is cut at its first lines until tapped open ([com.slopus.happy.ui.conversation.UserFold]). */
        val opened: Boolean = false,
        /** On a team's computer, the member who wrote it, by user ID; null for one still on its way and outside a team. */
        val author: String? = null,
    ) : ConversationRow

    /**
     * An answer's text. While it streams, [live] carries its words as they
     * grow and [text] and [blocks] are what it read when the row was built:
     * a delta changes [live] only, so the list and everything around it stay
     * as they are and only this row redraws. Read [current] for the words now.
     */
    data class Text(
        override val key: String,
        val text: String,
        val blocks: List<MarkdownBlock>,
        val live: LiveText? = null,
        /** Its own copy button; a finished turn's answer has its turn's instead ([TurnEnd.copyText]). */
        val copies: Boolean = true,
    ) : ConversationRow {
        val current: String get() = live?.content?.value?.text ?: text
    }

    /** The model's thinking summary: folded under one line until opened; [live] as [Text]'s. */
    data class Reasoning(override val key: String, val text: String, val streaming: Boolean, val live: LiveText? = null) : ConversationRow {
        val current: String get() = live?.content?.value?.text ?: text
    }

    /** A tool call's one line (desktop's `AgentToolActivity`): its verb and subject. */
    data class Tool(override val key: String, val callId: String?, val tool: ToolUse) : ConversationRow {
        val name: String get() = tool.name
        val status: String get() = tool.status
    }

    /** A picture inline in a message. */
    data class Picture(override val key: String, val image: Block.Image) : ConversationRow

    /**
     * Pictures, videos and files a tool presented, read on demand; [columns]
     * as the tool asked (0: justified rows), under the [tool]'s line.
     */
    data class Media(override val key: String, val items: List<MediaRef>, val columns: Int = 0, val tool: ToolUse? = null) : ConversationRow

    /**
     * An artifact a tool made or changed, under the [tool]'s line; `shows: "latest"` follows it, else it opens [version].
     * [page]: an HTML artifact that follows its latest version and asks to be shown inline, drawn under its card.
     */
    data class Artifact(
        override val key: String,
        val artifactId: String,
        val title: String,
        val type: String?,
        val version: Int? = null,
        val shows: String? = null,
        val tool: ToolUse? = null,
        val page: References.Page? = null,
    ) : ConversationRow {
        val ref: com.slopus.happy.artifacts.ArtifactRef get() = com.slopus.happy.artifacts.ArtifactRef.presented(artifactId, version, type, title, shows)
    }

    /** Another agent writing to this one: a collaborator or subtask reporting. */
    data class Collaborator(override val key: String, val senderAgentId: String, val text: String, val blocks: List<MarkdownBlock>) : ConversationRow

    /**
     * A turn that failed, with Retry while it can help and nobody acted on it yet.
     * [kind] is the typed failure's (null from an older daemon), [providerType]
     * its account's family, [pool] whether a routing pool ran out, [createdAt]
     * when the message was written: what analytics may know of it.
     */
    data class Failure(
        override val key: String,
        val messageId: String,
        val reason: FailureReason,
        val retryable: Boolean,
        val resolved: Boolean,
        val kind: String? = null,
        val providerType: String? = null,
        val pool: Boolean = false,
        val createdAt: Long = 0,
    ) : ConversationRow

    /**
     * A question the agent asked (iOS 7f6355041 `ChatItem.Ask`): waiting, it
     * is pinned to the transcript's end; answered, it stays in its turn where
     * it was asked, saying what was answered.
     */
    data class Ask(override val key: String, val question: Question, val phase: AskPhase) : ConversationRow

    /** One line of housekeeping worth showing (a compaction). */
    data class Notice(override val key: String, val kind: NoticeKind) : ConversationRow

    /**
     * How a finished turn ended (desktop's `TurnSummary`): "Completed in
     * 12s", led by a copy of its final answer ([copyText]) when complete.
     * [afterStep]: it follows a step of the turn, kept 4 more from it.
     */
    data class TurnEnd(
        override val key: String,
        val turn: String,
        /** `completed`, `steering`, `abort`, `error` or `compaction`. */
        val reason: String,
        val durationMs: Long?,
        /** Its tool calls, every kind. */
        val tools: Int,
        val copyText: String?,
        val afterStep: Boolean = false,
        /** When the run ended (ms); null where it isn't known. */
        val endedAt: Long? = null,
    ) : ConversationRow {
        /** A steered, stopped or failed turn says so and offers no copy. */
        val complete: Boolean get() = reason == "completed" || reason == "compaction"
    }

    /** A finished turn's "View traces" / "Hide traces" control ([TurnFold]), keyed [traceKey]. */
    data class Trace(override val key: String, val turn: String, val open: Boolean, val tools: Int) : ConversationRow

    companion object {
        /** A turn's fold control, open or folded alike. */
        fun traceKey(turn: String) = "$turn:trace"
    }
}

enum class NoticeKind { Compacting, Compacted, CompactionFailed }

/** Where a question's answer stands. */
@Immutable
sealed interface AskPhase {
    data object Pending : AskPhase
    /** The answer is on its way. */
    data object Submitting : AskPhase
    /** Refused or lost: why, and the answer may go again. */
    data class Failed(val reason: Problem) : AskPhase
    data object Answered : AskPhase
}

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
    /**
     * What Happy references read as now ([com.slopus.happy.references]):
     * a message that names one is built again when it changes; null leaves
     * the tags as written.
     */
    var references: References? = null

    /** Which settings pages the conversation's connection has: a link to any other is its words. Null leaves every link. */
    var hasPage: ((String) -> Boolean)? = null

    /** Told the words of each message built that may name references, so their titles and names are read. */
    var named: ((String) -> Unit)? = null

    /** Told the HTML artifacts calls show at their latest version whose artifact isn't read yet, so whether each is shown inline is read. */
    var pages: ((List<String>) -> Unit)? = null

    /** [names]: the message's words may hold a reference, or it shows an HTML artifact, so its rows follow [references]. */
    private class Built(val message: Message, val streaming: Boolean, val rows: List<ConversationRow>, val references: References?, val names: Boolean)

    private val cache = HashMap<String, Built>()

    /** The streaming blocks' live words, by row key; a block keeps its holder for as long as it streams. */
    private val lives = HashMap<String, LiveText>()

    fun rows(message: Message, agentId: String, parentAgentId: String?, streaming: Boolean): List<ConversationRow> {
        val references = references
        cache[message.id]?.let { if (!streaming && !it.streaming && it.message == message && (!it.names || it.references === references)) return it.rows }
        val rows = build(message, agentId, parentAgentId, streaming, if (streaming) ::live else null, references, hasPage)
        val shown = message.content.mapNotNull { block -> (block as? Block.ToolCall)?.presentation?.let(::inlineCandidate) }
        val names = shown.isNotEmpty() || message.content.any { it is Block.Text && References.mayHold(it.text) }
        if (names) named?.let { tell -> message.content.forEach { if (it is Block.Text) tell(it.text) } }
        if (references != null) shown.filter { references.artifacts[it] == null }.takeIf { it.isNotEmpty() }?.let { pages?.invoke(it) }
        // The pictures are read here, on the lane, so the rows find them read on the main thread.
        for (row in rows) when (row) {
            is ConversationRow.User -> row.pictures.forEach(InlinePicture::of)
            is ConversationRow.Picture -> InlinePicture.of(row.image)
            else -> Unit
        }
        if (!streaming) lives.keys.removeAll { it.startsWith(message.id + ":") }
        cache[message.id] = Built(message, streaming, rows, references, names)
        return rows
    }

    private fun live(key: String, text: String, markdown: Boolean): LiveText {
        val live = lives.getOrPut(key) {
            val prepare = typesetter?.let { t -> { content: LiveText.Content, md: Boolean -> t.live(key, content, md) } }
            LiveText(text, if (markdown) parseMarkdown(text, hasPage) else emptyList(), now, prepare, hasPage).also { created ->
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
        val markdown = message.content[index] is Block.Text
        live.update(if (markdown) resolved(text, references, streaming = true) else text, markdown)
        cache[message.id] = Built(message, true, built.rows, built.references, built.names)
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
            /** Tags read as their names: links in what agents say, words in what the person said; null leaves them as written. */
            references: References? = null,
            /** [ConversationRowBuilder.hasPage]. */
            hasPage: ((String) -> Boolean)? = null,
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
                return listOf(ConversationRow.Collaborator("$id:from", sender, plain(text, references), parseMarkdown(resolved(text, references, false), hasPage)))
            }
            // The agent that manages this one gives it its work: it reads as the person's lane.
            val fromManager = message.role == "agent" && sender != null && sender != agentId
            if (message.role == "user" || fromManager) {
                val text = message.content.filterIsInstance<Block.Text>().joinToString("\n") { it.text }
                    .let { if (fromManager && sender != null) inboundText(it, sender) else it }.trim()
                    .let { plain(it, references) }
                    // Its Happy Cloud files read as a computer's uploads do: listed under its words.
                    .let { WorkspaceUploads.listed(it, message.content.filterIsInstance<Block.File>().map(Block.File::name)) }
                val pictures = message.content.filterIsInstance<Block.Image>()
                if (text.isEmpty() && pictures.isEmpty()) return emptyList()
                val delivery = if (message.status == "pending") Delivery.Pending else Delivery.Sent
                return listOf(ConversationRow.User("$id:user", id, text, parseMarkdown(text, hasPage), pictures, delivery, message.createdAt, author = message.userId))
            }
            val rows = ArrayList<ConversationRow>()
            message.content.forEachIndexed { index, block ->
                val key = "$id:$index"
                // Only the block being written streams; one a later block followed is done.
                val growing = live?.takeIf { streaming && index == message.content.lastIndex }
                when (block) {
                    is Block.Text -> block.text.trim().takeIf { it.isNotEmpty() }?.let { text ->
                        val shown = resolved(text, references, growing != null)
                        val holder = growing?.invoke(key, shown, true)
                        rows += ConversationRow.Text(key, plain(text, references), holder?.content?.value?.blocks ?: parseMarkdown(shown, hasPage), holder)
                    }
                    is Block.Reasoning -> block.text.trim().takeIf { it.isNotEmpty() }?.let {
                        rows += ConversationRow.Reasoning(key, it, streaming && index == message.content.lastIndex, growing?.invoke(key, it, false))
                    }
                    is Block.Image -> rows += ConversationRow.Picture(key, block)
                    is Block.ToolCall -> rows += toolRows(key, block, references)
                    is Block.Compaction, is Block.File, is Block.Unknown -> Unit
                }
            }
            return rows
        }

        /** The artifact [presentation] shows, when it may be shown inline: HTML or Gen UI, following its latest version. */
        private fun inlineCandidate(presentation: Presentation): String? =
            (presentation as? Presentation.Artifact)?.takeIf { (it.artifactType == "html" || it.artifactType == "gen_ui") && it.shows == "latest" }?.artifactId

        private fun toolRows(key: String, call: Block.ToolCall, references: References?): List<ConversationRow> {
            if (call.name == Question.TOOL_NAME && call.id != null) {
                // Answered, as the card the call keeps says, or else its result: it settles here.
                // Otherwise the conversation decides (Conversation.derive).
                val shown = call.presentation as? Presentation.UserInput
                val answered = if (shown != null) {
                    Question(call.id, "answered", Question.asked(call.id, call.arguments, null)?.context, shown.prompts, null, false, shown.answers)
                } else {
                    Question.asked(call.id, call.arguments, call.output)?.takeIf { it.status == "answered" }
                }
                if (answered != null) return listOf(ConversationRow.Ask(askKey(call.id), answered, AskPhase.Answered))
            }
            val skill = if (call.name == Conversation.READ_SKILL) (call.arguments as? JsonObject)?.get("name").str else null
            val tool = ToolUse(call.name, call.status, call.presentation, skill, call.id, ToolHint.of(call), ToolSummary.of(call.name, call.arguments))
            return when (val p = call.presentation) {
                is Presentation.Media -> if (call.id == null || p.items.isEmpty()) {
                    listOf(ConversationRow.Tool(key, call.id, tool))
                } else {
                    listOf(ConversationRow.Media(key, p.items.mapIndexed { index, item -> MediaRef(call.id, index, item) }, p.columns, tool))
                }
                // Desktop's inline page, under its card: only where the call follows the latest version.
                is Presentation.Artifact -> listOf(
                    ConversationRow.Artifact(
                        key, p.artifactId, p.title.orEmpty(), p.artifactType, p.version, p.shows, tool,
                        page = if (p.shows == "latest") references?.pages?.get(p.artifactId) else null,
                    ),
                )
                else -> listOf(ConversationRow.Tool(key, call.id, tool))
            }
        }

        /** [text]'s Markdown with its references as [references] reads them; still [streaming], a tag only partly come is held back. */
        internal fun resolved(text: String, references: References?, streaming: Boolean): String = when {
            references == null -> text
            streaming -> HappyReferences.markdown(text, references, streaming = true)
            References.mayHold(text) -> HappyReferences.markdown(text, references)
            else -> text
        }

        /** [text] with its references as words: what the person wrote, and what is copied. */
        internal fun plain(text: String, references: References?): String =
            if (references == null || !References.mayHold(text)) text else HappyReferences.plain(text, references)

        /** A question's row, one key waiting at the end or settled in its turn, so it moves rather than swaps. */
        fun askKey(questionId: String): String = "ask:$questionId"

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
                kind = failure?.get("kind").str,
                providerType = failure?.get("provider").obj?.get("type").str,
                pool = failure?.get("poolName").str != null,
                createdAt = message.createdAt,
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
