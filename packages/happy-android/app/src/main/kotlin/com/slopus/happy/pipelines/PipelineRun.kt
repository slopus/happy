package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** What one node does: Monty Python, a model with tools, or a child run of another pipeline. */
enum class PipelineNodeKind(val wire: String) {
    Code("code"),
    Agent("agent"),
    Pipeline("pipeline"),
    ;

    companion object {
        fun of(wire: String?): PipelineNodeKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** Where one node stands in a run (happy-cluster API.md, "Runs"). */
enum class PipelineNodeState(val wire: String) {
    Pending("pending"),
    Running("running"),
    Succeeded("succeeded"),
    Failed("failed"),
    Skipped("skipped"),
    Aborted("aborted"),
    ;

    companion object {
        fun of(wire: String?): PipelineNodeState? = entries.firstOrNull { it.wire == wire }
    }
}

/** What a node said about itself: a line of text and, when it said, how far along it is (0 to 1). */
@Immutable
data class PipelineStatusLine(val text: String, val progress: Float?, val at: Long)

/** Why a node failed: one of the cluster's codes (or an agent node's own) and its message. */
@Immutable
data class PipelineFailure(val code: String, val message: String)

/** Tokens and cost one model spent on one agent node. */
@Immutable
data class PipelineModelUsage(
    val provider: String,
    /** The model's full ID as definitions name it: `openai/gpt-6.1-terra`. */
    val model: String,
    val input: Long,
    val output: Long,
    val cacheRead: Long,
    val cacheWrite: Long,
    val reasoning: Long,
    /** In US dollars; null where the provider didn't price it. */
    val costUsd: Double?,
)

/** One node's execution inside a run. Values are JSON as the node received or produced them. */
@Immutable
data class PipelineNodeRun(
    val nodeId: String,
    val kind: PipelineNodeKind,
    val state: PipelineNodeState,
    val status: PipelineStatusLine?,
    /** The last 50, oldest first. */
    val statuses: List<PipelineStatusLine>,
    val input: JsonElement?,
    val output: JsonElement?,
    val failure: PipelineFailure?,
    val agentId: String?,
    /** The child run a `pipeline` node started. */
    val childRunId: String?,
    val startedAt: Long?,
    val endedAt: Long?,
    /** By provider and model; null on other nodes and before an agent node's first inference. */
    val usage: List<PipelineModelUsage>?,
)

/** A named computer a run holds, handed from node to node. */
@Immutable
data class PipelineLease(val name: String, val computerId: String, val holders: List<String>, val releasedAt: Long?)

/** One run, with every node's execution, its leases and the child runs it started. */
@Immutable
data class PipelineRun(
    val entry: PipelineRunEntry,
    val pipelineId: String,
    /** The top of its chain of parents; itself when it has none. */
    val rootRunId: String,
    /** What its concurrency group rendered to; null for the pipeline's one group. */
    val group: String?,
    val input: JsonElement?,
    /** By node, the outputs of the leaves the run reached; null until it ends, and when aborted. */
    val outputs: JsonObject?,
    val nodes: List<PipelineNodeRun>,
    val leases: List<PipelineLease>,
    val childRunIds: List<String>,
) {
    val id: String get() = entry.id
    val state: PipelineRunState get() = entry.state

    /** The runs its pipeline nodes made or joined, each once, oldest first; a node's child shows as soon as the node names it. */
    val childIds: List<String> get() = (childRunIds + nodes.mapNotNull { it.childRunId }).distinct()

    fun node(nodeId: String): PipelineNodeRun? = nodes.firstOrNull { it.nodeId == nodeId }
}

/** One node as the run's version defines it: what the run page needs of the definition. */
@Immutable
data class PipelineNodeDefinition(
    val id: String,
    val kind: PipelineNodeKind,
    /** An agent node's model, when the definition names one. */
    val model: String?,
    /** A `pipeline` node's pipeline. */
    val pipelineId: String?,
    /** The leases it acquires, uses or passes on. */
    val leases: Set<String>,
)

@Immutable
data class PipelineEdge(val from: String, val to: String, val onSuccess: Boolean)

/** A version's graph (happy-cluster pipelines-design.md, §2), as far as the run page reads it. */
@Immutable
data class PipelineDefinition(
    val root: String,
    /** In the order the definition lists them. */
    val nodes: List<PipelineNodeDefinition>,
    val edges: List<PipelineEdge>,
) {
    fun node(id: String): PipelineNodeDefinition? = nodes.firstOrNull { it.id == id }
}

/**
 * The run's nodes in graph order: each in the column of its longest path from
 * the root (desktop's `pipelineGraphLayout`), ties in definition order, so a
 * live run that changes states moves nothing; a node the run has that the
 * definition doesn't comes last. Without the definition, in the order they
 * started, then by ID.
 */
fun pipelineNodeOrder(definition: PipelineDefinition?, nodes: List<PipelineNodeRun>): List<String> {
    if (definition == null) {
        return nodes.sortedWith(compareBy<PipelineNodeRun>({ it.startedAt == null }, { it.startedAt ?: 0 }, { it.nodeId })).map { it.nodeId }
    }
    val ids = definition.nodes.map { it.id }
    val known = ids.toSet()
    val edges = definition.edges.filter { it.from in known && it.to in known }
    val column = HashMap<String, Int>()
    val incoming = ids.associateWithTo(HashMap()) { 0 }
    edges.forEach { incoming[it.to] = incoming.getValue(it.to) + 1 }
    // The root leads, so a graph whose root is listed late still starts at it.
    val ready = ArrayDeque(ids.filter { incoming[it] == 0 }.sortedByDescending { it == definition.root })
    ready.forEach { column[it] = 0 }
    while (ready.isNotEmpty()) {
        val id = ready.removeFirst()
        for (edge in edges) {
            if (edge.from != id) continue
            column[edge.to] = maxOf(column[edge.to] ?: 0, (column[id] ?: 0) + 1)
            val left = incoming.getValue(edge.to) - 1
            incoming[edge.to] = left
            if (left == 0) ready.addLast(edge.to)
        }
    }
    val ordered = ids.withIndex().sortedWith(compareBy({ column[it.value] ?: 0 }, { it.index })).map { it.value }
    return ordered + nodes.map { it.nodeId }.filter { it !in known }
}

/** A run beside the one on screen, its parent or a child: what it runs and how it stands. */
@Immutable
data class PipelineRunRelative(
    val id: String,
    val pipelineId: String,
    val pipelineName: String,
    val version: Int,
    val state: PipelineRunState,
    val startedAt: Long?,
    val endedAt: Long?,
)

/** One thing a node did, in the order it did it; a command or tool call is rewritten in place under its [seq] as it ends. */
@Immutable
sealed interface PipelineLogEntry {
    val seq: Long
    val at: Long

    /** What a code node printed. */
    data class Output(override val seq: Long, override val at: Long, val stderr: Boolean, val text: String) : PipelineLogEntry

    /** A shell command on a computer the node holds. */
    data class Command(
        override val seq: Long,
        override val at: Long,
        val id: String,
        val command: String,
        val cwd: String?,
        /** The lease it ran on. */
        val lease: String?,
        val state: CommandState,
        val exitCode: Int?,
        val durationMs: Long?,
        /** The last 64 KiB, so far while it runs. */
        val output: String,
        val outputTruncated: Boolean,
    ) : PipelineLogEntry {
        /** Aborted, or exited with anything but 0. */
        val failed: Boolean get() = state == CommandState.Aborted || (state == CommandState.Exited && exitCode != 0)
    }

    /** `fetch()`, a granted tool, or an agent's tool call. */
    data class Tool(
        override val seq: Long,
        override val at: Long,
        val id: String,
        val name: String,
        val summary: String,
        val state: ToolState,
        val durationMs: Long?,
        val error: String?,
    ) : PipelineLogEntry

    /** What an agent node's model said. */
    data class Message(override val seq: Long, override val at: Long, val text: String) : PipelineLogEntry

    /** A status line the node set. */
    data class Status(override val seq: Long, override val at: Long, val text: String, val progress: Float?) : PipelineLogEntry

    enum class CommandState { Running, Exited, Aborted }

    enum class ToolState { Running, Ok, Error }
}

/** One read of a node's log after a sequence number. */
@Immutable
data class PipelineLogPage(
    val entries: List<PipelineLogEntry>,
    /** What to read after next time. */
    val nextAfter: Long,
    /** How many of the oldest entries the server let go. */
    val dropped: Int,
    /** Entries already read that were rewritten since, such as a command that finished. */
    val changed: List<PipelineLogEntry>,
)

/**
 * A page of a node's log on top of what is kept (desktop's `logMerge`):
 * rewritten entries replace their copy, new ones go on the end. A command
 * first read while it ran joins [watched]: the reader saw it work, so it
 * stays open once it ends.
 */
fun pipelineLogMerge(entries: List<PipelineLogEntry>, watched: Set<Long>, page: PipelineLogPage): Pair<List<PipelineLogEntry>, Set<Long>> {
    if (page.entries.isEmpty() && page.changed.isEmpty()) return entries to watched
    val next = entries.toMutableList()
    val index = entries.withIndex().associate { it.value.seq to it.index }
    page.changed.forEach { entry -> index[entry.seq]?.let { next[it] = entry } }
    val last = next.lastOrNull()?.seq ?: 0
    val seen = watched.toMutableSet()
    for (entry in page.entries) {
        val position = index[entry.seq]
        if (position != null) next[position] = entry else if (entry.seq > last) next += entry
        if (entry is PipelineLogEntry.Command && entry.state == PipelineLogEntry.CommandState.Running) seen += entry.seq
    }
    return next to seen
}
