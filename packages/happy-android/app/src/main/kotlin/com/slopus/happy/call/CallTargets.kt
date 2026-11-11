package com.slopus.happy.call

import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog

/**
 * One conversation a call can talk about, as home lists it (iOS's
 * `CallTarget`, the sidebar's): a bot, a task, a subtask under any of them,
 * or a project's conversation. The call sees what the person sees, nothing
 * more and nothing less.
 */
data class CallTarget(
    val agentId: String,
    /** Home's label, whatever it is: "New Task" or "Untitled" too. */
    val title: String,
    val kind: Kind,
    val status: Status,
    val parents: List<Parent> = emptyList(),
    /** When home says it last did something (ms since 1970), what it orders by; null when it doesn't say. */
    val activityAt: Long? = null,
) {
    /**
     * The project and worktree it runs in, outermost first: the headings it
     * sits under. Empty for a bot or a task, which run in a workspace of their
     * own. The computer tells the phone no folder paths.
     */
    val workspace: List<String> get() = parents.filter { it.agentId == null }.map { it.title }

    enum class Kind(val wire: String) {
        Bot("bot"),
        Task("task"),
        Subtask("subtask"),
        /** A project's or a worktree's own conversation. */
        Conversation("conversation"),
    }

    enum class Status(val wire: String) {
        Running("running"),
        Waiting("waiting"),
        /** A question or a review waits for the person, in the app. */
        NeedsInput("needs_input"),
        Idle("idle"),
    }

    /** What a conversation sits under on home, outermost first: a project or a worktree heading, or the conversation a subtask is of. */
    data class Parent(
        /** Home's row key, unique among the rows. */
        val id: String,
        val title: String,
        /** `project` or `workspace` for a heading, else the conversation's kind. */
        val kind: String,
        /** The conversation's, for one; null for a heading. */
        val agentId: String? = null,
    )

    companion object {
        /**
         * The labels home shows for work nobody has named yet: the
         * computer's, until the first message names it, and the rows' own
         * for none.
         */
        val placeholders = setOf("", "New Task", "New Bot", "Untitled")

        /** Longest a title goes into the call, in UTF-8. */
        const val TITLE_BYTES = 200

        /**
         * Every conversation home's rows open, in their order, once each (the
         * first row wins), with what each sits under. Rows that open none
         * (Surfaces, Artifacts, todos) are skipped; a project or a worktree is
         * a heading.
         */
        fun from(feed: AgentFeed): List<CallTarget> {
            val result = ArrayList<CallTarget>()
            val seen = HashSet<String>()
            val path = ArrayList<Pair<Int, Parent>>()
            for (row in feed.rows) {
                val depth = when (row) {
                    is AgentFeedRow.Folder -> row.depth
                    is AgentFeedRow.Conversation -> row.depth
                    else -> {
                        path.clear()
                        continue
                    }
                }
                while (path.isNotEmpty() && path.last().first >= depth) path.removeAt(path.lastIndex)
                if (row is AgentFeedRow.Folder) {
                    path += depth to Parent(row.key, clean(row.name), if (depth == 0) "project" else "workspace")
                    continue
                }
                row as AgentFeedRow.Conversation
                val target = CallTarget(
                    agentId = row.agentId,
                    title = clean(row.title ?: "Untitled"),
                    kind = when (row.kind) {
                        ConversationKind.Bot -> Kind.Bot
                        ConversationKind.Task -> Kind.Task
                        ConversationKind.Subtask -> Kind.Subtask
                        // A conversation under another's is its subtask.
                        ConversationKind.Project -> if (path.lastOrNull()?.second?.agentId != null) Kind.Subtask else Kind.Conversation
                    },
                    status = when {
                        row.blocked -> Status.NeedsInput
                        row.waiting -> Status.Waiting
                        row.working -> Status.Running
                        else -> Status.Idle
                    },
                    parents = path.map { it.second },
                    activityAt = row.activityAt.takeIf { it > 0 },
                )
                path += depth to Parent(row.key, target.title, target.kind.wire, target.agentId)
                if (seen.add(target.agentId)) result += target
            }
            return result
        }

        /** A label on one line, without control characters, cut at [TITLE_BYTES]. */
        fun clean(label: String): String {
            // A line break, a tab or any other control character is a space.
            val plain = buildString { label.codePoints().forEach { appendCodePoint(if (Character.getType(it) == Character.CONTROL.toInt()) ' '.code else it) } }
            return CallContext.truncated(plain.trim(' '), TITLE_BYTES)
        }
    }
}

