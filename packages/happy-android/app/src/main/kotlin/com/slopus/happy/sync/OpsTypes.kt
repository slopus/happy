package com.slopus.happy.sync

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

// The shapes ops.ts sends and reads. Answers from a daemon are decoded
// leniently: a field it leaves out takes the default the app would show.

/** What archive, delete, kill and stop answer (ops.ts `{ success, message? }`). */
@Serializable
data class OpResult(val success: Boolean, val message: String? = null)

/** ops.ts `SpawnSessionResult`; resume answers the same way. */
sealed interface SpawnSessionResult {
    data class Success(val sessionId: String) : SpawnSessionResult

    /** Happy Agent is still creating it; ask again with the same client request id after [retryAfterMs]. */
    data class Pending(val clientRequestId: String, val retryAfterMs: Long) : SpawnSessionResult

    data class RequestToApproveDirectoryCreation(val directory: String) : SpawnSessionResult

    data class Error(val errorMessage: String) : SpawnSessionResult

    companion object {
        const val UNREADABLE = "The machine answered with something Happy could not read."

        /**
         * ops.ts `normalizeSpawnSessionResult`: a refusal always under
         * `errorMessage` (earlier Happy Agent daemons used `message`). An
         * answer of a kind this app does not know is unreadable too.
         */
        fun normalize(result: JsonElement?): SpawnSessionResult {
            val answer = result as? JsonObject ?: return Error(UNREADABLE)
            return when (answer.string("type")) {
                "success" -> answer.string("sessionId")?.let(::Success)
                "pending" -> {
                    val id = answer.string("clientRequestId")
                    val retry = (answer["retryAfterMs"] as? JsonPrimitive)?.doubleOrNull
                    if (id != null && retry != null) Pending(id, retry.toLong()) else null
                }
                "requestToApproveDirectoryCreation" -> answer.string("directory")?.let(::RequestToApproveDirectoryCreation)
                "error" -> Error(
                    listOf(answer.string("errorMessage"), answer.string("message")).firstOrNull { !it.isNullOrEmpty() }
                        ?: "Failed to spawn session",
                )
                else -> null
            } ?: Error(UNREADABLE)
        }
    }
}

/** happyAgentSpawn.ts `HappyAgentSpawnTarget`: a catalog destination for Happy Agent's native spawn. */
sealed interface HappyAgentSpawnTarget {
    fun toJson(): JsonObject

    data class Project(val id: String) : HappyAgentSpawnTarget {
        override fun toJson() = buildJsonObject { put("kind", "project"); put("id", id) }
    }

    data class Workspace(val id: String) : HappyAgentSpawnTarget {
        override fun toJson() = buildJsonObject { put("kind", "workspace"); put("id", id) }
    }

    data class NewWorkspace(val projectId: String) : HappyAgentSpawnTarget {
        override fun toJson() = buildJsonObject { put("kind", "newWorkspace"); put("projectId", projectId) }
    }

    /** A new bot, always named here: the daemon never invents a name for one. */
    data class Bot(val name: String) : HappyAgentSpawnTarget {
        override fun toJson() = buildJsonObject { put("kind", "bot"); put("name", name) }
    }
}

/** ops.ts `SpawnSessionOptions`. */
data class SpawnSessionOptions(
    val machineId: String,
    val directory: String,
    val approvedNewDirectoryCreation: Boolean = false,
    val token: String? = null,
    /** codex, claude, gemini, openclaw, agy or rig. */
    val agent: String? = null,
    val permissionMode: String? = null,
    val modelMode: String? = null,
    val effortLevel: String? = null,
    /** Stable idempotency key; Happy Agent (rig) refuses a spawn without one. */
    val clientRequestId: String? = null,
    /** Happy Agent's own provider, model and effort selection. */
    val providerId: String? = null,
    val modelId: String? = null,
    val effort: String? = null,
    val happyAgentTarget: HappyAgentSpawnTarget? = null,
    /** The daemon starts Claude with `--resume`: the fork / duplicate flow. */
    val resumeClaudeSessionId: String? = null,
    val resumeCodexThreadId: String? = null,
    /** Lineage: the session this one was forked from. */
    val parentSessionId: String? = null,
    /** Lineage: the message used as the rewind point (duplicate only). */
    val forkedFromMessageId: String? = null,
    /** A hidden side chat of [parentSessionId]. */
    val isSideChat: Boolean? = null,
)

/** Claude fork / duplicate (`newClaudeSessionId`) and Codex fork / duplicate (`newCodexThreadId`). */
sealed interface ForkResult {
    data class Success(val newId: String) : ForkResult
    data class Error(val errorMessage: String) : ForkResult
}

/** A user message the conversation can be rewound to: Claude's `uuid`, or Codex's `itemId`. */
data class RewindPoint(val id: String, val text: String, val timestamp: Double)

sealed interface RewindPointsResult {
    data class Success(val points: List<RewindPoint>) : RewindPointsResult
    data class Error(val errorMessage: String) : RewindPointsResult
}

/** What a fork starts from (ops.ts `ForkSource`). */
sealed interface ForkSource {
    val sessionId: String
    val machineId: String
    val directory: String

    data class Claude(
        override val sessionId: String,
        override val machineId: String,
        override val directory: String,
        val claudeSessionId: String,
    ) : ForkSource

    data class Codex(
        override val sessionId: String,
        override val machineId: String,
        override val directory: String,
        val codexThreadId: String,
    ) : ForkSource
}

/** ops.ts `ForkOptions`. */
data class ForkOptions(
    val cutAfterUuid: String? = null,
    val cutAfterItemId: String? = null,
    val forkedFromMessageId: String? = null,
    val isSideChat: Boolean? = null,
)

@Serializable
data class BashResult(
    val success: Boolean,
    val stdout: String = "",
    val stderr: String = "",
    val exitCode: Int = -1,
    val error: String? = null,
)

@Serializable
data class ReadFileResult(
    val success: Boolean,
    /** Base64. */
    val content: String? = null,
    val error: String? = null,
)

@Serializable
data class WriteFileResult(val success: Boolean, val hash: String? = null, val error: String? = null)

@Serializable
data class DirectoryEntry(
    val name: String,
    /** file, directory or other. */
    val type: String,
    val size: Double? = null,
    val modified: Double? = null,
)

@Serializable
data class ListDirectoryResult(val success: Boolean, val entries: List<DirectoryEntry>? = null, val error: String? = null)

@Serializable
data class TreeNode(
    val name: String,
    val path: String,
    val type: String,
    val size: Double? = null,
    val modified: Double? = null,
    val children: List<TreeNode>? = null,
)

@Serializable
data class DirectoryTreeResult(val success: Boolean, val tree: TreeNode? = null, val error: String? = null)

@Serializable
data class RipgrepResult(
    val success: Boolean,
    val exitCode: Int? = null,
    val stdout: String? = null,
    val stderr: String? = null,
    val error: String? = null,
)

internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** `{ ...(value ? { key: value } : {}) }`: absent when null or empty. */
internal fun JsonObjectBuilder.putIfPresent(key: String, value: String?) {
    if (!value.isNullOrEmpty()) put(key, value)
}

/** A field JSON.stringify keeps: absent only when undefined (null here). */
internal fun JsonObjectBuilder.putIfNotNull(key: String, value: String?) {
    if (value != null) put(key, value)
}

internal fun JsonObjectBuilder.putIfNotNull(key: String, value: Boolean?) {
    if (value != null) put(key, value)
}

internal fun JsonObjectBuilder.putIfNotNull(key: String, value: JsonElement?) {
    if (value != null) put(key, value)
}
