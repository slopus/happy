package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Every pipeline's runs together, newest first, as far as they have been paged in. */
@Immutable
data class PipelineRuns(
    /** Until the first page answers, so "no runs" is never said early. */
    val loading: Boolean = true,
    /** False on a server that doesn't list runs across pipelines (`404`). */
    val listed: Boolean = true,
    val entries: List<PipelineRunListEntry> = emptyList(),
    /** Where the next older page starts; null once every run is in. */
    val nextCursor: String? = null,
    val loadingMore: Boolean = false,
    /** The last read failed; what shows is what was read before. */
    val failed: Boolean = false,
)

/** What the Pipelines page shows: the pipelines by name, and every run beneath. */
@Immutable
data class PipelinesList(
    /** Until the first answer, so "no pipelines" is never said early. */
    val loading: Boolean = true,
    /** The last read failed; what shows is what was read before. */
    val failed: Boolean = false,
    val pipelines: List<PipelineSummary> = emptyList(),
    val runs: PipelineRuns = PipelineRuns(),
) {
    /** A run is queued or running: what shows has a clock to keep. */
    val live: Boolean get() = runs.entries.any { it.run.state.active }
}

/**
 * A connection's pipelines and their runs, as the Pipelines page follows
 * them (desktop's `pipelinesStore`): read at once, the pipelines again on
 * `pipeline.updated` and `pipeline.run.updated` (a row's last run), the
 * newest page of runs again on `pipeline.run.updated`, both on every
 * reconnect and on [refresh]. The events are hints and carry nothing.
 * Reads of one kind run one at a time; one asked for during another runs
 * once after it, so a burst of events costs two reads, not one each.
 */
class PipelinesSource(
    private val backend: PipelinesBackend,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(PipelinesList())
    val state: StateFlow<PipelinesList> = mutableState.asStateFlow()

    private val pipelinesAsked = Channel<Unit>(Channel.CONFLATED)
    private val runsAsked = Channel<Unit>(Channel.CONFLATED)

    /** The newest page and older pages never land at once. */
    private val runsLock = Mutex()

    /** The reader paged past the first page: a fresh first page keeps what they read below it. */
    private var pagedPastFirst = false

    init {
        // Subscribed before the first read is sent, so a change between the two is read too.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                when (event.type) {
                    AgentEvent.HELLO, RUN_UPDATED -> refresh()
                    PIPELINE_UPDATED -> pipelinesAsked.trySend(Unit)
                }
            }
        }
        scope.launch { for (ask in pipelinesAsked) readPipelines() }
        scope.launch { for (ask in runsAsked) readRuns() }
        refresh()
    }

    fun refresh() {
        pipelinesAsked.trySend(Unit)
        runsAsked.trySend(Unit)
    }

    /** Reads the next older page of runs, unless one is on its way or every run is in. */
    fun more() {
        val runs = mutableState.value.runs
        if (runs.loadingMore || runs.nextCursor == null) return
        updateRuns { it.copy(loadingMore = true) }
        scope.launch {
            runsLock.withLock {
                val cursor = mutableState.value.runs.nextCursor ?: return@withLock updateRuns { it.copy(loadingMore = false) }
                val page = attempt { backend.runs(cursor) }
                if (page == null) return@withLock updateRuns { it.copy(loadingMore = false, failed = true) }
                pagedPastFirst = true
                updateRuns { current ->
                    val known = current.entries.mapTo(HashSet()) { it.id }
                    current.copy(
                        loadingMore = false,
                        failed = false,
                        entries = current.entries + page.value?.runs.orEmpty().filter { it.id !in known },
                        nextCursor = page.value?.nextCursor,
                    )
                }
            }
        }
    }

    private suspend fun readPipelines() {
        val read = attempt { backend.pipelines() }
        mutableState.update {
            if (read == null) it.copy(loading = false, failed = true) else it.copy(loading = false, failed = false, pipelines = read.value)
        }
    }

    private suspend fun readRuns() = runsLock.withLock {
        // A server without the list said so once; the next page that opens asks again.
        if (!mutableState.value.runs.listed) return@withLock
        val read = attempt { backend.runs(null) } ?: return@withLock updateRuns { it.copy(loading = false, failed = true) }
        val page = read.value ?: return@withLock updateRuns { it.copy(loading = false, listed = false, failed = false, entries = emptyList(), nextCursor = null) }
        updateRuns { current ->
            current.copy(
                loading = false,
                listed = true,
                failed = false,
                // By ID, so a new run in front moves every row down one.
                entries = pipelineRunsMerge(current.entries, page.runs, !pagedPastFirst),
                // Paged past the first page, the cursor already points past what is kept.
                nextCursor = if (pagedPastFirst) current.nextCursor else page.nextCursor,
            )
        }
    }

    private fun updateRuns(change: (PipelineRuns) -> PipelineRuns) = mutableState.update { it.copy(runs = change(it.runs)) }

    /** The cluster's pipeline events (API.md, "Events"): hints to read again, carrying no state. */
    companion object {
        const val PIPELINE_UPDATED = "pipeline.updated"
        const val RUN_UPDATED = "pipeline.run.updated"
        const val NODE_UPDATED = "pipeline.node.updated"
        const val NODE_LOG = "pipeline.node.log"
    }
}

/** What a read answered (null itself, for a `404`); see [attempt]. */
internal class Read<T>(val value: T)

/** [read]'s answer, null when it failed; cancellation goes through. */
internal suspend fun <T> attempt(read: suspend () -> T): Read<T>? = try {
    Read(read())
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
