package com.slopus.happy.voice

import com.slopus.happy.chat.AgentState
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatNormalizer
import com.slopus.happy.chat.ReducerState
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.sync.StoredSource
import com.slopus.happy.sync.StoredMessages
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Feeds voice the same normalized reducer results as sync.ts, without depending on an open chat UI. */
class StoreVoiceContext(
    private val store: HappyStore,
    private val stored: SharedFlow<StoredMessages>,
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val onSessionDeleted: (String) -> Unit,
) : VoiceSessionContext {
    private val sessions = mutableMapOf<String, SessionRecord>()
    private val reducers = mutableMapOf<String, ReducerState>()
    private val history = mutableMapOf<String, List<ChatMessage>>()
    private val requests = mutableMapOf<String, Set<String>>()
    private val jobs = mutableListOf<Job>()
    private var connection: VoiceConnection? = null
    private val incoming = Channel<StoredMessages>(Channel.UNLIMITED)
    private val hooks = VoiceHooks(sessions::get, { history[it].orEmpty() }, { connection?.context(it) }, { connection?.prompt(it) })

    override suspend fun initial(sessionId: String): String {
        // Subscribe before reading history. Events arriving during token/SDK setup are reduced once connected.
        jobs += scope.launch(dispatcher, start = CoroutineStart.UNDISPATCHED) {
            stored.collect { incoming.send(it) }
        }
        val records = withContext(io) { store.sessions() }
        for (record in records) {
            sessions[record.id] = record
            val agent = AgentState.parse(record.agentStateJson)
            requests[record.id] = agent?.requests?.keys.orEmpty().toSet()
        }
        hydrate(sessionId)
        return hooks.start(sessionId, sessions.values.toList())
    }

    /** Only visited sessions need reducers; the voice history cap is 50, independent of offline account size. */
    private suspend fun hydrate(id: String, excluding: Set<String> = emptySet()) {
        if (id in reducers) return
        val messages = withContext(io) { store.messages(id, 50).filter { it.id !in excluding } }
        // A focus and a live batch may have suspended on the same read; preserve whichever hydrated first.
        if (id in reducers) return
        val reducer = ReducerState()
        reducer.reduce(messages.mapNotNull(ChatNormalizer::normalize), AgentState.parse(sessions[id]?.agentStateJson))
        reducers[id] = reducer
        history[id] = reducer.snapshot()
    }

    override fun connected(connection: VoiceConnection, mode: VoiceMode) {
        this.connection = connection
        hooks.mode(mode)
        jobs += scope.launch(dispatcher) {
            for (batch in incoming) {
                val record = withContext(io) { store.session(batch.sessionId) }
                if (record != null) sessions[record.id] = record
                hydrate(batch.sessionId, batch.messages.mapTo(mutableSetOf()) { it.id })
                val reducer = reducers.getValue(batch.sessionId)
                val result = reducer.reduce(batch.messages.mapNotNull(ChatNormalizer::normalize), AgentState.parse(record?.agentStateJson))
                history[batch.sessionId] = reducer.snapshot()
                if (batch.source != StoredSource.PRELOAD) {
                    hooks.messages(batch.sessionId, result.messages.filter { it.id !in result.settledMessageIds })
                    if (result.hasReadyEvent) hooks.ready(batch.sessionId)
                }
            }
        }
        jobs += scope.launch(dispatcher) {
            store.versions.map { it.sessions }.distinctUntilChanged().collect {
                val records = withContext(io) { store.sessions() }
                val ids = records.mapTo(mutableSetOf()) { it.id }
                (sessions.keys - ids).forEach(onSessionDeleted)
                sessions.keys.retainAll(ids)
                for (record in records) {
                    sessions[record.id] = record
                    val agent = AgentState.parse(record.agentStateJson)
                    val previous = requests[record.id].orEmpty()
                    requests[record.id] = agent?.requests?.keys.orEmpty().toSet()
                    for ((id, request) in agent?.requests.orEmpty()) {
                        if (id !in previous) {
                            hydrate(record.id)
                            hooks.permission(record.id, id, request.tool, request.arguments)
                        }
                    }
                }
                // VOICE_CONFIG.DISABLE_SESSION_STATUS is true: presence changes send no context.
            }
        }
    }

    override fun mode(mode: VoiceMode) = hooks.mode(mode)
    override suspend fun focus(sessionId: String) {
        hydrate(sessionId)
        hooks.focus(sessionId)
    }
    override fun stop() {
        jobs.forEach { it.cancel() }; jobs.clear()
        incoming.close()
        connection = null
        hooks.stop()
    }
}