package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.Body

/**
 * Whether any user message in [messages] expects a receipt it hasn't had:
 * the rows the reducer holds pending after their echo (reducer.ts `hold`),
 * which sync.ts counts in `hasPendingUserMessage` alongside the outbox.
 */
fun hasUnreceiptedUserMessage(messages: List<NormalizedMessage>): Boolean {
    val receipted = HashSet<String>()
    for (message in messages) {
        when (val event = (message.body as? Body.Event)?.event) {
            is AgentEvent.UserMessageAccepted -> receipted.add(event.ref)
            is AgentEvent.UserMessageRejected -> receipted.add(event.ref)
            else -> Unit
        }
    }
    return messages.any { it.body is Body.User && it.meta?.expectsAcceptance == true && it.id !in receipted }
}
