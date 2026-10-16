package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.tools.KnownTools
import com.slopus.happy.chat.tools.isInteractiveQuestionToolName

// A finished turn's intermediate work, folded under one "Worked 1m2s" row
// above its final answer: hooks/useGroupedMessages.ts, utils/agentTurns.ts
// and ChatList.tsx's expansion rules. Everything here runs newest first,
// the order ChatSnapshot.rows and the inverted chat list use.

/**
 * useGroupedMessages `AgentWorkGroupItem`: the hidden work of one turn.
 * [rows] are in reading order (oldest first), as they draw when expanded.
 * [id] is keyed by the final answer, the one member a turn is sure to have.
 */
@Immutable
data class AgentWorkGroup(
    val id: String,
    /** The settled prompt that opened the turn: what "watched" turns are tracked by. */
    val turnUserMessageId: String?,
    val rows: List<ChatRow>,
    val hasRunning: Boolean,
    val hasPendingPermission: Boolean,
    val startedAt: Long,
    val completedAt: Long?,
)

/** useGroupedMessages `DisplayItem`: a row as it is, or a turn's folded work. */
@Immutable
sealed interface ChatDisplayItem {
    val key: String

    data class Row(val row: ChatRow) : ChatDisplayItem {
        override val key: String get() = row.key
    }

    data class WorkGroup(val group: AgentWorkGroup) : ChatDisplayItem {
        override val key: String get() = group.id
    }
}

enum class WorkHeaderPlacement { Leading, Trailing }

/**
 * ChatList.tsx `ListItem`: what the list draws. An expanded group is its
 * leading header, its rows, then a trailing "Hide" header; the trailing
 * copy lands where the tapped row was, since the inverted list grows upward.
 */
@Immutable
sealed interface ChatListItem {
    val key: String

    data class Row(val row: ChatRow) : ChatListItem {
        override val key: String get() = row.key
    }

    data class WorkHeader(val group: AgentWorkGroup, val placement: WorkHeaderPlacement) : ChatListItem {
        override val key: String get() = if (placement == WorkHeaderPlacement.Leading) group.id else "${group.id}:collapse"
    }
}

private val ChatMessage.turnId: String?
    get() = when (this) {
        is ChatMessage.AgentText -> turn
        is ChatMessage.ToolCallMessage -> turn
        is ChatMessage.Event -> turn
        else -> null
    }

/** A settled user message: it ends a turn (pending and refused sends never started one). */
private fun ChatMessage.isSettledUserText() = this is ChatMessage.UserText && !pending && sendError == null

/**
 * agentTurns.ts assignTurns over [messages] newest first: turn 0 is the
 * latest. A turn ends at a settled user message, and where two agent rows
 * carry different session-protocol turn ids; rows without one never start
 * a turn on their own.
 */
fun assignTurns(messages: List<ChatMessage>): IntArray {
    val turnOf = IntArray(messages.size)
    var turn = 0
    var turnId: String? = null
    messages.forEachIndexed { i, message ->
        val id = message.turnId
        if (message !is ChatMessage.UserText && id != null) {
            if (turnId != null && id != turnId) turn++
            turnId = id
        }
        turnOf[i] = turn
        if (message.isSettledUserText()) {
            turn++
            turnId = null
        }
    }
    return turnOf
}

/** isInvisibleMessage: hidden tools and blank or thinking text render as nothing. */
private fun ChatRow.isInvisible(): Boolean = when (val message = message) {
    is ChatMessage.ToolCallMessage -> KnownTools[message.tool.name]?.hidden == true
    is ChatMessage.AgentText -> message.isThinking || message.text.isBlank()
    else -> false
}

/** isUserAttachment: a sent picture is never folded away. */
private fun ChatRow.isUserAttachment(): Boolean = (message as? ChatMessage.ToolCallMessage)?.tool?.name == "file"

/**
 * groupMessagesForDisplay over [rows] newest first, returning newest first.
 * Each turn with a final answer folds the visible agent work before that
 * answer (not user rows, attachments or questions) into one group, placed
 * where its oldest member was. The current turn (turn 0) folds only when
 * [collapseCurrentTurn]: while it streams everything renders flat. With
 * [enabled] false (the `groupToolCalls` setting off) rows pass through.
 */
fun groupChatRowsForDisplay(rows: List<ChatRow>, enabled: Boolean, collapseCurrentTurn: Boolean): List<ChatDisplayItem> {
    if (!enabled) return rows.filterNot { it.isInvisible() }.map(ChatDisplayItem::Row)
    val turnOf = assignTurns(rows.map { it.message })
    val hidden = HashSet<Int>()
    val groupAt = HashMap<Int, AgentWorkGroup>()
    val segments = LinkedHashMap<Int, MutableList<Int>>()
    rows.indices.forEach { segments.getOrPut(turnOf[it]) { ArrayList() }.add(it) }
    for ((turn, indexes) in segments) {
        if (turn == 0 && !collapseCurrentTurn) continue
        val visibleAgent = indexes.filter { index ->
            val row = rows[index]
            val message = row.message
            when {
                message is ChatMessage.UserText -> false
                row.isInvisible() || row.isUserAttachment() -> false
                message is ChatMessage.ToolCallMessage && isInteractiveQuestionToolName(message.tool.name) -> false
                else -> true
            }
        }
        // Newest first, so the first agent text is the final answer; the work is what came before it.
        val finalIndex = visibleAgent.firstOrNull { rows[it].message is ChatMessage.AgentText } ?: continue
        val work = visibleAgent.filter { it > finalIndex }
        if (work.isEmpty()) continue
        val members = work.map { rows[it] }
        val turnUser = indexes.map { rows[it].message }.firstOrNull { it.isSettledUserText() }?.id
        val group = AgentWorkGroup(
            id = "work-${rows[finalIndex].message.id}",
            turnUserMessageId = turnUser,
            rows = members.reversed(),
            hasRunning = false,
            hasPendingPermission = members.any { (it.message as? ChatMessage.ToolCallMessage)?.tool?.permission?.status == PermissionStatus.Pending },
            startedAt = members.minOf { it.message.createdAt },
            completedAt = rows[finalIndex].message.createdAt,
        )
        hidden += work
        groupAt[work.max()] = group
    }
    val result = ArrayList<ChatDisplayItem>(rows.size)
    rows.forEachIndexed { index, row ->
        if (row.isInvisible()) return@forEachIndexed
        if (index in hidden) {
            groupAt[index]?.let { result += ChatDisplayItem.WorkGroup(it) }
            return@forEachIndexed
        }
        result += ChatDisplayItem.Row(row)
    }
    // A group sits where its oldest member was: between the turn's prompt and its answer.
    return result
}

