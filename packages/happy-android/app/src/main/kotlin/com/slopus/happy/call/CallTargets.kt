package com.slopus.happy.call

import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.FailureReason

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
 * One finished turn of a conversation: the person's message that started it
 * and the agent's final answer, as the turn's copy button copies it
 * ([ConversationRow.TurnEnd.copyText]), never its commentary or tool output.
 */
data class CallTurn(
    val id: String,
    val user: String? = null,
    val reply: String? = null,
    /** `completed`, `error`, `abort`, `steering` or `compaction`. */
    val ended: String = "completed",
    /** Why it stopped, for one that ended in an error. */
    val error: String? = null,
)

/**
 * What the call knows of one conversation: its finished turns, the person's
 * message still waiting for an answer, the agent's words as they come, and
 * whether it is working, waits for the person and can take a message. Never
 * its tools, reasoning, files, questions' contents or drafts.
 */
data class CallTargetState(
    val target: CallTarget,
    /** Every public message, the agent's still being written included (`final` false): what the live words are read from. */
    val messages: List<CallMessage> = emptyList(),
    val turns: List<CallTurn> = emptyList(),
    /** The person's latest message, when no finished turn answers it. */
    val unanswered: CallMessage? = null,
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
         * final. A question that waits is a flag, never its words. A run's
         * rows come together, its turn end after them, so a turn is what
         * came since the previous turn end: its first message of the
         * person's, its answer, and the failure that ended it, worded by
         * [failureText].
         */
        fun from(state: ConversationState, target: CallTarget, failureText: (FailureReason) -> String = { "" }): CallTargetState {
            val messages = ArrayList<CallMessage>()
            val turns = ArrayList<CallTurn>()
            var asked: String? = null
            var failure: String? = null
            var pending: CallMessage? = null
            var needsInput = state.question != null
            for (row in state.rows) {
                when (row) {
                    is ConversationRow.User -> if (row.text.isNotEmpty()) {
                        val delivery = when (row.delivery) {
                            Delivery.Sending -> CallMessage.Delivery.Queued
                            Delivery.Pending, Delivery.Sent -> CallMessage.Delivery.Accepted
                            is Delivery.Failed -> CallMessage.Delivery.Failed
                        }
                        val message = CallMessage(row.messageId, CallMessage.Role.User, row.text, row.createdAt.takeIf { it > 0 }, delivery = delivery)
                        messages += message
                        if (asked == null) asked = row.text
                        pending = message
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
                    is ConversationRow.Failure -> failure = failureText(row.reason)
                    is ConversationRow.TurnEnd -> {
                        turns += CallTurn(row.turn, asked, row.copyText, row.reason, failure.takeIf { row.reason == "error" })
                        asked = null
                        failure = null
                        pending = null
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
                turns = turns,
                unanswered = pending,
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
