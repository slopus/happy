package com.slopus.happy.conversation

import com.slopus.happy.conversation.ui.QuickReply

/**
 * Where one turn's suggested replies stand among its rows: each stack goes
 * under everything the agent wrote in the turn before a person's next
 * message, so words the agent goes on with come above it, and a steer and
 * its answer below. Fed the turn's messages in order ([add]), then asked to
 * put the stacks in ([place]).
 */
internal class QuickReplyPlacement {
    /** Each stack, with the key of the row it goes under; null for the turn's top. */
    private val stacks = ArrayList<Pair<ConversationRow.Replies, String?>>()

    /** The stacks nobody has written under yet: what the agent writes next still goes above them. */
    private var open = ArrayList<Int>()

    /** One message's rows as [built], by a `user` or anyone else: its words join [turn], its stacks wait. */
    fun add(turn: MutableList<ConversationRow>, role: String, built: List<ConversationRow>) {
        if (role == "user") open = ArrayList()
        val words = built.filter { it !is ConversationRow.Replies }
        turn += words
        words.lastOrNull()?.key?.let { last -> for (index in open) stacks[index] = stacks[index].first to last }
        if (role != "user") for (replies in built.filterIsInstance<ConversationRow.Replies>()) {
            open += stacks.size
            stacks += replies to turn.lastOrNull()?.key
        }
    }

    /** Puts every stack into [turn] where it goes. */
    fun place(turn: MutableList<ConversationRow>) {
        // From the last, so each goes in where the ones still to place expect it.
        for ((replies, after) in stacks.asReversed()) {
            turn.add(after?.let { key -> turn.indexOfFirst { it.key == key } + 1 } ?: 0, replies)
        }
    }
}

internal object QuickReplyRows {
    /**
     * Marks each stack in [rows], oldest first: the option a person's
     * message sent, by its `quickReply`, whether the computer has the
     * message ([history], in order) or it is still on its way from here
     * ([sending]); and whether the stack takes a tap, which only the newest
     * does, while nobody has written since and nothing is on its way.
     */
    fun mark(rows: MutableList<ConversationRow>, history: List<Message>, sending: List<QuickReply>, unsent: Boolean) {
        val newest = rows.lastOrNull { it is ConversationRow.Replies } as ConversationRow.Replies? ?: return
        val sent = history.mapNotNull { it.quickReply } + sending
        val quiet = !unsent && history.drop(history.indexOfFirst { it.id == newest.messageId } + 1).none { it.role == "user" }
        rows.replaceAll { row ->
            if (row !is ConversationRow.Replies) return@replaceAll row
            val chosen = sent.lastOrNull { it.messageId == row.messageId && it.toolCallId == row.toolCallId }?.index
            val live = quiet && row === newest
            if (chosen == row.chosen && live == row.live) row else row.copy(chosen = chosen, live = live)
        }
    }
}
