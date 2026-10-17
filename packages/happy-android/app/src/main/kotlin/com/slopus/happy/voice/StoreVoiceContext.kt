package com.slopus.happy.voice

import com.slopus.happy.chat.AgentState
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatNormalizer
import com.slopus.happy.chat.ReducerState
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.StoredSource
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Feeds voice the same normalized reducer results as sync.ts, without depending on an open chat UI. */
class StoreVoiceContext(
    private val store: HappyStore,
    private val account: AccountSync,
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
    private val hooks = VoiceHooks(sessions::get, { history[it].orEmpty() }, { connection?.context(it) }, { connection?.prompt(it) })

    override suspend fun initial(sessionId: String): String {
        val records = withContext(io) { store.sessions().map { it to store.messages(it.id) } }
        for ((record, messages) in records) {
            sessions[record.id] = record
            val reducer = ReducerState().also { reducers[record.id] = it }
            val agent = AgentState.parse(record.agentStateJson)
            reducer.reduce(messages.mapNotNull(ChatNormalizer::normalize), agent)
            history[record.id] = reducer.snapshot()
            requests[record.id] = agent?.requests?.keys.orEmpty().toSet()
        }
        return hooks.start(sessionId, sessions.values.toList())
    }

    override fun connected(connection: VoiceConnection, mode: VoiceMode) {
        this.connection = connection
        hooks.mode(mode)
        jobs += scope.launch(dispatcher) {
            account.messages.stored.collect { batch ->
                val reducer = reducers.getOrPut(batch.sessionId) { ReducerState() }
                val record = withContext(io) { store.session(batch.sessionId) }
                if (record != null) sessions[record.id] = record
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
                        if (id !in previous) hooks.permission(record.id, id, request.tool, request.arguments)
                    }
                }
                // VOICE_CONFIG.DISABLE_SESSION_STATUS is true: presence changes send no context.
            }
        }
    }

    override fun mode(mode: VoiceMode) = hooks.mode(mode)
    override suspend fun focus(sessionId: String) = hooks.focus(sessionId)
    override fun stop() {
        jobs.forEach { it.cancel() }; jobs.clear()
        connection = null
        hooks.stop()
    }
}