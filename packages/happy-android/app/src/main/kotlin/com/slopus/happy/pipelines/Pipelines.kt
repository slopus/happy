package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable

/** Where a run stands (happy-cluster API.md, "Runs"). */
enum class PipelineRunState(val wire: String) {
    Queued("queued"),
    Running("running"),
    Succeeded("succeeded"),
    Failed("failed"),
    Aborted("aborted"),
    Superseded("superseded"),
    ;

    /** Queued or running: it may still change, and may still be aborted. */
    val active: Boolean get() = this == Queued || this == Running

    companion object {
        fun of(wire: String?): PipelineRunState? = entries.firstOrNull { it.wire == wire }
    }
}

/** A pipeline's newest run, as its list row shows it. */
@Immutable
data class PipelineRunSummary(val id: String, val state: PipelineRunState, val createdAt: Long, val endedAt: Long?)

/** One row of the pipelines list. */
@Immutable
data class PipelineSummary(
    val id: String,
    val name: String,
    val description: String?,
    val headVersion: Int,
    /** A disabled pipeline refuses triggers; its runs still read. */
    val enabled: Boolean,
    val lastRun: PipelineRunSummary?,
)

/** How a run came to be: an agent's `run_pipeline`, or a `pipeline` node of a parent run. */
@Immutable
sealed interface PipelineRunTrigger {
    /** [agentId] is null where the server no longer names the agent. */
    data class Agent(val agentId: String?) : PipelineRunTrigger

    data class Pipeline(val runId: String, val nodeId: String) : PipelineRunTrigger
}

/** One run in a list, newest first. */
@Immutable
data class PipelineRunEntry(
    val id: String,
    val version: Int,
    val state: PipelineRunState,
    /** Null for a trigger this app doesn't know. */
    val trigger: PipelineRunTrigger?,
    /** The run whose `pipeline` node made this one; null for a run an agent started. */
    val parentRunId: String?,
    val createdAt: Long,
    /** Null while it waits in its group's queue. */
    val startedAt: Long?,
    val endedAt: Long?,
)

/** One run among every pipeline's runs: its entry, and which pipeline it ran. */
@Immutable
data class PipelineRunListEntry(
    val run: PipelineRunEntry,
    val pipelineId: String,
    val pipelineName: String,
    /** Its pipeline was archived: the run still reads, the pipeline's page doesn't. */
    val pipelineArchived: Boolean,
) {
    val id: String get() = run.id
}

/** One page of runs and where the next older one starts; [nextCursor] null on the last. */
@Immutable
data class PipelineRunPage<T>(val runs: List<T>, val nextCursor: String?)

/**
 * The newest page of runs read again on top of what is kept (desktop's
 * `pipelineRunsMerge`). A reader who paged past the first page keeps the
 * older runs they read, below the fresh page; one who didn't takes the page
 * as it is.
 */
fun pipelineRunsMerge(previous: List<PipelineRunListEntry>, page: List<PipelineRunListEntry>, pageComplete: Boolean): List<PipelineRunListEntry> {
    if (pageComplete) return page
    val fresh = page.mapTo(HashSet()) { it.id }
    val oldest = page.lastOrNull()?.run?.createdAt ?: Long.MAX_VALUE
    return page + previous.filter { it.id !in fresh && it.run.createdAt <= oldest }
}
