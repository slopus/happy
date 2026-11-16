package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.chat.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** One pipeline as its page shows it. */
@Immutable
data class PipelineView(
    /** Until the first answer, so "archived" is never said early. */
    val loading: Boolean = true,
    /** Archived, or gone (`404`): its runs still read. */
    val missing: Boolean = false,
    /** The last read failed; what shows is what was read before. */
    val failed: Boolean = false,
    /** What the page that opened it called it, until the server says. */
    val name: String? = null,
    val pipeline: PipelineDetail? = null,
    /** Newest first; empty until read. */
    val versions: List<PipelineVersion> = emptyList(),
    /** The names of the pipelines its head's `pipeline` nodes run, by ID, as far as read. */
    val pipelineNames: Map<String, String> = emptyMap(),
    val runs: PipelineRuns = PipelineRuns(),
) {
    /** A run is queued or running: its clock ticks. */
    val live: Boolean get() = runs.entries.any { it.run.state.active }
}

/**
 * One pipeline, live (desktop's `pipelineStore`): the pipeline with its head
 * version and its history read at once and again on `pipeline.updated`, the
 * newest page of its runs on `pipeline.run.updated`, both on every reconnect
 * and on [refresh]. An event naming another pipeline is left alone; one
 * naming none is read as about this one. Reads of one kind run one at a
 * time; one asked for during another runs once after it.
 */
class PipelineSource(
    private val backend: PipelinesBackend,
    private val pipelineId: String,
    name: String?,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(PipelineView(name = name))
    val state: StateFlow<PipelineView> = mutableState.asStateFlow()

    private val pipelineAsked = Channel<Unit>(Channel.CONFLATED)
    private val runsAsked = Channel<Unit>(Channel.CONFLATED)

    private val names = PipelineNames(backend)

    private val runs = RunPages(scope, ::runPage, { mutableState.value.runs }) { change -> mutableState.update { it.copy(runs = change(it.runs)) } }

    init {
        // Subscribed before the first read is sent, so a change between the two is read too.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                val about = event.data["pipelineId"].str
                if (about != null && about != pipelineId) return@collect
                when (event.type) {
                    AgentEvent.HELLO -> refresh()
                    PipelinesSource.PIPELINE_UPDATED -> pipelineAsked.trySend(Unit)
                    PipelinesSource.RUN_UPDATED -> runsAsked.trySend(Unit)
                }
            }
        }
        scope.launch { for (ask in pipelineAsked) readPipeline() }
        scope.launch { for (ask in runsAsked) runs.newest() }
        refresh()
    }

    fun refresh() {
        pipelineAsked.trySend(Unit)
        runsAsked.trySend(Unit)
    }

    /** Reads the next older page of runs, unless one is on its way or every run is in. */
    fun more() = runs.more()

    /** A pipeline the server doesn't have lists no runs, rather than saying runs aren't listed. */
    private suspend fun runPage(cursor: String?): PipelineRunPage<PipelineRunListEntry> {
        val page = backend.pipelineRuns(pipelineId, cursor) ?: return PipelineRunPage(emptyList(), null)
        // The rows draw the pipeline's name as it is when they draw; this is only what they carry.
        val name = mutableState.value.let { it.pipeline?.name ?: it.name ?: pipelineId }
        return PipelineRunPage(page.runs.map { PipelineRunListEntry(it, pipelineId, name, pipelineArchived = false) }, page.nextCursor)
    }

    private suspend fun readPipeline() {
        val read = attempt { backend.pipeline(pipelineId) } ?: return mutableState.update { it.copy(loading = false, failed = true) }
        val pipeline = read.value ?: return mutableState.update { it.copy(loading = false, missing = true, failed = false, pipeline = null, versions = emptyList()) }
        mutableState.update { it.copy(loading = false, missing = false, failed = false, pipeline = pipeline, name = pipeline.name) }
        val versions = attempt { backend.versions(pipelineId) }
        mutableState.update { if (versions == null) it.copy(failed = true) else it.copy(versions = versions.value.orEmpty()) }
        val children = names.of(pipeline.head.definition)
        if (children != mutableState.value.pipelineNames) mutableState.update { it.copy(pipelineNames = children) }
    }
}

/** One version as its page shows it, or one of its nodes. */
@Immutable
data class PipelineVersionView(
    val loading: Boolean = true,
    /** The server has no such version, or no longer the pipeline (`404`). */
    val missing: Boolean = false,
    val failed: Boolean = false,
    val version: PipelineVersionDetail? = null,
    /** The names of the pipelines its `pipeline` nodes run, by ID, as far as read. */
    val pipelineNames: Map<String, String> = emptyMap(),
)

/** One version of a pipeline: read once, since versions never change, and again on [refresh] after a failed read. */
class PipelineVersionSource(
    private val backend: PipelinesBackend,
    private val pipelineId: String,
    private val number: Int,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(PipelineVersionView())
    val state: StateFlow<PipelineVersionView> = mutableState.asStateFlow()

    private val asked = Channel<Unit>(Channel.CONFLATED)
    private val names = PipelineNames(backend)

    init {
        scope.launch { for (ask in asked) read() }
        refresh()
    }

    fun refresh() {
        if (mutableState.value.version == null) asked.trySend(Unit)
    }

    private suspend fun read() {
        val read = attempt { backend.version(pipelineId, number) } ?: return mutableState.update { it.copy(loading = false, failed = true) }
        val version = read.value ?: return mutableState.update { it.copy(loading = false, missing = true, failed = false) }
        mutableState.update { it.copy(loading = false, missing = false, failed = false, version = version) }
        mutableState.update { it.copy(pipelineNames = names.of(version.definition)) }
    }
}

/** The names of the pipelines a definition's `pipeline` nodes run, each asked for once; one archived or gone keeps its ID. */
private class PipelineNames(private val backend: PipelinesBackend) {
    private val names = HashMap<String, String?>()

    suspend fun of(definition: PipelineDefinition?): Map<String, String> =
        definition?.nodes.orEmpty().mapNotNull { it.pipelineId }.distinct().mapNotNull { id -> name(id)?.let { id to it } }.toMap()

    private suspend fun name(pipelineId: String): String? {
        if (pipelineId in names) return names[pipelineId]
        val read = attempt { backend.pipelineName(pipelineId) } ?: return null
        names[pipelineId] = read.value
        return read.value
    }
}
