package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.SessionState
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.parseMarkdown
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart

/**
 * One visible chat row: the reducer's message and what its renderer needs,
 * derived off the main thread (markdown parsed, slash-command wrappers
 * collapsed). Rows the chat never shows (thinking, the SDK's command caveat,
 * the user's own echoed slash command) are not rows at all.
 */
@Immutable
sealed interface ChatRow {
    val message: ChatMessage
    val key: String get() = message.id

    /** A user bubble. [display] is what the wrapper parsing left to show. */
    data class User(
        override val message: ChatMessage.UserText,
        val display: UserDisplay,
    ) : ChatRow

    data class AgentText(override val message: ChatMessage.AgentText, val blocks: List<MarkdownBlock>) : ChatRow

    data class Tool(override val message: ChatMessage.ToolCallMessage) : ChatRow

    data class Event(override val message: ChatMessage.Event) : ChatRow

    data class Unsupported(override val message: ChatMessage.Unsupported) : ChatRow
}

/** How a user message renders (MessageView.tsx `UserTextBlock`). */
@Immutable
sealed interface UserDisplay {
    data class Text(val text: String, val blocks: List<MarkdownBlock>) : UserDisplay
    /** `/goal`: the goal in a bubble, "Sent as goal" under it. */
    data class Goal(val goal: String, val blocks: List<MarkdownBlock>) : UserDisplay
    /** A slash command: its args in a bubble (if any), the command as a chip. */
    data class Command(val commandName: String, val args: String?, val argBlocks: List<MarkdownBlock>) : UserDisplay
}

/** Everything the chat screen draws from the store, newest row first. */
@Immutable
data class ChatSnapshot(
    val rows: List<ChatRow> = emptyList(),
    val loaded: Boolean = false,
    val hasMoreOlder: Boolean = false,
    val isLoadingOlder: Boolean = false,
    val todos: List<TodoItem>? = null,
    val usage: ContextUsage? = null,
)

/**
 * The reducer driven over a session's stored records: feeds each record once,
 * re-runs Phase 0 when the agent state changes, and keeps row objects stable
 * while their message is unchanged so Compose skips them. Not thread-safe;
 * [ChatFeed] runs it on one coroutine.
 */
class ChatReduction(private val now: () -> Long = System::currentTimeMillis) {
    private var reducer = ReducerState(now)
    private val fed = HashSet<String>()
    private val messages = LinkedHashMap<String, ChatMessage>()
    /** The row last built for each message id, with the message it was built from. */
    private val rows = HashMap<String, Pair<ChatMessage, ChatRow?>>()
    private var lastAgentState: AgentState? = null
    private var lastClaude = true
    private var snapshot = ChatSnapshot()

    fun apply(page: ChatPage, session: ChatSessionInfo?): ChatSnapshot {
        if (fed.isNotEmpty() && !page.records.mapTo(HashSet()) { it.id }.containsAll(fed)) {
            // Records were deleted: start over rather than unwind the reducer.
            reducer = ReducerState(now)
            fed.clear()
            messages.clear()
            rows.clear()
            lastAgentState = null
        }
        val agentState = session?.agentState
        val claude = session?.isClaudeFlavor ?: true
        if (claude != lastClaude) {
            rows.clear()
            lastClaude = claude
        }
        val incoming = page.records.filter { fed.add(it.id) }.mapNotNull(ChatNormalizer::normalize)
        var changed = false
        if (incoming.isNotEmpty() || agentState != lastAgentState || !snapshot.loaded) {
            lastAgentState = agentState
            val result = reducer.reduce(
                incoming,
                agentState,
                ReducerOptions(holdUserMessagesUntilAccepted = session?.sendsMessageReceipts == true),
            )
            for (message in result.messages) messages[message.id] = message
            changed = result.messages.isNotEmpty() || !snapshot.loaded
        }
        if (!changed && snapshot.hasMoreOlder == page.hasMoreOlder && snapshot.isLoadingOlder == page.isLoadingOlder &&
            snapshot.loaded == page.loaded
        ) {
            return snapshot
        }
        val visible = if (changed || rows.isEmpty()) {
            messages.values.sortedByDescending { it.sortKey }.mapNotNull { row(it) }
        } else {
            snapshot.rows
        }
        snapshot = ChatSnapshot(
            rows = visible,
            loaded = page.loaded,
            hasMoreOlder = page.hasMoreOlder,
            isLoadingOlder = page.isLoadingOlder,
            todos = reducer.todos,
            usage = reducer.usage,
        )
        return snapshot
    }

