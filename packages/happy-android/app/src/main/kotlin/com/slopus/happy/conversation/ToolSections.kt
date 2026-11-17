package com.slopus.happy.conversation

/**
 * Group tool calls (desktop's `conversationToolSections`): each run of
 * one-line tool calls becomes one [ConversationRow.Section], keyed by its
 * first call's row.
 *
 * A call that shows something under its line (media, an artifact) keeps a
 * row of its own and ends the run, as does anything else: the agent's
 * words or thinking, a question, how a turn ended. Which calls a section
 * holds is read from the rows alone.
 *
 * A section is live while one of its calls runs, or while the agent works
 * and nothing has followed it yet; a turn's end closes every section
 * before it, whatever its calls last said. Once ended it is kept ended
 * ([ended], by key): the turn going on, or a row after it coming and
 * going, never opens it again, though a call of its own under way does.
 */
object ToolSections {
    /**
     * [rows], oldest first, with each run of calls as its section. Rows in
     * [apart] (a turn opened on its traces) stay calls of their own; [at]
     * is when a row's message was written, where known.
     */
    fun group(
        rows: List<ConversationRow>,
        working: Boolean,
        ended: MutableSet<String>,
        apart: Set<String> = emptySet(),
        at: (ConversationRow) -> Long? = { null },
    ): List<ConversationRow> {
        if (rows.none { joins(it, apart) }) return rows
        // Everything up to the last turn's end belongs to a turn that is over.
        val settledThrough = rows.indexOfLast { it is ConversationRow.TurnEnd }
        val out = ArrayList<ConversationRow>(rows.size)
        var index = 0
        while (index < rows.size) {
            val lead = rows[index]
            if (!joins(lead, apart)) {
                out += lead
                index++
                continue
            }
            var next = index + 1
            while (next < rows.size && joins(rows[next], apart)) next++
            val calls = rows.subList(index, next).map { (it as ConversationRow.Tool).tool }
            val live = next > settledThrough && (calls.any { it.running } || (working && next == rows.size && lead.key !in ended))
            if (!live) ended += lead.key
            val startedAt = at(lead)
            val endedAt = if (live) null else rows.getOrNull(next)?.let { endedAt(it, at) } ?: at(rows[next - 1])
            val duration = if (startedAt != null && endedAt != null && endedAt > startedAt) endedAt - startedAt else null
            out += ConversationRow.Section(lead.key, calls, live, duration)
            index = next
        }
        return out
    }

    /** Whether [row] is a call that is one line and nothing else, and so can share a section. */
    fun joins(row: ConversationRow, apart: Set<String> = emptySet()): Boolean {
        if (row !is ConversationRow.Tool || row.key in apart) return false
        val shown = row.tool.presentation
        return shown !is Presentation.Media && shown !is Presentation.Artifact && shown !is Presentation.GenUi
    }

    /**
     * When the agent did what follows a run: what it said or did next, or
     * the end of its turn. A person's message or a question times nothing.
     */
    private fun endedAt(row: ConversationRow, at: (ConversationRow) -> Long?): Long? = when (row) {
        is ConversationRow.TurnEnd -> row.endedAt
        is ConversationRow.Text, is ConversationRow.Reasoning, is ConversationRow.Tool, is ConversationRow.Media,
        is ConversationRow.Artifact, is ConversationRow.GenUi, is ConversationRow.Picture, is ConversationRow.Collaborator -> at(row)
        else -> null
    }
}
