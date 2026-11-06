package com.slopus.happy.call

import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.conversation.HeldConversations
import com.slopus.happy.conversation.RowTypesetter
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.conversation.WorkKind
import kotlinx.coroutines.delay
import com.slopus.happy.ui.conversation.makeConversation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** What a call needs of the screen: which conversation is on top, ways to open another or new work, and back and home. */
interface CallScreen {
    /** The conversation on top of the stack, if one is: new work's too, once its screen holds it. */
    val focused: String?
    fun open(agentId: String)
    /** New work, as compose opens it, with [choice] made. */
    fun compose(choice: WorkChoice)
    /** Pops the page on top; false at home, with nothing to go back to. */
    fun back(): Boolean
    val atHome: Boolean
    /** Pops every page over home. */
    fun home()
}

/**
 * A call's tools and context over one agent connection (iOS's
 * `SessionCallTargets`): its home for the directory, and for what the
 * followed ones say, the connection's one conversation of each
 * ([AgentSession.conversations]), the same one its screen shows. A send
 * made here shows there at once, goes once and is kept once; the
 * composer's draft is never touched ([Conversation.sendAs]). A call reads
 * what comes, but never marks it read: that is the screen's. Runs on the
 * main thread.
 */
class ConnectionCallTargets(
    private val session: AgentSession,
    /** A failed turn's reason, as its card words it. */
    private val failureText: (FailureReason) -> String,
    /** The process's, as the screen's: the rows are laid out once, whoever made the conversation. */
    private val typesetter: RowTypesetter?,
    private val screen: () -> CallScreen?,
) : CallTargets {
    private class Held(val hold: HeldConversations.Hold, var watch: Job? = null) {
        val conversation: Conversation get() = hold.conversation
    }

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
        val target = target(agentId) ?: run {
            // New work its screen holds: empty until its first message, which it takes.
            val draft = unmade(agentId) ?: return@onMain null
            val state = draft.state.value
            return@onMain withModels(CallTargetState.from(state, draftTarget(agentId, state), failureText).copy(writable = state.error == null), state)
        }
        // Held by the call, its screen or anyone: as it is now.
        session.conversations.peek(agentId)?.state?.value?.takeIf { it.loaded }?.let { return@onMain withModels(CallTargetState.from(it, target, failureText), it) }
        // One bounded read: about three seconds for its first page.
        val hold = make(agentId)
        try {
            val state = withTimeoutOrNull(READ_MILLIS) { hold.conversation.state.first { it.loaded } } ?: return@onMain null
            withModels(CallTargetState.from(state, target, failureText), state)
        } finally {
            release(hold)
        }
    }

    /** [read] with the model its next message goes with and the models the pickers offer, once the computer's are read. */
    private fun withModels(read: CallTargetState, state: ConversationState): CallTargetState {
        val catalog = state.catalog ?: return read
        val mode = state.mode ?: catalog.defaults
        return read.copy(models = CallModel.options(catalog), mode = mode?.let { CallMode.of(it, catalog) })
    }

    /** New work under [agentId] whose screen holds it, not made yet. */
    private fun unmade(agentId: String): Conversation? =
        session.conversations.peek(agentId)?.takeIf { it.state.value.newWork != null && target(agentId) == null }

    /** New work as the call names it: its name, else home's "New Task" or "New Bot" until its first message names it. */
    private fun draftTarget(agentId: String, state: ConversationState): CallTarget {
        val choice = state.newWork?.choice ?: WorkChoice()
        val kind = if (choice.kind == WorkKind.Bot) CallTarget.Kind.Bot else CallTarget.Kind.Task
        val name = CallTarget.clean(choice.name)
        return CallTarget(agentId, name.ifEmpty { if (kind == CallTarget.Kind.Bot) "New Bot" else "New Task" }, kind, CallTarget.Status.Idle)
    }

    override suspend fun unlisted(agentId: String): CallTarget? = onMain {
        unmade(agentId)?.let { draftTarget(agentId, it.state.value) }
    }

    /**
     * Compose's new work, chosen as the call asks, on screen as compose puts it; its conversation once the screen
     * holds it. Already in front, unmade, it only takes the choice, as compose's own does.
     */
    override suspend fun newWork(kind: CallTarget.Kind, name: String): CallTarget? = onMain {
        if (closed) return@onMain null
        val screen = screen() ?: return@onMain null
        val choice = WorkChoice(if (kind == CallTarget.Kind.Bot) WorkKind.Bot else WorkKind.Task, name)
        screen.focused?.let(::unmade)?.let { shown ->
            shown.setChoice(choice)
            return@onMain draftTarget(shown.agentId, shown.state.value.copy(newWork = shown.state.value.newWork?.copy(choice = choice)))
        }
        val before = screen.focused
        screen.compose(choice)
        val agentId = withTimeoutOrNull<String>(OPEN_MILLIS) {
            var shown = screen.focused
            while (shown == null || shown == before || unmade(shown) == null) {
                delay(50)
                shown = screen.focused
            }
            shown
        } ?: return@onMain null
        unlisted(agentId)
    }

    override suspend fun back(): CallScreenMove = onMain {
        val screen = screen() ?: return@onMain CallScreenMove.Refused("The call has ended.")
        if (closed) return@onMain CallScreenMove.Refused("The call has ended.")
        if (!screen.back()) return@onMain CallScreenMove.Refused("This is home; there is nothing to go back to.")
        CallScreenMove.Moved(screen.atHome)
    }

    override suspend fun home(): CallScreenMove = onMain {
        val screen = screen() ?: return@onMain CallScreenMove.Refused("The call has ended.")
        if (closed) return@onMain CallScreenMove.Refused("The call has ended.")
        screen.home()
        CallScreenMove.Moved(true)
    }

    override suspend fun focused(): String? = onMain { focusedNow }

    override suspend fun open(agentId: String): Boolean = onMain {
        if (closed || target(agentId) == null) return@onMain false
        val screen = screen() ?: return@onMain false
        if (screen.focused != agentId) screen.open(agentId)
        true
    }

    override suspend fun send(agentId: String, text: String, id: String, change: CallModeChange?): CallSendOutcome = onMain {
        if (closed) return@onMain CallSendOutcome.Refused("The call has ended.")
        val target = target(agentId) ?: run {
            // New work: its first message makes it, in the conversation its screen holds.
            val draft = unmade(agentId) ?: return@onMain CallSendOutcome.Refused("That new work was closed before anything was sent.")
            if (draft.has(id)) return@onMain CallSendOutcome.Queued
            switch(draft, change)
            return@onMain if (draft.sendAs(id, text)) CallSendOutcome.Queued else CallSendOutcome.Refused("It couldn't be kept on this phone.")
        }
        // A conversation the call doesn't hear from is read for the send alone, and let go after it.
        val own = held[agentId] ?: make(agentId)
        val conversation = own.conversation
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
                else -> {
                    switch(conversation, change)
                    if (conversation.sendAs(id, text)) CallSendOutcome.Queued else CallSendOutcome.Refused("It couldn't be kept on this phone.")
                }
            }
        }
        if (held[agentId] !== own) release(own)
        outcome
    }

    /**
     * The composer's model pick, made for the call: [change] on what the next message goes with, as the pickers make
     * it ([ModeCatalog.pick]), in the conversation its screen shows, so the chips say so at once.
     */
    private fun switch(conversation: Conversation, change: CallModeChange?) {
        change ?: return
        val state = conversation.state.value
        val catalog = state.catalog ?: return
        val current = state.mode ?: catalog.defaults ?: return
        val next = change.applied(current, catalog)
        if (next != current) conversation.setMode(next)
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

    private fun make(agentId: String): Held =
        Held(session.conversations.hold(agentId) { session.makeConversation(agentId, typesetter) })

    /** Lets it go: closed once nobody holds it, after what it still sends ([HeldConversations]). */
    private fun release(hold: Held) {
        hold.watch?.cancel()
        hold.hold.release()
    }

    private suspend fun <T> onMain(block: suspend () -> T): T = withContext(Dispatchers.Main.immediate) { block() }

    private companion object {
        const val READ_MILLIS = 3_000L
        /** How long new work's screen has to come up and hold its conversation. */
        const val OPEN_MILLIS = 3_000L
    }
}
