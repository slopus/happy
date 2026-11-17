package com.slopus.happy.conversation

/**
 * Folds each finished turn as desktop does (`happyAgentConnectGroupProject`,
 * iOS 7f6355041 `TurnFold`): closed, a turn keeps the person's words, its
 * final answer (else its last step), what other agents said, file edits,
 * the media and artifacts its calls showed, failures, questions still
 * open, and how it ended, and its "View traces" control rides the answer. Open,
 * every step shows and the control rides the turn's first step. A turn
 * still running, or with nothing to hide, is left as it is.
 *
 * Under Group tool calls ([grouped]) a file edit is a step like any other
 * and folds with its run, and a turn watched to its end ([quiet], desktop's
 * settling turn) keeps the rows it ran with, its control ("Hide traces")
 * just above how it ended, so nothing above moves as it ends.
 */
object TurnFold {
    /** One run's rows, oldest first, its [ConversationRow.TurnEnd] among them once it ended. */
    fun fold(turn: String, group: List<ConversationRow>, open: Boolean, grouped: Boolean = false, quiet: Boolean = false): List<ConversationRow> {
        val status = group.indexOfFirst { it is ConversationRow.TurnEnd }
        if (status < 0) return group
        val ended = group[status] as ConversationRow.TurnEnd
        val anchor = group.indexOfLast { it is ConversationRow.Text }.takeIf { it >= 0 } ?: group.indexOfLast(::isStep).takeIf { it >= 0 }
        val kept = group.indices.filter { index -> index == anchor || keeps(group[index], grouped) }
        val folded = if (kept.size == group.size) {
            group
        } else {
            val trace = ConversationRow.Trace(ConversationRow.traceKey(turn), turn, open || quiet, ended.tools)
            if (quiet && !open) {
                group.toMutableList().apply { add(status, trace) }
            } else if (open) {
                group.toMutableList().apply { add(group.indexOfFirst(::holdsTrace).takeIf { it >= 0 } ?: status, trace) }
            } else {
                buildList {
                    for (index in kept) {
                        if (index == (anchor ?: status)) add(trace)
                        add(group[index])
                    }
                }
            }
        }
        // How it ended keeps 4 more from a step right above it.
        val at = folded.indexOfFirst { it is ConversationRow.TurnEnd }
        val afterStep = at > 0 && isStep(folded[at - 1])
        if (afterStep == ended.afterStep) return folded
        return folded.toMutableList().apply { this[at] = ended.copy(afterStep = afterStep) }
    }

    /** What a closed turn still shows. */
    private fun keeps(row: ConversationRow, grouped: Boolean): Boolean = when (row) {
        is ConversationRow.Text, is ConversationRow.Reasoning -> false
        is ConversationRow.Tool -> if (grouped) !ToolSections.joins(row) else row.tool.isResult
        is ConversationRow.Ask -> row.phase != AskPhase.Answered
        else -> true
    }

    /** The work of a turn: its calls and what other agents said. */
    fun isStep(row: ConversationRow): Boolean = when (row) {
        is ConversationRow.Tool, is ConversationRow.Section, is ConversationRow.Collaborator -> true
        is ConversationRow.Media -> row.tool != null
        is ConversationRow.Artifact -> row.tool != null
        else -> false
    }

    /** What the open control may ride (desktop's `withTrace`): the agent's words, its thinking or one of its steps. */
    private fun holdsTrace(row: ConversationRow): Boolean = row is ConversationRow.Text || row is ConversationRow.Reasoning || isStep(row)
}
