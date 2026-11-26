package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.chat.str
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

/** The reader's abort, from the press until the server's record of the run shows what came of it. */
@Immutable
sealed interface PipelineAbort {
    data object Idle : PipelineAbort

    /** Asked; the run reads aborted only once the server's record says so. */
    data object Sending : PipelineAbort

    /** Refused or unsent; [message] is the server's, where it gave one. */
    data class Failed(val message: String?) : PipelineAbort
}

/** One run as its page shows it. */
@Immutable
data class PipelineRunView(
    /** Until the first answer, so "not found" is never said early. */
    val loading: Boolean = true,
    /** The server has no such run (`404`). */
    val missing: Boolean = false,
    /** The last read failed; what shows is what was read before. */
    val failed: Boolean = false,
    val run: PipelineRun? = null,
    /** Its pipeline's name; the ID until known. */
    val pipelineName: String? = null,
    /** The graph of the version the run pinned, once read. */
    val definition: PipelineDefinition? = null,
    /** That graph couldn't be read: the nodes show in the order they started. */
    val definitionFailed: Boolean = false,
    /** Its parent and child runs by ID, as far as they have been read. */
    val relatives: Map<String, PipelineRunRelative> = emptyMap(),
    /** The names of the pipelines its `pipeline` nodes run, by ID, as far as read. */
    val pipelineNames: Map<String, String> = emptyMap(),
    val abort: PipelineAbort = PipelineAbort.Idle,
) {
    /** Something on the page is queued or running: its clocks tick. */
    val live: Boolean get() = run?.state?.active == true || relatives.values.any { it.state.active }
}

/**
 * One run, live (desktop's `pipelineRunStore`): read at once, again on every
 * `pipeline.run.updated` and `pipeline.node.updated` for it or a run beside
 * it, on each reconnect and on [refresh]. The graph of the version it pinned
 * is read once; its parent and children are read beside it until they end.
 * Reads run one at a time; one asked for during another runs once after it.
 */
class PipelineRunSource(
    private val backend: PipelinesBackend,
    private val runId: String,
    /** The name the page that opened it showed, until the server names the pipeline. */
    pipelineName: String?,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(PipelineRunView(pipelineName = pipelineName))
    val state: StateFlow<PipelineRunView> = mutableState.asStateFlow()

    private val asked = Channel<Unit>(Channel.CONFLATED)

    /** Pipelines' names by ID, each asked for once; null for one archived or gone. */
    private val names = HashMap<String, String?>()

    /** The version's graph answered, readable or not: it is never asked for again. */
    private var definitionAnswered = false

    init {
        // Subscribed before the first read is sent, so a change between the two is read too.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                when (event.type) {
                    AgentEvent.HELLO -> refresh()
                    PipelinesSource.RUN_UPDATED, PipelinesSource.NODE_UPDATED -> if (concerns(event.data["runId"].str)) refresh()
                }
            }
        }
        scope.launch { for (ask in asked) read() }
        refresh()
    }

    fun refresh() {
        asked.trySend(Unit)
    }

    /**
     * Asks the server to abort the run, while it is queued or running, then
     * reads it again: it shows aborted only once the server's record says so.
     */
    fun abort() {
        val current = mutableState.value
        if (current.run?.state?.active != true || current.abort == PipelineAbort.Sending) return
        mutableState.update { it.copy(abort = PipelineAbort.Sending) }
        scope.launch {
            val refused = try {
                backend.abort(runId)
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                e
            }
            when (refused) {
                null -> refresh()
                // Turned off for the account: the page is leaving, with nothing to say.
                is PipelinesTurnedOff -> mutableState.update { it.copy(abort = PipelineAbort.Idle) }
                else -> mutableState.update { it.copy(abort = PipelineAbort.Failed((refused as? AgentApiException)?.message)) }
            }
        }
    }

    /** An event without a run is read as about this one. */
    private fun concerns(eventRunId: String?): Boolean {
        if (eventRunId == null || eventRunId == runId) return true
        val run = mutableState.value.run ?: return false
        return eventRunId == run.entry.parentRunId || eventRunId in run.childIds
    }

    private suspend fun read() {
        val read = attempt { backend.run(runId) } ?: return mutableState.update { it.copy(loading = false, failed = true) }
        val run = read.value ?: return mutableState.update { it.copy(loading = false, missing = true, failed = false, run = null) }
        mutableState.update {
            it.copy(
                loading = false,
                missing = false,
                failed = false,
                run = run,
                // The abort asked for has been answered and this read came after it.
                abort = if (it.abort == PipelineAbort.Sending) PipelineAbort.Idle else it.abort,
            )
        }
        if (!definitionAnswered) {
            val definition = attempt { backend.definition(run.pipelineId, run.entry.version) }
            if (definition != null) definitionAnswered = true
            mutableState.update { it.copy(definition = definition?.value, definitionFailed = definition?.value == null) }
        }
        name(run.pipelineId)?.let { name -> mutableState.update { it.copy(pipelineName = name) } }
        val children = mutableState.value.definition?.nodes.orEmpty().mapNotNull { it.pipelineId }.distinct()
        val childNames = children.mapNotNull { id -> name(id)?.let { id to it } }.toMap()
        if (childNames != mutableState.value.pipelineNames) mutableState.update { it.copy(pipelineNames = childNames) }
        readRelatives(run)
    }

    private suspend fun name(pipelineId: String): String? {
        if (pipelineId in names) return names[pipelineId]
        val read = attempt { backend.pipelineName(pipelineId) } ?: return null
        names[pipelineId] = read.value
        return read.value
    }

    private suspend fun readRelatives(run: PipelineRun) {
        val ids = (listOfNotNull(run.entry.parentRunId) + run.childIds).distinct()
        val known = mutableState.value.relatives
        val relatives = LinkedHashMap<String, PipelineRunRelative>()
        for (id in ids) {
            val kept = known[id]
            // An ended run never changes again; one that can't be read now keeps what showed.
            val relative = if (kept != null && !kept.state.active) kept else attempt { backend.run(id) }?.value?.let { read ->
                PipelineRunRelative(read.id, read.pipelineId, name(read.pipelineId) ?: read.pipelineId, read.entry.version, read.state, read.entry.startedAt, read.entry.endedAt)
            } ?: kept
            relative?.let { relatives[id] = it }
        }
        if (relatives != known) mutableState.update { it.copy(relatives = relatives) }
    }
}