/** One public message of a conversation, as the call may read it. */
data class CallMessage(
    val id: String,
    val role: Role,
    val text: String,
    val time: Long? = null,
    /**
     * The agent has gone on past it (a tool call, more words after one, a
     * turn's end) or its run is over: what it says is complete. False for
     * the agent's last words while it still works.
     */
    val final: Boolean = true,
    val delivery: Delivery? = null,
    /** The agent's run it is of, once that run has ended ([ConversationRow.TurnEnd.turn]); null in the run still going. */
    val turn: String? = null,
    /** On a team's computer, the member who wrote a person's message, by user ID ([ConversationRow.User.author]), and as the call names them ([CallTargetState.named]). */
    val author: String? = null,
    val by: String? = null,
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
 * One finished run of a conversation: the person's message that started it
 * and the agent's final answer, as the turn's copy button copies it
 * ([ConversationRow.TurnEnd.copyText]), never its commentary or tool output.
 * Or, as [CallTargetState.exchanges] makes them, one exchange of the person's
 * message and the agent's answer, its runs in one.
 */
data class CallTurn(
    val id: String,
    val user: String? = null,
    val reply: String? = null,
    /** `completed`, `error`, `abort`, `steering` or `compaction`. */
    val ended: String = "completed",
    /** Why it stopped, for one that ended in an error. */
    val error: String? = null,
    /** When it ended (ms); null where that isn't known. */
    val endedAt: Long? = null,
    /** Who wrote [user], as [CallMessage.author] and [CallMessage.by] have it. */
    val userAuthor: String? = null,
    val userBy: String? = null,
) {
    /** The exchanges finished runs make ([exchanges]), and whether the newest has no answer yet, with the run whose message started it. */
    class Exchanges(val answered: List<CallTurn>, val open: Boolean, val asker: String?)

    companion object {
        /** How a run ends that leaves its exchange going: the person's steering started the next, or a compaction did. */
        private val CUT_SHORT = setOf("steering", "compaction")

        /**
         * The exchanges [runs] make, oldest first. One is the person's message and all the agent did after it until
         * the person's next: the runs steering or a compaction cut short, and the agent's own runs (no message of the
         * person's) after them, go on with it, as does the person's steering while it has no answer yet; it keeps the
         * message that started it, or takes the first if it had none, and the ID of its first run. Its answer is its
         * last run that wasn't cut short: how that ended, when, its error, and the last words of its runs up to there.
         * One with no answer yet is left out, the newest alone: [Exchanges.open], with the run whose message started it
         * ([Exchanges.asker]), null while it has none.
         */
        fun exchanges(runs: List<CallTurn>): Exchanges {
            val answered = ArrayList<CallTurn>()
            var current: CallTurn? = null
            var asker: String? = null
            // The last words of its runs, and whether it has an answer.
            var words: String? = null
            var settled = false
            var cut = false
            for (run in runs) {
                val asks = !run.user.isNullOrEmpty()
                val going = current
                var exchange = if (going != null && (!asks || (cut && !settled))) {
                    if (asks && going.user.isNullOrEmpty()) {
                        asker = run.id
                        going.copy(user = run.user, userAuthor = run.userAuthor, userBy = run.userBy)
                    } else going
                } else {
                    if (going != null && settled) answered += going
                    asker = if (asks) run.id else null
                    words = null
                    settled = false
                    CallTurn(run.id, run.user, userAuthor = run.userAuthor, userBy = run.userBy)
                }
                if (!run.reply.isNullOrEmpty()) words = run.reply
                cut = run.ended in CUT_SHORT
                if (!cut) {
                    settled = true
                    exchange = exchange.copy(reply = words, ended = run.ended, error = run.error, endedAt = run.endedAt)
                }
                current = exchange
            }
            current?.let { if (settled) answered += it }
            return Exchanges(answered, current != null && !settled, asker)
        }
    }
}

/**
 * What the call knows of one conversation: its finished turns, the person's
 * message still waiting for an answer, the agent's words as they come, and
 * whether it is working, waits for the person and can take a message. Never
 * its tools, reasoning, files, questions' contents or drafts.
 */
data class CallTargetState(
    val target: CallTarget,
    /** Every public message, the agent's still being written included (`final` false). The agent's are its words between steps, one message each. */
    val messages: List<CallMessage> = emptyList(),
    /** Its finished runs, oldest first. What is read of it is [exchanges]. */
    val turns: List<CallTurn> = emptyList(),
    /** The person's message whose exchange has no answer yet, the newest: one steering that exchange is never it. */
    val unanswered: CallMessage? = null,
    val working: Boolean = false,
    val needsInput: Boolean = false,
    /** It has been read and takes messages. */
    val writable: Boolean = true,
    /** The person has typed something there (never what). */
    val hasDraft: Boolean = false,
    val hasMore: Boolean = false,
    /** The model and effort its next message goes with, if the computer's models are known. */
    val mode: CallMode? = null,
    /** What it may switch to ([CallModel.options]); empty while the computer's models aren't known. */
    val models: List<CallModel> = emptyList(),
    /** What it says is current: read from the computer, whose events it follows live. False for what this phone kept, until the computer answers. */
    val fresh: Boolean = true,
    /** When this phone last read it from the computer (ms since 1970); null if never. */
    val checkedAt: Long? = null,
) {
    companion object {
        /**
         * A conversation's state as the call reads it: the person's and the
         * agent's words only, each of the agent's text blocks its own message
         * (its words between steps, as iOS has them). A question that waits is
         * a flag, never its words. A run's rows come together, its turn end
         * after them, so a turn is what came since the previous turn end: its
         * first message of the person's, its answer, and the failure that
         * ended it, worded by [failureText]. The state's rows are newest
         * first, as the chat draws them; they are read oldest first.
         */
        fun from(state: ConversationState, target: CallTarget, failureText: (FailureReason) -> String = { "" }): CallTargetState {
            val messages = ArrayList<CallMessage>()
            val turns = ArrayList<CallTurn>()
            // The person's first message since the last run's end, and each run's.
            var asked: CallMessage? = null
            val users = HashMap<String, CallMessage>()
            var failure: String? = null
            var needsInput = state.question != null
            // The agent's words in the run still going, by index in [messages], and that run's last step.
            val running = ArrayList<Int>()
            var lastStep: ConversationRow? = null
            for (row in state.rows.asReversed()) {
                if (row.isStep) lastStep = row
                when (row) {
                    is ConversationRow.User -> if (row.text.isNotEmpty()) {
                        val delivery = when (row.delivery) {
                            Delivery.Sending -> CallMessage.Delivery.Queued
                            Delivery.Pending, Delivery.Sent -> CallMessage.Delivery.Accepted
                            is Delivery.Failed -> CallMessage.Delivery.Failed
                        }
                        val message = CallMessage(row.messageId, CallMessage.Role.User, row.text, row.createdAt.takeIf { it > 0 }, delivery = delivery, author = row.author)
                        messages += message
                        if (asked == null) asked = message
                    }
                    is ConversationRow.Text -> {
                        val text = row.current
                        if (text.isEmpty()) continue
                        running += messages.size
                        messages += CallMessage(row.key, CallMessage.Role.Assistant, text)
                    }
                    is ConversationRow.Failure -> failure = failureText(row.reason)
                    is ConversationRow.TurnEnd -> {
                        turns += CallTurn(row.turn, asked?.text, row.copyText, row.reason, failure.takeIf { row.reason == "error" }, row.endedAt, asked?.author)
                        asked?.let { users[row.turn] = it }
                        for (index in running) messages[index] = messages[index].copy(turn = row.turn)
                        running.clear()
                        asked = null
                        failure = null
                    }
                    is ConversationRow.Ask -> if (row.phase != AskPhase.Answered) needsInput = true
                    else -> Unit
                }
            }
            // The agent's words are complete once it went on past them in their run, or the run is over: only the
            // run still going may end mid-block, and in it words with a step after them (a tool call, more words, a
            // failure) are complete. Anything else after them, the person's message or another agent's, says nothing of that.
            val last = lastStep
            if (state.working && last is ConversationRow.Text) {
                val index = messages.indexOfLast { it.role == CallMessage.Role.Assistant && it.id == last.key }
                if (index >= 0 && index in running) messages[index] = messages[index].copy(final = false)
            }
            // A message after the last run's end steers an exchange that has no answer yet, which keeps its own; else it starts one.
            val exchanges = CallTurn.exchanges(turns)
            val pending = if (exchanges.open) exchanges.asker?.let(users::get) ?: asked else asked
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
                fresh = state.synced,
                checkedAt = state.syncedAt,
            )
        }
    }

    /**
     * What is read of it (`readConversation`, the first context): its exchanges, oldest first, each the person's
     * message and the agent's answer, however many runs that took ([CallTurn.exchanges]).
     */
    val exchanges: List<CallTurn> get() = CallTurn.exchanges(turns).answered

    /** The members who wrote its messages, by user ID, for [named]. */
    val authors: Set<String> get() = (messages.mapNotNull { it.author } + turns.mapNotNull { it.userAuthor }).toSet()

    /**
     * With who wrote each of the person's messages said: "the person" for [me] (the one on the call), a member by
     * the name in [names], else "a teammate". Outside a team nothing has an author, and nothing changes.
     */
    fun named(names: Map<String, String>, me: String?): CallTargetState {
        fun name(id: String?): String? = when {
            id == null -> null
            id == me -> "the person"
            else -> names[id]?.takeIf { it.isNotEmpty() }?.let(CallTarget::clean) ?: "a teammate"
        }
        return copy(
            messages = messages.map { it.copy(by = name(it.author)) },
            turns = turns.map { it.copy(userBy = name(it.userAuthor)) },
            unanswered = unanswered?.let { it.copy(by = name(it.author)) },
        )
    }
}

