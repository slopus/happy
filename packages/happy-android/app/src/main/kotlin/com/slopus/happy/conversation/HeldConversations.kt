package com.slopus.happy.conversation

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * One [Conversation] per agent on a connection, whoever shows or follows it:
 * its screen, a voice call, home's preview. Each takes a [Hold]; the first
 * makes it, the rest share it, so a send made in one shows in all, goes
 * once, and is kept once ([ConversationKeeper]). It reads what comes while
 * any holder [observes][Hold.observe], and marks it read while any
 * [shows][Hold.show] it: only a screen does, never a call.
 *
 * The last holder gone, it is closed, unless a send is still in hand
 * (desktop 01659140, `composerSubmissions`): an upload or a send belongs to
 * the conversation it was made in, so it is kept until everything it sent
 * has been taken, and the next [hold] for that agent takes it back, still
 * sending, or failed with Retry, and nothing can be sent twice.
 */
class HeldConversations(private val scope: CoroutineScope) {
    /** One holder's claim on [conversation]; [release] it once, when the holder goes. */
    inner class Hold internal constructor(val conversation: Conversation) {
        internal var observing = true
        internal var showing = false
        internal var released = false

        /** Whether this holder wants what comes read: a screen covered by another doesn't. Every hold starts wanting it. */
        fun observe(value: Boolean) = observe(this, value)

        /** Whether this holder has it on screen, so what arrives is marked read ([Conversation.setVisible]). No hold starts so. */
        fun show(value: Boolean) = show(this, value)

        fun release() = release(this)
    }

    private class Entry(val conversation: Conversation) {
        val holds = ArrayList<Hold>()
    }

    private val held = HashMap<String, Entry>()
    /** Nobody holds them, and a send is in hand: kept until it settles, or the next hold takes it. */
    private val parked = HashMap<String, Conversation>()

    /** [agentId]'s conversation: the one held or parked, or else [make]'s, started. */
    fun hold(agentId: String, make: () -> Conversation): Hold = synchronized(this) {
        val entry = held.getOrPut(agentId) { Entry(parked.remove(agentId) ?: make().also { it.start() }) }
        Hold(entry.conversation).also {
            entry.holds += it
            follow(entry)
        }
    }

    /** [agentId]'s conversation while someone holds it; never makes one. */
    fun peek(agentId: String): Conversation? = synchronized(this) { held[agentId]?.conversation }

    private fun observe(hold: Hold, value: Boolean) {
        synchronized(this) {
            if (hold.released || hold.observing == value) return
            hold.observing = value
            held[hold.conversation.agentId]?.takeIf { it.conversation === hold.conversation }?.let(::follow)
        }
    }

    private fun show(hold: Hold, value: Boolean) {
        synchronized(this) {
            if (hold.released) return
            hold.showing = value
            val entry = held[hold.conversation.agentId]?.takeIf { it.conversation === hold.conversation } ?: return
            // Each screen's own say, as the screen gave it: shown again reads what came meanwhile.
            entry.conversation.setVisible(entry.holds.any { it.showing })
        }
    }

    private fun follow(entry: Entry) {
        entry.conversation.setObserving(entry.holds.any { it.observing })
    }

    private fun release(hold: Hold) {
        val conversation = hold.conversation
        val keep = synchronized(this) {
            if (hold.released) return
            hold.released = true
            val entry = held[conversation.agentId]?.takeIf { it.conversation === conversation } ?: return
            entry.holds.remove(hold)
            // Its claim to be on screen goes with it; another's still stands.
            if (hold.showing && entry.holds.none { it.showing }) conversation.setVisible(false)
            if (entry.holds.isNotEmpty()) return follow(entry)
            held.remove(conversation.agentId)
            conversation.state.value.holdsSends.also { keep ->
                if (keep) parked.put(conversation.agentId, conversation)?.takeIf { it !== conversation }?.close()
            }
        }
        if (!keep) return conversation.close()
        scope.launch {
            conversation.state.first { !it.holdsSends }
            if (synchronized(this@HeldConversations) { parked.remove(conversation.agentId, conversation) }) conversation.close()
        }
    }
}

/** A send not yet taken by the agent (on its way or failed); new work's first message is one. */
val ConversationState.holdsSends: Boolean get() = unsettledSends
