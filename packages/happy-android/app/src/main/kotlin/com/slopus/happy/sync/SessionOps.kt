package com.slopus.happy.sync

import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRig
import com.slopus.happy.model.rigHasRpcMethod
import com.slopus.happy.net.HttpStatusException
import com.slopus.happy.sync.MachineOps.Companion.decode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** How a permission request is answered (ops.ts `SessionPermissionRequest.decision`). */
enum class PermissionDecision(val wire: String) {
    APPROVED("approved"),
    APPROVED_FOR_SESSION("approved_for_session"),
    DENIED("denied"),
    ABORT("abort"),
}

/**
 * Session operations (ops.ts): RPCs to the agent behind a session, end to
 * end encrypted with its data key, plus archive and delete over HTTP.
 *
 * Happy Agent sessions advertise what they answer; a call they do not
 * advertise is refused here, never sent (rig.ts gates, [RigCapabilities]).
 * Agent commands ([abort], [allow], [deny], ...) throw [RpcException] on
 * failure; the calls that answer with a result never throw.
 */
class SessionOps internal constructor(
    private val rpc: RpcClient,
    private val api: SyncApi,
    private val store: HappyStore,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    /** ops.ts `sessionAbort`: stop the current turn. */
    suspend fun abort(sessionId: String) {
        val metadata = metadata(sessionId)
        if (!metadata.rigCanAbort()) throw RpcException("Abort is not available for this session")
        rpc.sessionRpc(sessionId, "abort", if (metadata.isRig()) JsonObject(emptyMap()) else buildJsonObject {
            put("reason", ABORT_REASON)
        })
    }

    /** ops.ts `sessionAllow`: [mode] and [allowedTools] change what the agent may do from now on. */
    suspend fun allow(
        sessionId: String,
        requestId: String,
        mode: String? = null,
        allowedTools: List<String>? = null,
        decision: PermissionDecision? = null,
        updatedInput: JsonObject? = null,
    ) {
        rpc.sessionRpc(sessionId, "permission", permission(requestId, true, mode, allowedTools, decision, updatedInput))
    }

    /** ops.ts `sessionDeny`. */
    suspend fun deny(
        sessionId: String,
        requestId: String,
        mode: String? = null,
        allowedTools: List<String>? = null,
        decision: PermissionDecision? = null,
    ) {
        rpc.sessionRpc(sessionId, "permission", permission(requestId, false, mode, allowedTools, decision, null))
    }

    /** ops.ts `sessionAnswerQuestion`: [answers] by question id; [kind] is the one the agent published. */
    suspend fun answerQuestion(sessionId: String, communicationId: String, answers: JsonObject, kind: String = "form") {
        rpc.sessionRpc(sessionId, "communication", buildJsonObject {
            put("id", communicationId)
            put("kind", kind)
            put("status", "answered")
            put("answers", answers)
        })
    }

    /** ops.ts `sessionCancelCommunication`: dismiss without answering. */
    suspend fun cancelCommunication(sessionId: String, communicationId: String, kind: String = "form") {
        rpc.sessionRpc(sessionId, "communication", buildJsonObject {
            put("id", communicationId)
            put("kind", kind)
            put("status", "cancelled")
        })
    }

    /** ops.ts `sessionSwitch`: hand control to `remote` (this app) or `local` (the terminal). */
    suspend fun switchMode(sessionId: String, to: String): Boolean =
        (rpc.sessionRpc(sessionId, "switch", buildJsonObject { put("to", to) }) as? JsonPrimitive)?.booleanOrNull == true

    /** ops.ts `sessionGoalAction`: clear, stop or edit the agent's goal. */
    suspend fun goalAction(sessionId: String, action: String, objective: String? = null) {
        rpc.sessionRpc(sessionId, "goal-action", buildJsonObject {
            put("action", action)
            putIfNotNull("objective", objective)
        })
    }

    /** ops.ts `sessionSetAvatar`: a picture already in the session's attachment store, by ref. */
    suspend fun setAvatar(sessionId: String, ref: String, size: Long, mimeType: String) {
        val answer = rpc.sessionRpc(sessionId, "setAvatar", buildJsonObject {
            put("ref", ref)
            put("size", size)
            put("mimeType", mimeType)
        }) as? JsonObject
        if ((answer?.get("success") as? JsonPrimitive)?.booleanOrNull != true) {
            throw RpcException(answer?.string("error") ?: "The picture could not be set.")
        }
    }

    /** ops.ts `sessionKill`: end the session's process now. */
    suspend fun kill(sessionId: String): OpResult = attempt({ OpResult(false, it ?: "Unknown error") }) {
        decode(OpResult.serializer(), rpc.sessionRpc(sessionId, "killSession", JsonObject(emptyMap())))
    }

    /**
     * ops.ts `sessionArchive`: deactivate it on the server, for when the
     * process is already gone and [kill] cannot reach it. A bot is archived
     * from its machine.
     */
    suspend fun archive(sessionId: String): OpResult {
        if (metadata(sessionId)?.bot != null) return OpResult(false, "Connect to the bot’s machine to archive it.")
        return try {
            api.archiveSession(sessionId)
            OpResult(true)
        } catch (e: HttpStatusException) {
            OpResult(false, "Server error: ${e.status}")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            OpResult(false, e.message ?: "Unknown error")
        }
    }

    /** ops.ts `sessionDelete`: the session and everything in it, for good. */
    suspend fun delete(sessionId: String): OpResult {
        if (metadata(sessionId)?.bot != null) {
            return OpResult(false, "A bot keeps one continuous conversation. Archive the bot instead.")
        }
        return try {
            api.deleteSession(sessionId)
            OpResult(true)
        } catch (e: HttpStatusException) {
            OpResult(false, e.body.ifEmpty { "Failed to delete session" })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            OpResult(false, e.message ?: "Unknown error")
        }
    }

    /** ops.ts `sessionBash`. */
    suspend fun bash(sessionId: String, command: String, cwd: String? = null, timeoutMs: Long? = null): BashResult =
        attempt({ BashResult(success = false, stdout = "", stderr = it ?: "Unknown error", exitCode = -1, error = it ?: "Unknown error") }) {
            if (!metadata(sessionId).rigCanUseShell()) throw RpcException("Shell access is not available for this session")
            decode(BashResult.serializer(), rpc.sessionRpc(sessionId, "bash", buildJsonObject {
                put("command", command)
                putIfNotNull("cwd", cwd)
                if (timeoutMs != null) put("timeout", timeoutMs)
            }))
        }

    /** ops.ts `sessionReadFile`: the content comes back base64. */
    suspend fun readFile(sessionId: String, path: String): ReadFileResult =
        attempt({ ReadFileResult(false, error = it ?: "Unknown error") }) {
            if (!metadata(sessionId).rigCanReadFiles()) throw RpcException("File reading is not available for this session")
            decode(ReadFileResult.serializer(), rpc.sessionRpc(sessionId, "readFile", buildJsonObject { put("path", path) }))
        }

    /** ops.ts `sessionWriteFile`: [content] base64; [expectedHash] guards against overwriting someone else's edit. */
    suspend fun writeFile(sessionId: String, path: String, content: String, expectedHash: String?): WriteFileResult =
        attempt({ WriteFileResult(false, error = it ?: "Unknown error") }) {
            if (!metadata(sessionId).rigCanWriteFiles()) throw RpcException("File writing is not available for this session")
            decode(WriteFileResult.serializer(), rpc.sessionRpc(sessionId, "writeFile", buildJsonObject {
                put("path", path)
                put("content", content)
                put("expectedHash", expectedHash)
            }))
        }

    /** ops.ts `sessionListDirectory`. */
    suspend fun listDirectory(sessionId: String, path: String): ListDirectoryResult =
        attempt({ ListDirectoryResult(false, error = it ?: "Unknown error") }) {
            val metadata = metadata(sessionId)
            if (metadata.isRig() && !metadata.rigHasRpcMethod("listDirectory")) {
                throw RpcException("Directory listing is not advertised by this Rig session")
            }
            decode(ListDirectoryResult.serializer(), rpc.sessionRpc(sessionId, "listDirectory", buildJsonObject { put("path", path) }))
        }

    /** ops.ts `sessionGetDirectoryTree`. */
    suspend fun directoryTree(sessionId: String, path: String, maxDepth: Int): DirectoryTreeResult =
        attempt({ DirectoryTreeResult(false, error = it ?: "Unknown error") }) {
            val metadata = metadata(sessionId)
            if (metadata.isRig() && !metadata.rigHasRpcMethod("getDirectoryTree")) {
                throw RpcException("Directory tree is not advertised by this Rig session")
            }
            decode(DirectoryTreeResult.serializer(), rpc.sessionRpc(sessionId, "getDirectoryTree", buildJsonObject {
                put("path", path)
                put("maxDepth", maxDepth)
            }))
        }

    /** ops.ts `sessionRipgrep`. */
    suspend fun ripgrep(sessionId: String, args: List<String>, cwd: String? = null): RipgrepResult =
        attempt({ RipgrepResult(false, error = it ?: "Unknown error") }) {
            if (!metadata(sessionId).rigCanSearchFiles()) throw RpcException("File search is not available for this session")
            decode(RipgrepResult.serializer(), rpc.sessionRpc(sessionId, "ripgrep", buildJsonObject {
                put("args", JsonArray(args.map(::JsonPrimitive)))
                putIfNotNull("cwd", cwd)
            }))
        }

    private suspend fun metadata(sessionId: String): SessionMetadata? =
        withContext(io) { SessionMetadata.parse(store.session(sessionId)?.metadataJson) }

    private inline fun <T> attempt(failure: (String?) -> T, block: () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        failure(e.message)
    }

    companion object {
        const val ABORT_REASON = "The user doesn't want to proceed with this tool use. The tool use was rejected " +
            "(eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and " +
            "wait for the user to tell you how to proceed."

        private fun permission(
            id: String,
            approved: Boolean,
            mode: String?,
            allowedTools: List<String>?,
            decision: PermissionDecision?,
            updatedInput: JsonObject?,
        ) = buildJsonObject {
            put("id", id)
            put("approved", approved)
            putIfNotNull("mode", mode)
            if (allowedTools != null) put("allowTools", JsonArray(allowedTools.map(::JsonPrimitive)))
            putIfNotNull("decision", decision?.wire)
            putIfNotNull("updatedInput", updatedInput)
        }
    }
}
