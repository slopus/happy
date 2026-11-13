package com.slopus.happy.plugins

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/** What a plugins screen shows. */
@Immutable
sealed interface PluginsState {
    /** Before the first answer, so "nothing installed" is never said early. */
    data object Loading : PluginsState
    data class Loaded(val snapshot: PluginsSnapshot) : PluginsState
    /** The connection has no plugins (`404`/`501`). */
    data object Unsupported : PluginsState
    /** The first read failed; a later one that works replaces it. */
    data object Failed : PluginsState
}

/**
 * One connection's plugins as its screens follow them: read at once, again
 * on every event that may change them ([PluginsBackend.changes]) and on
 * [refresh] (back from a sign-in in the browser), and after every write
 * whether it worked or not. Reads run one at a time; one asked for during
 * another runs once after it.
 */
class PluginsSource(
    private val backend: PluginsBackend,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow<PluginsState>(PluginsState.Loading)
    val state: StateFlow<PluginsState> = mutableState.asStateFlow()

    /** At most one read waits while another runs. */
    private val asked = Channel<Unit>(Channel.CONFLATED)

    init {
        // Subscribed before the first read is sent, so a change between the two is read too.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { if (backend.changes(it)) refresh() }
        }
        scope.launch { for (ask in asked) load() }
        refresh()
    }

    fun refresh() {
        asked.trySend(Unit)
    }

    private suspend fun load() {
        mutableState.value = try {
            backend.read()?.let(PluginsState::Loaded) ?: PluginsState.Unsupported
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            mutableState.value.takeIf { it is PluginsState.Loaded } ?: PluginsState.Failed
        }
    }

    /** [action] against the backend, then the list read again; its refusal is thrown to the caller as it came. */
    suspend fun <T> write(action: suspend PluginsBackend.() -> T): T = try {
        backend.action()
    } finally {
        refresh()
    }

    suspend fun connections(installationId: String): List<PluginConnection> = backend.connections(installationId)
}