/** One node's log as its page shows it. */
@Immutable
data class PipelineNodeLog(
    /** Until the first answer. */
    val loading: Boolean = true,
    /** Every entry read so far, in `seq` order. */
    val entries: List<PipelineLogEntry> = emptyList(),
    /** How many of the oldest entries the server let go before they were read. */
    val dropped: Int = 0,
    /** The commands first read while running: the reader watched them, so they stay open once they end. */
    val watched: Set<Long> = emptySet(),
    /** The last read failed; what shows is what was read before. */
    val failed: Boolean = false,
)

/**
 * One node's log in one run, live (desktop's `pipelineNodeLogStore`): read at
 * once, then only what came after on each `pipeline.node.log` for it and each
 * reconnect, up to ten pages of 500 a read before letting other reads by.
 * A node that hasn't started has no log yet (`404`).
 */
class PipelineNodeLogSource(
    private val backend: PipelinesBackend,
    private val runId: String,
    private val nodeId: String,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(PipelineNodeLog())
    val state: StateFlow<PipelineNodeLog> = mutableState.asStateFlow()

    private val asked = Channel<Unit>(Channel.CONFLATED)
    private var after = 0L

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                when (event.type) {
                    AgentEvent.HELLO -> refresh()
                    PipelinesSource.NODE_LOG -> {
                        val run = event.data["runId"].str
                        val node = event.data["nodeId"].str
                        if ((run == null || run == runId) && (node == null || node == nodeId)) refresh()
                    }
                }
            }
        }
        scope.launch { for (ask in asked) read() }
        refresh()
    }

    fun refresh() {
        asked.trySend(Unit)
    }

    private suspend fun read() {
        repeat(PAGES_PER_READ) {
            val read = attempt { backend.log(runId, nodeId, after) } ?: return mutableState.update { it.copy(loading = false, failed = true) }
            val page = read.value ?: return mutableState.update { it.copy(loading = false, failed = false) }
            after = page.nextAfter
            mutableState.update { current ->
                val (entries, watched) = pipelineLogMerge(current.entries, current.watched, page)
                current.copy(loading = false, failed = false, entries = entries, watched = watched, dropped = page.dropped)
            }
            if (page.entries.size < ClusterPipelines.LOG_LIMIT) return
        }
        // A long backlog: the rest is read after other reads get a turn.
        refresh()
    }

    private companion object {
        const val PAGES_PER_READ = 10
    }
}