    private fun row(message: ChatMessage): ChatRow? {
        rows[message.id]?.let { (built, row) -> if (built == message) return row }
        val row = buildRow(message, lastClaude)
        rows[message.id] = message to row
        return row
    }

    companion object {
        fun buildRow(message: ChatMessage, isClaudeFlavor: Boolean): ChatRow? = when (message) {
            is ChatMessage.UserText -> userRow(message, isClaudeFlavor)
            is ChatMessage.AgentText -> if (message.isThinking) null else ChatRow.AgentText(message, parseMarkdown(message.text))
            is ChatMessage.ToolCallMessage -> ChatRow.Tool(message)
            is ChatMessage.Event -> ChatRow.Event(message)
            is ChatMessage.Unsupported -> ChatRow.Unsupported(message)
        }

        private fun userRow(message: ChatMessage.UserText, isClaudeFlavor: Boolean): ChatRow? {
            // The user's own slash command comes back as the SDK's wrapper
            // chip; hide the raw echo (Claude only: others don't re-emit it).
            if (isClaudeFlavor && isUserSlashCommandEcho(message.text, message.localId != null)) return null
            val display = when (val parsed = parseLocalCommandMessage(message.displayText ?: message.text)) {
                LocalCommandMessage.Caveat, is LocalCommandMessage.GoalConfirmation -> return null
                is LocalCommandMessage.GoalRun -> UserDisplay.Goal(parsed.goal, parseMarkdown(parsed.goal))
                is LocalCommandMessage.CommandRun ->
                    UserDisplay.Command(parsed.commandName, parsed.args, parsed.args?.let(::parseMarkdown).orEmpty())
                is LocalCommandMessage.Text -> UserDisplay.Text(parsed.text, parseMarkdown(parsed.text))
            }
            return ChatRow.User(message, display)
        }
    }
}

/** Everything the chat screen shows about a session. */
@Immutable
data class ChatState(
    val snapshot: ChatSnapshot = ChatSnapshot(),
    /** Null once loaded means the session is not on this device. */
    val session: ChatSessionInfo? = null,
    val sessionLoaded: Boolean = false,
    val online: Boolean = false,
    val thinking: Boolean = false,
    val activeAt: Long = 0,
) {
    val sessionState: SessionState get() = resolveSessionState(session?.agentState, thinking, online)
    val pendingCommunications: List<PendingAgentCommunication> get() = selectPendingCommunications(session?.agentState)
}

/** The chat's state for one session, reduced on [Dispatchers.Default]. */
class ChatFeed(
    private val messages: ChatMessagesSource,
    private val sessions: ChatSessionSource,
    private val presence: ChatPresenceSource,
) {
    fun state(sessionId: String): Flow<ChatState> = flow {
        // One reduction per collector: it holds the reducer's state for this view.
        val reduction = ChatReduction()
        val session = sessions.session(sessionId).map { it?.let(ChatSessionInfo::from) }.distinctUntilChanged()
        val combined = combine(
            messages.messages(sessionId),
            session.map { true to it }.onStart { emit(false to null) },
            presence.presence(sessionId).onStart { emit(null) },
        ) { page, (sessionLoaded, info), live -> Triple(page, sessionLoaded to info, live) }
            .conflate()
            .map { (page, loadedAndInfo, live) ->
                val (sessionLoaded, info) = loadedAndInfo
                ChatState(
                    snapshot = reduction.apply(page, info),
                    session = info,
                    sessionLoaded = sessionLoaded,
                    online = live?.online ?: (info?.session?.active == true),
                    thinking = live?.thinking ?: false,
                    activeAt = live?.activeAt?.takeIf { it > 0 } ?: info?.session?.activeAt ?: 0,
                )
            }
        emitAll(combined)
    }
        .distinctUntilChanged()
        .flowOn(Dispatchers.Default)
}
