package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * A type in a definition's subset of JSON Schema (happy-cluster API.md,
 * "Types"): `type`, `properties`, `required`, `items` and `enum`; a
 * `[type, "null"]` pair is [nullable].
 */
@Immutable
sealed interface PipelineSchema {
    val nullable: Boolean

    data object Null : PipelineSchema {
        override val nullable: Boolean get() = false
    }

    /** `string`, `number`, `integer` or `boolean`; [values] what its `enum` allows, when it lists them. */
    data class Scalar(val type: String, val values: List<JsonPrimitive>?, override val nullable: Boolean) : PipelineSchema

    data class ListOf(val items: PipelineSchema, override val nullable: Boolean) : PipelineSchema

    /** Fields in the order the schema lists them; an object never takes others. */
    data class ObjectOf(val fields: List<PipelineField>, override val nullable: Boolean) : PipelineSchema
}

@Immutable
data class PipelineField(val name: String, val schema: PipelineSchema, val required: Boolean)

/** A declared type: as read, and the JSON Schema it was written as. */
@Immutable
data class PipelineType(val schema: PipelineSchema, val json: JsonElement)

/** A vault or repository granted, and whether to read it or also write it. */
@Immutable
data class PipelineGrant(val id: String, val write: Boolean)

@Immutable
data class PipelineComputeGrant(val pools: List<String> = emptyList(), val computers: List<String> = emptyList(), val maxLeases: Int? = null)

/**
 * What a pipeline (its ceiling) or a node may reach (pipelines-design.md, §5).
 * Everything is denied unless granted: an empty set computes and nothing else.
 */
@Immutable
data class PipelinePermissions(
    val tools: List<String> = emptyList(),
    val vaults: List<PipelineGrant> = emptyList(),
    val secrets: List<String> = emptyList(),
    val repositories: List<PipelineGrant> = emptyList(),
    /** Agents it may message. */
    val agents: List<String> = emptyList(),
    /** Pipelines it may run. */
    val pipelines: List<String> = emptyList(),
    val egressHosts: List<String> = emptyList(),
    val compute: PipelineComputeGrant? = null,
) {
    val none: Boolean
        get() = tools.isEmpty() && vaults.isEmpty() && secrets.isEmpty() && repositories.isEmpty() && agents.isEmpty() &&
            pipelines.isEmpty() && egressHosts.isEmpty() && (compute == null || compute == PipelineComputeGrant())
}

/** A computer a node acquires under [name]: any from [pool], or the one [computer]. */
@Immutable
data class PipelineAcquire(val name: String, val pool: String?, val computer: String?)

/** The computers a node holds: those it acquires, those handed to it it uses, and those it hands on. */
@Immutable
data class PipelineCompute(val acquire: List<PipelineAcquire> = emptyList(), val use: List<String> = emptyList(), val pass: List<String> = emptyList())

/** One node as a version defines it. */
@Immutable
data class PipelineNodeDefinition(
    val id: String,
    val kind: PipelineNodeKind,
    /** An agent node's model, when the definition names one. */
    val model: String? = null,
    /** A `pipeline` node's pipeline. */
    val pipelineId: String? = null,
    /** An agent node's effort, when the definition names one. */
    val effort: String? = null,
    /** Null where it takes whatever the edge into it carries. */
    val input: PipelineType? = null,
    val output: PipelineType? = null,
    /** Null where it is granted nothing. */
    val permissions: PipelinePermissions? = null,
    val compute: PipelineCompute? = null,
    val timeoutSeconds: Long = DEFAULT_TIMEOUT_SECONDS,
    /** With several edges into it: runs once any fired, rather than every one. */
    val joinAny: Boolean = false,
    /** A code node's Monty Python. */
    val source: String? = null,
    /** An agent node's instructions, Markdown. */
    val instructions: String? = null,
) {
    /** The leases it acquires, uses or passes on. */
    val leases: Set<String> get() = compute?.let { it.acquire.map(PipelineAcquire::name) + it.use + it.pass }.orEmpty().toSet()

    companion object {
        const val DEFAULT_TIMEOUT_SECONDS = 3600L
    }
}

@Immutable
data class PipelineEdge(val from: String, val to: String, val onSuccess: Boolean)

enum class PipelineConcurrencyMode {
    /** Every run starts at once. */
    Independent,

    /** A new run aborts the one running in its group. */
    Supersede,

    /** Runs of a group wait their turn. */
    Queue,
}

/** How runs share the pipeline: [group] the template that names a run's group, null for one group. */
@Immutable
data class PipelineConcurrency(val mode: PipelineConcurrencyMode = PipelineConcurrencyMode.Independent, val group: String? = null, val batch: Boolean = false)

/** A version's definition (happy-cluster pipelines-design.md, §2). */
@Immutable
data class PipelineDefinition(
    val root: String,
    /** In the order the definition lists them. */
    val nodes: List<PipelineNodeDefinition>,
    val edges: List<PipelineEdge>,
    /** The pipeline's input type. */
    val input: PipelineType? = null,
    val concurrency: PipelineConcurrency = PipelineConcurrency(),
    /** The agents (or bots) that may start a run. */
    val triggerAgents: List<String> = emptyList(),
    /** The ceiling: the most any node may be granted. */
    val permissions: PipelinePermissions = PipelinePermissions(),
) {
    fun node(id: String): PipelineNodeDefinition? = nodes.firstOrNull { it.id == id }

    /** Where [id] leads when it succeeds, or when it fails. */
    fun next(id: String, onSuccess: Boolean): List<String> = edges.filter { it.from == id && it.onSuccess == onSuccess }.map { it.to }

    fun incoming(id: String): Int = edges.count { it.to == id }

    /** The nodes whose output a run's result holds: those no success edge leads on from (API.md, "Runs"). */
    val ends: List<PipelineNodeDefinition> get() = nodes.filter { node -> edges.none { it.from == node.id && it.onSuccess } }
}

/** Who published a version: a member, or an agent acting for [userId] (null when for nobody). */
@Immutable
data class PipelineAuthor(val userId: String?, val agentId: String?)

/** One version of a pipeline's history. */
@Immutable
data class PipelineVersion(
    val number: Int,
    val message: String,
    /** Null for an author this app doesn't know. */
    val author: PipelineAuthor?,
    val createdAt: Long,
)

/** A version and its definition; [definition] null where this app can't read it. */
@Immutable
data class PipelineVersionDetail(val version: PipelineVersion, val definition: PipelineDefinition?)

/** One pipeline as its page shows it, with its head version. */
@Immutable
data class PipelineDetail(
    val id: String,
    val name: String,
    val description: String?,
    /** A disabled pipeline refuses triggers; its runs still read. */
    val enabled: Boolean,
    val head: PipelineVersionDetail,
)
