package com.slopus.happy.conversation

import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The `/btw` side threads of one agent connection, one per chat
 * (sideQuestionThreads.ts), kept by its [com.slopus.happy.agent.AgentSession]
 * and not by the chat's screen: leaving the chat, for the list or another
 * chat, keeps its thread and the question it waits on, whose answer lands
 * in the thread whether or not anyone is looking. Only [close] ends one.
 *
 * A thread answers one question at a time. One asked meanwhile waits its
 * turn ([SideAnswer.Queued]) and is then asked with the answers before it
 * as history, as a follow-up is. A question is asked with one request and
 * collected with as many more as it needs, each answered within about 20 s
 * (API.md "Side questions"); the first is never sent twice, since a second
 * would be a second question, and a later one is asked again after a
 * transient failure. Closing drops the question on the computer too, the
 * moment it is known, even while its first request is still on its way.
 *
 * In memory only: a process that dies has no question to rejoin, and one
 * left on the computer expires there.
 */
class SideThreads(
    private val scope: CoroutineScope,
    private val api: ConversationApi,
    /** The link to the computer is up: a question asked without it says so at once instead of waiting out its request. */
    private val online: () -> Boolean = { true },
    private val retryDelayMillis: Long = 600,
) {
    /** The question a thread waits on: its exchange, its id once the computer named it, and whether its thread was closed meanwhile. */
    private class Asking(val index: Int) {
        var id: String? = null
        var closed = false
        var job: Job? = null
    }

    private val lock = Any()
    private val state = MutableStateFlow<Map<String, SideThread>>(emptyMap())
    private val asking = HashMap<String, Asking>()

    /** Every open thread, by its chat's agent. */
    val threads: StateFlow<Map<String, SideThread>> = state.asStateFlow()

    /** [agentId]'s thread while it is open; null once closed, or before its first question. */
    fun thread(agentId: String): Flow<SideThread?> = state.map { it[agentId] }.distinctUntilChanged()

    /** `/btw [question]` in [agentId]'s chat: its thread shows, opened if it isn't, and [question] is asked in turn. */
    fun ask(agentId: String, question: String) {
        val text = question.trim()
        if (text.isEmpty()) return
        synchronized(lock) {
            change(agentId, create = true) { it.copy(exchanges = it.exchanges + SideExchange(text, SideAnswer.Queued)) }
            next(agentId)
        }
    }

    /** Asks the follow-up typed in [agentId]'s panel, and clears the field for the next one. */
    fun askDraft(agentId: String) {
        synchronized(lock) {
            val text = state.value[agentId]?.draft?.trim()?.takeIf { it.isNotEmpty() } ?: return
            change(agentId) { it.copy(exchanges = it.exchanges + SideExchange(text, SideAnswer.Queued), draft = "") }
            next(agentId)
        }
    }

    /** The follow-up being typed in [agentId]'s panel. */
    fun setDraft(agentId: String, draft: String) {
        synchronized(lock) { change(agentId) { if (it.draft == draft) it else it.copy(draft = draft) } }
    }

    /** Ends [agentId]'s thread: the question being answered is dropped, on the computer too (`DELETE`), and the rest forgotten. */
    fun close(agentId: String) {
        val (dropped, id) = synchronized(lock) {
            state.update { it - agentId }
            val dropped = asking.remove(agentId) ?: return
            dropped.closed = true
            dropped to dropped.id
        }
        dropped.job?.cancel()
        id?.let { forget(agentId, it) }
    }

    /** Under [lock]: [agentId]'s thread as [edit] leaves it; one not open is opened only when [create]. */
    private fun change(agentId: String, create: Boolean = false, edit: (SideThread) -> SideThread) {
        state.update { all ->
            val thread = all[agentId] ?: if (create) SideThread() else return@update all
            val next = edit(thread)
            if (next === thread && agentId in all) all else all + (agentId to next)
        }
    }

    /** Under [lock]: [agentId]'s exchange [index] answered so. */
    private fun settle(agentId: String, index: Int, answer: SideAnswer) = change(agentId) { thread ->
        thread.copy(exchanges = thread.exchanges.mapIndexed { i, exchange -> if (i == index) exchange.copy(answer = answer) else exchange })
    }

    /** Under [lock]: asks [agentId]'s oldest waiting question, unless its thread already waits on one. */
    private fun next(agentId: String) {
        if (agentId in asking) return
        val thread = state.value[agentId] ?: return
        val index = thread.exchanges.indexOfFirst { it.answer == SideAnswer.Queued }
        if (index < 0) return
        if (!online()) {
            settle(agentId, index, SideAnswer.Notice(Problem.Link(AgentConnectionException.Reason.Unavailable)))
            return next(agentId)
        }
        val question = thread.exchanges[index].question
        val history = history(thread.exchanges.subList(0, index))
        val ask = Asking(index)
        asking[agentId] = ask
        settle(agentId, index, SideAnswer.Asking)
        ask.job = scope.launch {
            val answer = answer(agentId, question, history, ask)
            synchronized(lock) {
                // Closed meanwhile: the thread it belonged to is gone, and a new one is not its.
                if (asking[agentId] !== ask) return@launch
                asking.remove(agentId)
                settle(agentId, index, answer)
                next(agentId)
            }
        }
    }

    private suspend fun answer(agentId: String, question: String, history: List<SideTurn>, ask: Asking): SideAnswer {
        // Not this job's child: closed while it is on its way, it still answers, and the question it made is dropped then.
        val posted = scope.async { api.askSideQuestion(agentId, question, history) }
        var reply = try {
            posted.await()
        } catch (e: CancellationException) {
            // The request's own failure, not this thread closing: it says why like any other.
            if (currentCoroutineContext().isActive) return refusal(e, asking = true)
            scope.launch { (runCatching { posted.await() }.getOrNull() as? SideReply.Answering)?.let { forget(agentId, it.id) } }
            throw e
        } catch (e: Exception) {
            return refusal(e, asking = true)
        }
        while (true) {
            when (val now = reply) {
                is SideReply.Answered -> {
                    // Words that are only blank are no answer either.
                    val response = now.response?.takeIf { it.isNotBlank() }
                    return SideAnswer.Answered(response, now.synthetic, response?.takeIf { !now.synthetic }?.let { parseMarkdown(it) }.orEmpty())
                }
                is SideReply.Failed -> return SideAnswer.Failed(now.error.takeIf { it.isNotBlank() }?.let(Problem::Said) ?: Problem.Unknown)
                is SideReply.Answering -> {
                    // Whichever of this and close comes second drops it on the computer.
                    if (synchronized(lock) { ask.id = now.id; ask.closed }) {
                        forget(agentId, now.id)
                        throw CancellationException("Side thread closed")
                    }
                    reply = try {
                        collect(agentId, now.id)
                    } catch (e: CancellationException) {
                        if (currentCoroutineContext().isActive) return refusal(e, asking = false)
                        throw e
                    } catch (e: Exception) {
                        return refusal(e, asking = false)
                    }
                }
            }
        }
    }

    /** `GET …/side-questions/:id`, asked again after a transient failure: it changes nothing, and an answer it lost is a `404` then. */
    private suspend fun collect(agentId: String, id: String): SideReply {
        var attempt = 0
        while (true) {
            try {
                return api.sideQuestion(agentId, id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!Conversation.transient(e) || ++attempt >= COLLECT_ATTEMPTS) throw e
                delay(retryDelayMillis * attempt)
            }
        }
    }

    /** `DELETE`, sent and not waited on: a question nobody collects expires on the computer anyway. */
    private fun forget(agentId: String, id: String) {
        scope.launch {
            try {
                api.cancelSideQuestion(agentId, id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        /** Requests a question is collected with before a run of transient failures is given up on. */
        const val COLLECT_ATTEMPTS = 3

        /** Earlier exchanges sent with a question at most (API.md: 50), the newest kept. */
        const val HISTORY_LIMIT = 50

        /** The longest question or answer the computer takes in a history (API.md: 100,000 characters). */
        const val TEXT_LIMIT = 100_000

        /**
         * What a question is asked with: the exchanges before it that Claude
         * answered itself. A canned reply or none is no context, so it isn't
         * sent back (sideQuestionThreads.ts).
         */
        fun history(earlier: List<SideExchange>): List<SideTurn> = earlier.mapNotNull { exchange ->
            val answer = exchange.answer as? SideAnswer.Answered ?: return@mapNotNull null
            val response = answer.response?.takeIf { !answer.synthetic } ?: return@mapNotNull null
            SideTurn(exchange.question, response).takeIf { it.question.length <= TEXT_LIMIT && it.response.length <= TEXT_LIMIT }
        }.takeLast(HISTORY_LIMIT)

        /**
         * Why no answer came. What the person can act on is a notice in plain
         * words: no link to the computer, nothing to answer from yet (`409
         * harness_not_running`), a model that answers none (`501`), a question
         * no longer there (`404` while collecting). The rest is a failure.
         */
        internal fun refusal(e: Exception, asking: Boolean): SideAnswer = when {
            e is AgentConnectionException && e.reason == AgentConnectionException.Reason.Unavailable -> SideAnswer.Notice(Problem.Link(e.reason))
            e is ConversationApiException && asking && e.code == "harness_not_running" -> SideAnswer.Notice(Problem.SideQuestionUnready)
            e is ConversationApiException && asking && (e.code == "unsupported" || e.status == 501) -> SideAnswer.Notice(Problem.SideQuestionUnsupported)
            e is ConversationApiException && !asking && e.status == 404 -> SideAnswer.Notice(Problem.SideQuestionGone)
            else -> SideAnswer.Failed(Conversation.describe(e))
        }
    }
}