/**
 * ChatList.tsx listItems, newest first: a group's leading header; while it
 * is [expanded], its rows and a trailing header. Newest first the trailing
 * header comes first (it is the lowest on screen), then the rows newest
 * first, then the leading header above them.
 */
fun chatListItems(items: List<ChatDisplayItem>, expanded: (AgentWorkGroup) -> Boolean): List<ChatListItem> {
    val out = ArrayList<ChatListItem>(items.size)
    for (item in items) {
        when (item) {
            is ChatDisplayItem.Row -> out += ChatListItem.Row(item.row)
            is ChatDisplayItem.WorkGroup -> {
                val group = item.group
                if (expanded(group)) {
                    out += ChatListItem.WorkHeader(group, WorkHeaderPlacement.Trailing)
                    group.rows.asReversed().forEach { out += ChatListItem.Row(it) }
                }
                out += ChatListItem.WorkHeader(group, WorkHeaderPlacement.Leading)
            }
        }
    }
    return out
}

/** ChatList.tsx `currentTurnComplete`: the agent is idle and asks for no permission. */
fun isCurrentTurnComplete(thinking: Boolean, agentState: AgentState?): Boolean = !thinking && agentState?.requests.isNullOrEmpty()

/**
 * ChatList.tsx's group expansion: groups the reader opened or closed, and
 * the turns they watched while those ran (a turn seen live keeps its work
 * open when it finishes; history seen on open stays folded). A watched
 * turn, and a group with a pending permission or running work, open
 * themselves unless closed by hand. Immutable: each change is a new value.
 */
@Immutable
data class WorkGroupExpansion(
    val sessionId: String? = null,
    val expanded: Set<String> = emptySet(),
    val closed: Set<String> = emptySet(),
    val watched: Set<String> = emptySet(),
    val foreground: Boolean = true,
) {
    private fun watches(group: AgentWorkGroup) = group.turnUserMessageId != null && foreground && group.turnUserMessageId in watched

    fun isExpanded(group: AgentWorkGroup): Boolean =
        group.id in expanded ||
            (watches(group) && group.id !in closed) ||
            ((group.hasPendingPermission || group.hasRunning) && group.id !in closed)

    /** handleToggleGroup: open what is folded, fold what is open (however it came to be open). */
    fun toggled(group: AgentWorkGroup): WorkGroupExpansion {
        val wasExpanded = group.id in expanded || ((watches(group) || group.hasPendingPermission || group.hasRunning) && group.id !in closed)
        return if (wasExpanded) copy(expanded = expanded - group.id, closed = closed + group.id)
        else copy(expanded = expanded + group.id, closed = closed - group.id)
    }

    /**
     * The render-time bookkeeping, for [rows] of [sessionId] newest first:
     * another session starts afresh; in the foreground the watched turns
     * still on screen are kept, and the running turn's prompt is added
     * while [currentTurnComplete] is false. In the background nothing is
     * watched.
     */
    fun observed(sessionId: String, foreground: Boolean, rows: List<ChatRow>, currentTurnComplete: Boolean): WorkGroupExpansion {
        val base = if (sessionId != this.sessionId) WorkGroupExpansion(sessionId = sessionId) else this
        val next = HashSet<String>()
        if (foreground) {
            val shown = rows.mapNotNullTo(HashSet()) { (it.message as? ChatMessage.UserText)?.id }
            base.watched.filterTo(next) { it in shown }
            if (!currentTurnComplete) rows.firstOrNull { it.message.isSettledUserText() }?.message?.id?.let(next::add)
        }
        val updated = base.copy(foreground = foreground, watched = if (next == base.watched) base.watched else next)
        return if (updated == this) this else updated
    }

    /** The app went to the background: groups whose work has finished fold, and nothing stays watched. */
    fun backgrounded(items: List<ChatDisplayItem>): WorkGroupExpansion {
        val running = items.mapNotNullTo(HashSet()) { (it as? ChatDisplayItem.WorkGroup)?.group?.takeIf { g -> g.hasRunning && g.id in expanded }?.id }
        return copy(watched = emptySet(), expanded = running, closed = emptySet())
    }
}

/** formatWorkDuration: 45s, 2m5s, 1h3m. */
fun formatWorkDuration(durationMs: Long): String {
    val totalSeconds = maxOf(0L, durationMs / 1000)
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return when {
        hours > 0 -> "${hours}h${minutes}m"
        minutes > 0 -> "${minutes}m${seconds}s"
        else -> "${seconds}s"
    }
}
