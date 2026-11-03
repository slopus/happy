package com.slopus.happy.call

import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.ui.conversation.conversationRequest
import com.slopus.happy.ui.conversation.signalsFor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** What a call needs of the screen: which conversation is on top, that one's own state, and a way to open another. */
interface CallScreen {
    /** The conversation on top of the stack, if one is. */
    val focused: String?
    /** The conversation the screen on top shows, while it is [focused]: its sends show there at once. */
    fun shown(agentId: String): Conversation?
    fun open(agentId: String)
}

/**
 * A call's tools and context over one agent connection (iOS's
 * `SessionCallTargets`): its home for the directory, and conversations of
 * the call's own for what the followed ones say, read from the computer and
 * kept nowhere on disk. A send goes through the conversation on screen when
 * it is the one, so it shows there at once; the composer's draft is never
 * touched ([Conversation.sendAs]). Runs on the main thread.
 */
class ConnectionCallTargets(
    private val session: AgentSession,
    /** A failed turn's reason, as its card words it. */
    private val failureText: (FailureReason) -> String,
    private val screen: () -> CallScreen?,
) : CallTargets {
    private class Held(val conversation: Conversation, var watch: Job? = null)

    private val held = HashMap<String, Held>()
    private val watching = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    /** A followed conversation changed. */
    var onChange: ((CallTargetState) -> Unit)? = null
    /** Ended with its call: nothing is held, opened or sent after. */
    private var closed = false

    fun close() {
        closed = true
        for (hold in held.values) release(hold)
        held.clear()
        watching.coroutineContext[Job]?.cancel()
        onChange = null
    }

    val focusedNow: String? get() = screen()?.focused

    private fun target(agentId: String): CallTarget? = CallTarget.from(session.feed.value).firstOrNull { it.agentId == agentId }

    override suspend fun directory(): List<CallTarget> = CallTarget.from(session.feed.value)

    override suspend fun state(agentId: String): CallTargetState? = onMain {
        val target = target(agentId) ?: return@onMain null
        held[agentId]?.conversation?.state?.value?.takeIf { it.loaded }?.let { return@onMain CallTargetState.from(it, target, failureText) }
        screen()?.takeIf { it.focused == agentId }?.shown(agentId)?.state?.value?.takeIf { it.loaded }?.let { return@onMain CallTargetState.from(it, target, failureText) }
        // One bounded read: about three seconds for its first page.
        val hold = make(agentId)
        try {
            val state = withTimeoutOrNull(READ_MILLIS) { hold.conversation.state.first { it.loaded } } ?: return@onMain null
            CallTargetState.from(state, target, failureText)
        } finally {
            release(hold)
        }
    }

    override suspend fun focused(): String? = onMain { focusedNow }

    override suspend fun open(agentId: String): Boolean = onMain {
        if (closed || target(agentId) == null) return@onMain false
        val screen = screen() ?: return@onMain false
        if (screen.focused != agentId) screen.open(agentId)
        true
    }

    override suspend fun send(agentId: String, text: String, id: String): CallSendOutcome = onMain {
        val target = target(agentId)
        if (closed || target == null) return@onMain CallSendOutcome.Refused("The call has ended.")
        // A conversation the call doesn't hear from is read for the send alone, and let go after it.
        val own = held[agentId] ?: make(agentId)
        val conversation = screen()?.takeIf { it.focused == agentId }?.shown(agentId) ?: own.conversation
        val outcome = run {
            // Under an ID it already has, it went the first time.
            if (conversation.has(id)) return@run CallSendOutcome.Queued
            val state = withTimeoutOrNull(READ_MILLIS) { conversation.state.first { it.loaded } }
                ?: return@run CallSendOutcome.Refused("That conversation can't be read now.")
            // Checked again here, where the send happens: a question that came
            // while the call's context read the conversation still stops it.
            val now = CallTargetState.from(state, target, failureText)
            when {
                !now.writable -> CallSendOutcome.Refused("That conversation can't take a message now.")
                now.needsInput -> CallSendOutcome.Refused("It's waiting for the person in the app; answer there first.")
                conversation.sendAs(id, text) -> CallSendOutcome.Queued
                else -> CallSendOutcome.Refused("It couldn't be kept on this phone.")
            }
        }
        if (held[agentId] !== own) release(own)
        outcome
    }

    /** The conversations held for the call. */
    val following: List<String> get() = held.keys.toList()

    override suspend fun follow(agentId: String, following: Boolean) = onMain {
        if (following) {
            if (closed || held.containsKey(agentId) || target(agentId) == null) return@onMain
            val hold = make(agentId)
            held[agentId] = hold
            hold.watch = watching.launch {
                hold.conversation.state.collect { state ->
                    val target = target(agentId) ?: return@collect
                    if (state.loaded) onChange?.invoke(CallTargetState.from(state, target, failureText))
                }
            }
        } else {
            held.remove(agentId)?.let(::release)
        }
    }

    private fun make(agentId: String): Held {
        val conversation = Conversation(
            api = ConversationApi(session.conversationRequest()),
            signals = session.events.signalsFor(agentId),
            // Not the call's: a send in flight finishes after the call lets it go.
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            agentId = agentId,
            knownTitle = session.feed.value.title(agentId),
        )
        conversation.start()
        return Held(conversation)
    }

    /** Stops reading it. Its scope is left to finish what it still delivers, as a closed chat screen's is. */
    private fun release(hold: Held) {
        hold.watch?.cancel()
        hold.conversation.close()
    }

    private suspend fun <T> onMain(block: suspend () -> T): T = withContext(Dispatchers.Main.immediate) { block() }

    private companion object {
        const val READ_MILLIS = 3_000L
    }
}
