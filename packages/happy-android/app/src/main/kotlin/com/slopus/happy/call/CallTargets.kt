package com.slopus.happy.call

import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery

/** One conversation a call can talk about: a bot, a task or another conversation of the connection the call is bound to. */
data class CallTarget(
    val agentId: String,
    val title: String,
    val kind: Kind,
    val project: String? = null,
    val status: Status,
) {
    enum class Kind(val wire: String) { Bot("bot"), Task("task"), Conversation("conversation") }

    enum class Status(val wire: String) {
        Running("running"),
        Waiting("waiting"),
        /** A question or a review waits for the person, in the app. */
        NeedsInput("needs_input"),
        Idle("idle"),
    }

    companion object {
        /** Home's conversations, each once, in its order. */
        fun from(feed: AgentFeed): List<CallTarget> {
            val seen = HashSet<String>()
            return feed.rows.mapNotNull { row ->
                val conversation = row as? AgentFeedRow.Conversation ?: return@mapNotNull null
                if (!seen.add(conversation.agentId)) return@mapNotNull null
                CallTarget(
                    agentId = conversation.agentId,
                    title = conversation.title.orEmpty(),
                    kind = when (conversation.kind) {
                        ConversationKind.Bot -> Kind.Bot
                        ConversationKind.Task -> Kind.Task
                        else -> Kind.Conversation
                    },
                    status = when {
                        conversation.blocked -> Status.NeedsInput
                        conversation.waiting -> Status.Waiting
                        conversation.working -> Status.Running
                        else -> Status.Idle
                    },
                )
            }
        }
    }
}

/** One public message of a conversation, as the call may read it. */
data class CallMessage(
    val id: String,
    val role: Role,
    val text: String,
    val time: Long? = null,
    /** False while the agent is still writing it. */
    val final: Boolean = true,
    val delivery: Delivery? = null,
) {
    enum class Role(val wire: String) { User("user"), Assistant("assistant") }

    enum class Delivery(val wire: String) {
        /** On this phone, not yet taken by the computer. */
        Queued("queued"),
        Accepted("accepted"),
        Failed("failed"),
    }
}

/**
 * What the call knows of one conversation: its public words and whether it
 * is working, waits for the person, and can take a message. Never its tools,
 * reasoning, files, questions' contents or drafts.
 */
data class CallTargetState(
    val target: CallTarget,
    val messages: List<CallMessage> = emptyList(),
    val working: Boolean = false,
    val needsInput: Boolean = false,
    /** It has been read and takes messages. */
    val writable: Boolean = true,
    /** The person has typed something there (never what). */
    val hasDraft: Boolean = false,
    val hasMore: Boolean = false,
) {
    companion object {
        /**
         * A conversation's state as the call reads it: the person's and the
         * agent's words only; the agent's last words while it works are not
         * final. A question that waits is a flag, never its words.
         */
        fun from(state: ConversationState, target: CallTarget): CallTargetState {
            val messages = ArrayList<CallMessage>()
            var needsInput = state.question != null
            for (row in state.rows) {
                when (row) {
                    is ConversationRow.User -> if (row.text.isNotEmpty()) {
                        val delivery = when (row.delivery) {
                            Delivery.Sending -> CallMessage.Delivery.Queued
                            Delivery.Pending, Delivery.Sent -> CallMessage.Delivery.Accepted
                            is Delivery.Failed -> CallMessage.Delivery.Failed
                        }
                        messages += CallMessage(row.messageId, CallMessage.Role.User, row.text, row.createdAt.takeIf { it > 0 }, delivery = delivery)
                    }
                    is ConversationRow.Text -> {
                        val text = row.current
                        if (text.isEmpty()) continue
                        // A message's text blocks are one message: keys are "<message>:<block>".
                        val id = row.key.substringBeforeLast(':')
                        val last = messages.lastOrNull()
                        if (last != null && last.role == CallMessage.Role.Assistant && last.id == id) {
                            messages[messages.lastIndex] = last.copy(text = last.text + "\n\n" + text)
                        } else {
                            messages += CallMessage(id, CallMessage.Role.Assistant, text)
                        }
                    }
                    is ConversationRow.Ask -> if (row.phase != AskPhase.Answered) needsInput = true
                    else -> Unit
                }
            }
            if (state.working) {
                val last = messages.lastIndex
                if (last >= 0 && messages[last].role == CallMessage.Role.Assistant) messages[last] = messages[last].copy(final = false)
            }
            val status = when {
                needsInput -> CallTarget.Status.NeedsInput
                state.working -> CallTarget.Status.Running
                else -> target.status
            }
            return CallTargetState(
                target = target.copy(status = status),
                messages = messages,
                working = state.working,
                needsInput = needsInput,
                writable = state.created && state.loaded && state.error == null && state.canSend,
                hasDraft = state.draft.isNotEmpty(),
                hasMore = state.hasMore,
            )
        }
    }
}

sealed interface CallSendOutcome {
    /** Kept on this phone and on its way; the computer's answer comes later as a delivery update. */
    data object Queued : CallSendOutcome
    data class Refused(val reason: String) : CallSendOutcome
}

/**
 * The connection a call is bound to, as the call's tools reach it. The app
 * implements it over the connection's home and conversations; nothing here
 * can name another account, an endpoint or a credential.
 */
interface CallTargets {
    /** Every conversation home lists, in its order. */
    suspend fun directory(): List<CallTarget>
    /** One conversation, read if it must be (a bounded page); null if the connection has none by that ID. */
    suspend fun state(agentId: String): CallTargetState?
    /** The conversation on screen, if one is. */
    suspend fun focused(): String?
    /** Opens it on screen; true once it shows. */
    suspend fun open(agentId: String): Boolean
    /** Sends [text] exactly as given, under [id], the way the composer's send does but without touching its draft. */
    suspend fun send(agentId: String, text: String, id: String): CallSendOutcome
    /** Keeps a conversation read (or lets it go) while the call follows it. */
    suspend fun follow(agentId: String, following: Boolean)
}
