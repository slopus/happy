package com.slopus.happy.projects

import com.slopus.happy.AppGraph
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.GitStatusCommands
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.parseGitStatus
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.InvalidateSync
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.WeakHashMap

/** Where a session's checkout is: its `machineId:path` key and the directory the commands run in. */
data class GitCheckout(val key: String, val path: String)

/**
 * gitStatusSync.ts: one refresh per checkout, shared by every session in
 * it, running the daemon's git through the session's shell. [refresh] is
 * sync.ts refreshSessionData (a message arrived, the chat was opened);
 * [invalidate] coalesces bursts 300 ms apart and only reaches checkouts a
 * refresh has already registered. A directory that is not a repository
 * has no status; a failed status keeps the last one.
 */
class GitStatusSync(
    private val scope: CoroutineScope,
    private val checkout: (sessionId: String) -> GitCheckout?,
    private val bash: suspend (sessionId: String, command: String, cwd: String, timeoutMs: Long) -> BashResult,
    private val now: () -> Long = System::currentTimeMillis,
    private val debounceMs: Long = 300,
) {
    private val lock = Any()
    private val syncs = HashMap<String, InvalidateSync>()
    private val sessionKeys = HashMap<String, String>()
    private val timers = HashMap<String, Job>()
    private val state = MutableStateFlow<Map<String, GitStatus>>(emptyMap())

    /** Every checkout's status by `machineId:path`. */
    val statuses: StateFlow<Map<String, GitStatus>> = state.asStateFlow()

    /** getSync(sessionId).invalidate(): registers the session's checkout and asks it now. */
    fun refresh(sessionId: String) {
        val found = checkout(sessionId) ?: return
        val sync = synchronized(lock) {
            sessionKeys[sessionId] = found.key
            syncs.getOrPut(found.key) { InvalidateSync(scope) { fetch(sessionId, found.key) } }
        }
        sync.invalidate()
    }

    /** Files may have changed: ask the session's checkout again once the burst settles. */
    fun invalidate(sessionId: String) {
        synchronized(lock) {
            val key = sessionKeys[sessionId] ?: return
            timers.remove(key)?.cancel()
            timers[key] = scope.launch {
                delay(debounceMs)
                synchronized(lock) {
                    timers.remove(key)
                    syncs[key]
                }?.invalidate()
            }
        }
    }

    /** clearForSession: the session is gone; its checkout's status goes with the last session in it. */
    fun clearForSession(sessionId: String) {
        val key = synchronized(lock) {
            val key = sessionKeys.remove(sessionId) ?: return
            if (key in sessionKeys.values) return
            timers.remove(key)?.cancel()
            syncs.remove(key)?.cancel()
            key
        }
        state.update { it - key }
    }

    private suspend fun fetch(registeredBy: String, key: String) {
        // The session that registered the checkout, or another still in it.
        val sessionId = synchronized(lock) {
            if (sessionKeys[registeredBy] == key) registeredBy else sessionKeys.entries.firstOrNull { it.value == key }?.key
        } ?: return
        val path = checkout(sessionId)?.takeIf { it.key == key }?.path ?: return
        try {
            val repo = bash(sessionId, GitStatusCommands.IS_REPO, path, GitStatusCommands.IS_REPO_TIMEOUT_MS)
            if (!repo.success || repo.exitCode != 0) {
                state.update { it - key }
                return
            }
            val status = bash(sessionId, GitStatusCommands.STATUS, path, GitStatusCommands.TIMEOUT_MS)
            if (!status.success) return
            val unstaged = bash(sessionId, GitStatusCommands.UNSTAGED_NUMSTAT, path, GitStatusCommands.TIMEOUT_MS)
            val staged = bash(sessionId, GitStatusCommands.STAGED_NUMSTAT, path, GitStatusCommands.TIMEOUT_MS)
            val parsed = parseGitStatus(
                status.stdout,
                if (unstaged.success) unstaged.stdout else "",
                if (staged.success) staged.stdout else "",
                now(),
            )
            state.update { it + (key to parsed) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Skipped, like gitStatusSync.ts: the next refresh tries again.
        }
    }
}

/**
 * The signed-in account's [GitStatusSync]: a message arriving or control
 * moving refreshes the session's checkout, an agent state update
 * invalidates it, and a session leaving the store clears it.
 */
class GitStatusServices private constructor(graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val current = MutableStateFlow<GitStatusSync?>(null)

    @OptIn(ExperimentalCoroutinesApi::class)
    val statuses: StateFlow<Map<String, GitStatus>> = graph.account
        .flatMapLatest { account -> if (account == null) flowOf(emptyMap()) else follow(graph, account) }
        .stateIn(scope, SharingStarted.Eagerly, emptyMap())

    /** sync.ts onSessionVisible: the chat is on screen, so its checkout is asked now. */
    fun sessionVisible(sessionId: String) {
        val sync = current.value ?: return
        scope.launch { sync.refresh(sessionId) }
    }

    private fun follow(graph: AppGraph, account: AccountSync): Flow<Map<String, GitStatus>> = channelFlow {
        val store = graph.store
        val sync = GitStatusSync(
            this,
            checkout = { id ->
                val metadata = store.session(id)?.metadataJson?.let(SessionMetadata::parse)
                gitStatusKey(metadata?.machineId, metadata?.path)?.let { GitCheckout(it, metadata!!.path) }
            },
            bash = { id, command, cwd, timeout -> account.sessionOps.bash(id, command, cwd, timeout) },
        )
        current.value = sync
        launch { sync.statuses.collect { send(it) } }
        launch { account.live.sessionDataUpdates.collect(sync::refresh) }
        launch { account.live.agentStateUpdates.collect(sync::invalidate) }
        // sync.ts refreshSessionData for the open chat on resume and on reconnect.
        launch { account.viewingRefreshed.collect { ids -> ids.forEach(sync::refresh) } }
        launch {
            var known = emptySet<String>()
            store.versions.map { it.sessions }.distinctUntilChanged().collect {
                val ids = store.sessions().mapTo(HashSet()) { it.id }
                (known - ids).forEach(sync::clearForSession)
                known = ids
            }
        }
        awaitClose { current.compareAndSet(sync, null) }
    }

    companion object {
        private val instances = WeakHashMap<AppGraph, GitStatusServices>()

        fun of(graph: AppGraph): GitStatusServices = synchronized(instances) { instances.getOrPut(graph) { GitStatusServices(graph) } }
    }
}
