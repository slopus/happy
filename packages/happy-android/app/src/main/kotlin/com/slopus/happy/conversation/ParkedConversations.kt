package com.slopus.happy.conversation

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Conversations whose screen went while a send was still on its way
 * (desktop 01659140, `composerSubmissions`): an upload or a send belongs to
 * the conversation it was made in, across navigation. The next screen for
 * that agent [adopt]s the same [Conversation], so the send is still shown
 * sending, or failed with Retry, and nothing can be sent twice; one nobody
 * comes back to is closed once everything it sent has been taken.
 */
class ParkedConversations(private val scope: CoroutineScope) {
    private val parked = ConcurrentHashMap<String, Conversation>()

    /** Keeps [conversation] while it has a send in hand; closes it at once when it has none. */
    fun park(conversation: Conversation) {
        if (!conversation.state.value.holdsSends) {
            conversation.close()
            return
        }
        parked.put(conversation.agentId, conversation)?.takeIf { it !== conversation }?.close()
        scope.launch {
            conversation.state.first { !it.holdsSends }
            if (parked.remove(conversation.agentId, conversation)) conversation.close()
        }
    }

    /** The conversation left for [agentId] with a send in hand, taken back; null when there is none. */
    fun adopt(agentId: String): Conversation? = parked.remove(agentId)
}

/** A send not yet taken by the agent (on its way or failed), or new work still being made for one. */
val ConversationState.holdsSends: Boolean get() = unsettledSends || newWork?.making == true
