package com.slopus.happy.monitor

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

/**
 * A System Monitor Surface read while its screen is on (iOS's
 * `SystemMonitorFeed`): one snapshot every `intervalMs` (at least a
 * second), each read given ten seconds, five seconds between tries while the
 * computer can't be reached, as the desktop polls. Paused whenever the
 * screen is hidden or the app is behind, so nothing is asked of the computer
 * for a screen no one sees. The last snapshot is kept on the phone (history
 * trimmed to a minute), written every 30 s while read and on pause, so the
 * screen opens on it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SystemMonitorFeed(
    private val scope: CoroutineScope,
    private val fetch: suspend () -> SystemMonitorSample,
    /** Writes the kept snapshot, off the main thread. */
    private val keep: suspend (JsonObject) -> Unit = {},
    /** Reads the kept snapshot, off the main thread. */
    private val kept: suspend () -> JsonObject? = { null },
    /** Waits between reads; tests shorten it. Null waits the given time or until a [poke]. */
    private val sleep: (suspend (Long) -> Unit)? = null,
) {
    enum class Status {
        /** Waiting for the first snapshot. */
        Loading,
        Ready,
        /** Showing the last snapshot while the computer can't be reached. */
        Reconnecting,
        /** The Surface is gone, or isn't a System Monitor (`404`, `410`). */
        Missing,
        /** The Happy Agent has no System Monitor (`405`, `501`). */
        Unsupported,
    }

    /** [processes] is the per-PID CPU history, carried with each sample. */
    @Immutable
    data class State(
        val sample: SystemMonitorSample? = null,
        val status: Status = Status.Loading,
        /** The last read failed. */
        val failed: Boolean = false,
        val histories: Map<Int, List<Double?>> = emptyMap(),
    )

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()

    private val lock = Mutex()
    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val table = ProcessTable()
    private var polling: Job? = null
    private var restored = false
    private var keptAt = Double.NEGATIVE_INFINITY
    private val pokes = Channel<Unit>(Channel.CONFLATED)

    /** Reads until [pause]; a Surface found missing or unsupported stops it. */
    fun resume() {
        scope.launch(confined) {
            lock.withLock {
                if (polling?.isActive == true) return@withLock
                if (!restored) {
                    restored = true
                    val sample = if (stateFlow.value.sample == null) kept()?.let(::decode) else null
                    if (sample != null) {
                        table.record(sample)
                        stateFlow.value = State(sample, Status.Reconnecting, histories = table.histories)
                    }
                }
                val status = stateFlow.value.status
                if (status == Status.Missing || status == Status.Unsupported) return@withLock
                polling = scope.launch(confined) { poll() }
            }
        }
    }

    /** Stops reading, and writes the last snapshot down. */
    fun pause(): Job = scope.launch(confined) {
        lock.withLock {
            polling?.cancelAndJoin()
            polling = null
            write(force = true)
        }
    }

    /** Reads now rather than at the next tick: the link just came back. */
    fun poke() {
        pokes.trySend(Unit)
    }

    private suspend fun poll() {
        while (true) {
            val wait = try {
                val sample = withTimeout(TIMEOUT) { fetch() }
                currentCoroutineContext().ensureActive()
                table.record(sample)
                stateFlow.value = State(sample, Status.Ready, failed = false, histories = table.histories)
                write(force = false)
                maxOf(1000L, sample.intervalMs.toLong())
            } catch (e: CancellationException) {
                if (e is kotlinx.coroutines.TimeoutCancellationException) failed() else throw e
            } catch (e: AgentApiException) {
                when (e.status) {
                    404, 410 -> { stateFlow.value = stateFlow.value.copy(status = Status.Missing, failed = false); return }
                    405, 501 -> { stateFlow.value = stateFlow.value.copy(status = Status.Unsupported, failed = false); return }
                    else -> failed()
                }
            } catch (_: Exception) {
                failed()
            }
            sleep?.invoke(wait) ?: withTimeoutOrNull(wait) { pokes.receive() }
        }
    }

    private fun failed(): Long {
        val current = stateFlow.value
        stateFlow.value = current.copy(status = if (current.sample == null) Status.Loading else Status.Reconnecting, failed = true)
        return RETRY
    }

    private suspend fun write(force: Boolean) {
        val sample = stateFlow.value.sample ?: return
        val now = sample.sampledAt / 1000
        if (!force && now - keptAt < KEEP_EVERY) return
        keptAt = now
        // The history is the computer's to send again; the screen opens on the readings alone.
        val trimmed = sample.copy(history = sample.history.takeLast(60))
        keep(AgentClient.json.encodeToJsonElement(SystemMonitorSample.serializer(), trimmed) as JsonObject)
    }

    companion object {
        const val TIMEOUT = 10_000L
        const val RETRY = 5_000L
        /** How often the snapshot is written down while it is read (s). */
        const val KEEP_EVERY = 30.0

        fun decode(value: JsonObject): SystemMonitorSample? =
            runCatching { AgentClient.json.decodeFromJsonElement(SystemMonitorSample.serializer(), value) }.getOrNull()

        /** The route a connection reads one System Monitor from. */
        fun path(surfaceId: String) = "/v0/surfaces/system-monitor/${AgentClient.escape(surfaceId)}"
    }
}
