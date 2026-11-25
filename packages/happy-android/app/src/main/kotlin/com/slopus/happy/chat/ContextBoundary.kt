package com.slopus.happy.chat

// A relay session's context boundary. happy-cli's Claude run reports a
// finished /clear or /compact as a completion event (claudeRemote.ts), which
// reaches the phone as an agent `event` record of `{type: "message", message}`.
// The chat draws those as a divider across the transcript instead of the
// CLI's own words as a centred event line; everything above the divider is
// the context that was dropped.

/** The CLI's completion event for /clear. */
private const val CLEARED_EVENT = "Context was reset"

/** The CLI's completion event for /compact. */
private const val COMPACTED_EVENT = "Compaction completed"

/** Which context boundary a completion event names. */
enum class ContextBoundary { Cleared, Compacted }

/** The boundary this event names, or null for every other event. */
fun AgentEvent.contextBoundary(): ContextBoundary? {
    val message = (this as? AgentEvent.Message)?.message ?: return null
    return when (message) {
        CLEARED_EVENT -> ContextBoundary.Cleared
        COMPACTED_EVENT -> ContextBoundary.Compacted
        else -> null
    }
}

/** True for the row a boundary draws, which a turn's work never folds away. */
fun ChatRow.isContextBoundaryRow(): Boolean =
    (message as? ChatMessage.Event)?.event?.contextBoundary() != null