/** What the agent itself does in a run: its words, a tool call and what it presented, chat UI, the run's end or failure. */
private val ConversationRow.isStep: Boolean get() = when (this) {
    is ConversationRow.Text, is ConversationRow.Tool, is ConversationRow.Media, is ConversationRow.Artifact,
    is ConversationRow.Ui, is ConversationRow.UiMedia, is ConversationRow.Failure, is ConversationRow.TurnEnd -> true
    else -> false
}

/** A model the call may switch a conversation to: one the composer's model picker offers. */
data class CallModel(
    val id: String,
    val name: String,
    /** Least to most; empty for a model that takes no effort. */
    val efforts: List<String>,
    /** What switching to it runs at unless an effort is asked for. */
    val defaultEffort: String = efforts.firstOrNull().orEmpty(),
) {
    companion object {
        /** Every model the pickers list: each switched-on, shown account's models, less those it keeps out of the pickers, once each in the catalog's order. */
        fun options(catalog: ModeCatalog): List<CallModel> {
            val seen = HashSet<String>()
            return catalog.providers.filter { !it.isDisabled && !it.hidden }.flatMap { provider ->
                provider.models.filter { it.modelId !in provider.hiddenModels && seen.add(it.modelId) }.map {
                    CallModel(it.modelId, it.name, it.efforts, it.defaultEffort ?: it.efforts.firstOrNull().orEmpty())
                }
            }
        }
    }
}

