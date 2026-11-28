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

/**
 * The boundary a local-mode slash command names, or null for every other
 * message. A terminal's /clear and /compact reach the chat as the SDK's
 * `<command-name>` wrapper, not as the CLI's completion event. Only Claude
 * Code's transcript writes the wrapper (the app sends a raw "/clear"), and
 * the CLI gives every record it sends a local id, so the id tells nothing.
 */
fun localCommandBoundary(text: String): ContextBoundary? {
    // Only the SDK's wrapper: a raw "/clear" typed into the chat is not one.
    if (!text.contains("<command-name>")) return null
    val command = parseLocalCommandMessage(text) as? LocalCommandMessage.CommandRun ?: return null
    return when (command.commandName.lowercase()) {
        "clear" -> if (command.args == null) ContextBoundary.Cleared else null
        "compact" -> ContextBoundary.Compacted
        else -> null
    }
}

/** The CLI's completion event for this boundary, so a wrapper reads the same. */
fun ContextBoundary.completionEvent(): AgentEvent.Message = AgentEvent.Message(
    when (this) {
        ContextBoundary.Cleared -> CLEARED_EVENT
        ContextBoundary.Compacted -> COMPACTED_EVENT
    },
)

/** True for the row a boundary draws, which a turn's work never folds away. */
fun ChatRow.isContextBoundaryRow(): Boolean =
    (message as? ChatMessage.Event)?.event?.contextBoundary() != null