/** The model and effort a conversation's next message goes with. */
data class CallMode(val modelId: String, /** As the picker names it. */ val model: String, val effort: String) {
    companion object {
        fun of(mode: Mode, catalog: ModeCatalog) = CallMode(mode.modelId, catalog.model(mode.providerId, mode.modelId)?.name ?: mode.modelId, mode.effort)
    }
}

/** What a send by voice changes first, checked against the conversation's [CallTargetState.models]: another model, another effort, or both. */
data class CallModeChange(val modelId: String? = null, val effort: String? = null) {
    /**
     * [current] with this change, as the composer's pickers make it
     * ([ModeCatalog.pick]): another model on the first shown account that
     * offers it, with the effort asked for or the model's own default.
     */
    fun applied(current: Mode, catalog: ModeCatalog): Mode {
        if (modelId != null && modelId != current.modelId) {
            val provider = catalog.providers.firstOrNull { !it.isDisabled && !it.hidden && it.models.any { model -> model.modelId == modelId } } ?: return current
            return catalog.pick(current, provider.id, modelId, effort)
        }
        return if (effort != null) current.copy(effort = effort) else current
    }
}

/** Where going back or home left the screen. */
sealed interface CallScreenMove {
    data class Moved(val atHome: Boolean) : CallScreenMove
    data class Refused(val reason: String) : CallScreenMove
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
    /** Every conversation home lists, in its order, with what each sits under. */
    suspend fun directory(): List<CallTarget>
    /** One conversation, read if it must be (a bounded page); null if the connection has none by that ID. What this phone has, `fresh` or not. */
    suspend fun state(agentId: String): CallTargetState?
    /**
     * One conversation made current, as opening it would make it but off screen: read from the computer and followed
     * live, waiting up to [limitMillis] for that. As it is then, `fresh` or not; null if the connection has none by
     * that ID or it can't be read at all.
     */
    suspend fun refreshed(agentId: String, limitMillis: Long): CallTargetState? = state(agentId)
    /** The conversation on screen, if one is. */
    suspend fun focused(): String?
    /** Opens it on screen; true once it shows. */
    suspend fun open(agentId: String): Boolean
    /**
     * Sends [text] exactly as given, under [id], the way the composer's send does but without touching its draft;
     * with [change], as the composer's pickers would have switched it first.
     */
    suspend fun send(agentId: String, text: String, id: String, change: CallModeChange? = null): CallSendOutcome
    /** Keeps a conversation read (or lets it go) while the call follows it. */
    suspend fun follow(agentId: String, following: Boolean)
    /**
     * New work as compose starts it, off screen, chosen as [kind] and named [name] (blank for its first message to
     * name it): the empty conversation, on this computer, which [send] makes with its first message and home lists
     * from then on. Null if it can't start.
     */
    suspend fun draft(kind: CallTarget.Kind, name: String): CallTarget?
    /** A [draft] nothing was sent to, let go: nothing of it stays. */
    suspend fun discard(agentId: String)
    /** New work under [agentId] that home doesn't list yet: a [draft] on its way, or compose's on screen; null for anything else. */
    suspend fun unlisted(agentId: String): CallTarget?
    /** Back one screen, as the system's back does. */
    suspend fun back(): CallScreenMove
    /** Home, with nothing over it. */
    suspend fun home(): CallScreenMove
}
