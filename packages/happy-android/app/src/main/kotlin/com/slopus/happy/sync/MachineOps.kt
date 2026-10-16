package com.slopus.happy.sync

import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.net.HappyJson
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Machine operations (ops.ts): spawning, resuming and stopping sessions,
 * fork and duplicate, and the daemon's own shell. Calls that answer with a
 * result never throw; the failure comes back in it, worded as ops.ts words it.
 */
class MachineOps internal constructor(
    private val rpc: RpcClient,
    private val api: SyncApi,
    private val store: HappyStore,
    private val decoder: RecordDecoder,
    /** Pulls a just-spawned session in before the caller navigates to it; best effort. */
    private val refreshSessions: suspend () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    /** ops.ts `machineSpawnNewSession`. */
    suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult = try {
        SpawnSessionResult.normalize(rpc.machineRpc(options.machineId, "spawn-happy-session", spawnRequest(options)))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        SpawnSessionResult.Error(e.message ?: "Failed to spawn session")
    }

    /**
     * ops.ts `machineResumeSession`. A daemon that has no memory of the
     * session can only revive it with its data key and metadata, which only
     * this device can give it (see [resumeFallback]).
     */
    suspend fun resumeSession(
        machineId: String,
        sessionId: String,
        model: String? = null,
        permissionMode: String? = null,
    ): SpawnSessionResult = try {
        val (fallback, reason) = withContext(io) { resumeFallback(sessionId, machineId) }
        val result = rpc.machineRpc(machineId, "resume-happy-session", buildJsonObject {
            put("sessionId", sessionId)
            putIfNotNull("model", model)
            putIfNotNull("permissionMode", permissionMode)
            putIfNotNull("fallback", fallback)
            put("fallbackReason", reason)
        })
        val error = (result as? JsonObject)?.get("error")
        if (error != null) {
            SpawnSessionResult.Error((error as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "Failed to resume session")
        } else {
            SpawnSessionResult.normalize(result)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        SpawnSessionResult.Error(e.message ?: "Failed to resume session")
    }

    /**
     * ops.ts `buildResumeFallback`. The reason always travels: the daemon puts
     * it in its error, the one place a user sees why a session would not resume.
     */
    internal fun resumeFallback(sessionId: String, machineId: String): Pair<JsonObject?, String> {
        val session = store.session(sessionId)
        val metadata = session?.let { SessionMetadata.parse(it.metadataJson) }
            ?: return null to "client-has-no-session-row"
        // Only the session's own machine may receive its data key.
        if (metadata.machineId != machineId) return null to "client-session-machine-mismatch"
        val dataKey = decoder.dataKey(session.wrappedDataKey) ?: return null to "client-has-no-data-key"
        return buildJsonObject {
            put("metadata", metadata.raw)
            put("metadataVersion", session.metadataVersion)
            put("agentStateVersion", session.agentStateVersion)
            put("seq", session.seq)
            put("encryptionKey", encodeBase64(dataKey))
            put("encryptionVariant", "dataKey")
        } to "ok"
    }

    /**
     * ops.ts `machineStopSession`: SIGTERM from the daemon that started it.
     * The only stop that reaches a session in its first seconds, before it
     * registers its own handlers.
     */
    suspend fun stopSession(machineId: String, sessionId: String): OpResult = try {
        val result = rpc.machineRpc(machineId, "stop-session", buildJsonObject { put("sessionId", sessionId) })
        OpResult(true, (result as? JsonObject)?.string("message"))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        OpResult(false, e.message ?: "Failed to stop session")
    }

    /** ops.ts `machineStopDaemon`: throws if the daemon could not be asked. */
    suspend fun stopDaemon(machineId: String): String? =
        (rpc.machineRpc(machineId, "stop-daemon", JsonObject(emptyMap())) as? JsonObject)?.string("message")

    /** ops.ts `machineBash`. */
    suspend fun bash(machineId: String, command: String, cwd: String): BashResult = try {
        decode(BashResult.serializer(), rpc.machineRpc(machineId, "bash", buildJsonObject {
            put("command", command)
            put("cwd", cwd)
        }))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        BashResult(success = false, stdout = "", stderr = e.message ?: "Unknown error", exitCode = -1)
    }

    /** ops.ts `machineDelete`: the machine row goes; its sessions stay. */
    suspend fun delete(machineId: String): OpResult = try {
        api.deleteMachine(machineId)
        OpResult(true)
    } catch (e: HttpStatusException) {
        OpResult(false, e.body.ifEmpty { "Failed to delete machine" })
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        OpResult(false, e.message ?: "Unknown error")
    }

    /**
     * ops.ts `machineUpdateMetadata`: a rename with optimistic concurrency.
     * On a conflict the server's newer metadata is kept and only the display
     * name is laid over it. Throws once [maxRetries] conflicts are spent.
     */
    suspend fun updateMetadata(machineId: String, metadata: JsonObject, expectedVersion: Long, maxRetries: Int = 3): Long {
        val machine = withContext(io) { store.machine(machineId) }
        val cipher = machine?.let { withContext(io) { decoder.cipher(it.wrappedDataKey) } }
            ?: throw RpcException("Machine encryption not found for $machineId")
        var version = expectedVersion
        var current = metadata
        repeat(maxRetries) { attempt ->
            val sealed = withContext(io) { cipher.encryptToBase64(current) }
            val result = rpc.emitWithAck("machine-update-metadata", buildJsonObject {
                put("machineId", machineId)
                put("metadata", sealed)
                put("expectedVersion", version)
            }) as? JsonObject
            when (result?.string("result")) {
                "success" -> {
                    val newVersion = (result["version"] as? JsonPrimitive)?.longOrNull ?: (version + 1)
                    // The broadcast follows; storing it now keeps the new name from flickering back.
                    withContext(io) {
                        store.machine(machineId)?.let {
                            store.upsertMachines(listOf(it.copy(metadataJson = current.toString(), metadataVersion = newVersion)))
                        }
                    }
                    return newVersion
                }
                "version-mismatch" -> {
                    version = (result["version"] as? JsonPrimitive)?.longOrNull ?: throw RpcException("Failed to update machine metadata")
                    val latest = result.string("metadata")?.let { withContext(io) { cipher.decryptFromBase64(it) } } as? JsonObject
                        ?: JsonObject(emptyMap())
                    // Our rename over everything else as the server now has it.
                    val name = metadata["displayName"]
                    current = JsonObject(if (name != null) latest + ("displayName" to name) else latest - "displayName")
                    if (attempt + 1 >= maxRetries) {
                        throw RpcException("Failed to update after $maxRetries retries due to version conflicts")
                    }
                }
                else -> throw RpcException(result?.string("message") ?: "Failed to update machine metadata")
            }
        }
        throw RpcException("Unexpected error in machineUpdateMetadata")
    }

    /** ops.ts `claudeForkSession`: copies the Claude conversation on the machine. */
    suspend fun claudeFork(machineId: String, directory: String, claudeSessionId: String): ForkResult =
        fork(machineId, "claude-fork-session", "newClaudeSessionId", "Failed to fork session", buildJsonObject {
            put("directory", directory)
            put("claudeSessionId", claudeSessionId)
        })

    /** ops.ts `claudeDuplicateSession`: a copy cut right after [cutAfterUuid]. */
    suspend fun claudeDuplicate(machineId: String, directory: String, claudeSessionId: String, cutAfterUuid: String): ForkResult =
        fork(machineId, "claude-duplicate-session", "newClaudeSessionId", "Failed to duplicate session", buildJsonObject {
            put("directory", directory)
            put("claudeSessionId", claudeSessionId)
            put("cutAfterUuid", cutAfterUuid)
        })

    /** ops.ts `claudeListRewindPoints`: read from the Claude transcript on disk. */
    suspend fun claudeRewindPoints(machineId: String, directory: String, claudeSessionId: String): RewindPointsResult =
        rewindPoints(machineId, "claude-list-rewind-points", "uuid", "Failed to list rewind points", buildJsonObject {
            put("directory", directory)
            put("claudeSessionId", claudeSessionId)
        })

    /** ops.ts `codexForkThread`. */
    suspend fun codexFork(machineId: String, directory: String, codexThreadId: String): ForkResult =
        fork(machineId, "codex-fork-thread", "newCodexThreadId", "Failed to fork Codex thread", buildJsonObject {
            put("directory", directory)
            put("codexThreadId", codexThreadId)
        })

    /** ops.ts `codexDuplicateThread`. */
    suspend fun codexDuplicate(machineId: String, directory: String, codexThreadId: String, cutAfterItemId: String): ForkResult =
        fork(machineId, "codex-duplicate-thread", "newCodexThreadId", "Failed to duplicate Codex thread", buildJsonObject {
            put("directory", directory)
            put("codexThreadId", codexThreadId)
            put("cutAfterItemId", cutAfterItemId)
        })

    /** ops.ts `codexListRewindPoints`. */
    suspend fun codexRewindPoints(machineId: String, directory: String, codexThreadId: String): RewindPointsResult =
        rewindPoints(machineId, "codex-list-rewind-points", "itemId", "Failed to list Codex rewind points", buildJsonObject {
            put("directory", directory)
            put("codexThreadId", codexThreadId)
        })

    /**
     * ops.ts `forkAndSpawn`: copy (and, with a cut point, truncate) the
     * conversation on the machine, then spawn a session resumed into the copy.
     * Lineage rides the spawn into the new session's metadata. On success the
     * session list is refreshed before returning, so the caller can open it.
     */
    suspend fun forkAndSpawn(source: ForkSource, options: ForkOptions = ForkOptions()): SpawnSessionResult {
        val fork = when (source) {
            is ForkSource.Codex -> options.cutAfterItemId
                ?.let { codexDuplicate(source.machineId, source.directory, source.codexThreadId, it) }
                ?: codexFork(source.machineId, source.directory, source.codexThreadId)
            is ForkSource.Claude -> options.cutAfterUuid
                ?.let { claudeDuplicate(source.machineId, source.directory, source.claudeSessionId, it) }
                ?: claudeFork(source.machineId, source.directory, source.claudeSessionId)
        }
        val newId = when (fork) {
            is ForkResult.Error -> return SpawnSessionResult.Error(fork.errorMessage)
            is ForkResult.Success -> fork.newId
        }
        val result = spawnSession(SpawnSessionOptions(
            machineId = source.machineId,
            directory = source.directory,
            agent = if (source is ForkSource.Codex) "codex" else "claude",
            approvedNewDirectoryCreation = false,
            resumeClaudeSessionId = newId.takeIf { source is ForkSource.Claude },
            resumeCodexThreadId = newId.takeIf { source is ForkSource.Codex },
            parentSessionId = source.sessionId,
            forkedFromMessageId = options.forkedFromMessageId,
            isSideChat = options.isSideChat,
        ))
        if (result is SpawnSessionResult.Success) {
            try {
                refreshSessions()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Best effort: the broadcast brings the session in shortly anyway.
            }
        }
        return result
    }

    /** ops.ts `spawnSideChat`: a fork kept out of the session list, shown only beside its parent. */
    suspend fun spawnSideChat(source: ForkSource): SpawnSessionResult = forkAndSpawn(source, ForkOptions(isSideChat = true))

    private suspend fun fork(machineId: String, method: String, idField: String, fallback: String, params: JsonObject): ForkResult = try {
        val answer = rpc.machineRpc(machineId, method, params) as? JsonObject
        when (answer?.string("type")) {
            "success" -> answer.string(idField)?.let { ForkResult.Success(it) } ?: ForkResult.Error(SpawnSessionResult.UNREADABLE)
            "error" -> ForkResult.Error(answer.string("errorMessage") ?: fallback)
            else -> ForkResult.Error(SpawnSessionResult.UNREADABLE)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        ForkResult.Error(e.message ?: fallback)
    }

    private suspend fun rewindPoints(
        machineId: String,
        method: String,
        idField: String,
        fallback: String,
        params: JsonObject,
    ): RewindPointsResult = try {
        val answer = rpc.machineRpc(machineId, method, params) as? JsonObject
        when (answer?.string("type")) {
            "success" -> RewindPointsResult.Success((answer["points"] as? JsonArray).orEmpty().mapNotNull { point ->
                val o = point as? JsonObject ?: return@mapNotNull null
                RewindPoint(
                    id = o.string(idField) ?: return@mapNotNull null,
                    text = o.string("text").orEmpty(),
                    timestamp = (o["timestamp"] as? JsonPrimitive)?.doubleOrNull ?: 0.0,
                )
            })
            "error" -> RewindPointsResult.Error(answer.string("errorMessage") ?: fallback)
            else -> RewindPointsResult.Error(SpawnSessionResult.UNREADABLE)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        RewindPointsResult.Error(e.message ?: fallback)
    }

    companion object {
        /** The `spawn-happy-session` request (ops.ts): Happy Agent gets only its own contract. */
        fun spawnRequest(o: SpawnSessionOptions): JsonObject {
            if (o.agent == "rig" && o.clientRequestId.isNullOrEmpty()) {
                throw RpcException("Rig session creation requires a client request ID")
            }
            if (o.happyAgentTarget != null && o.agent != "rig") {
                throw RpcException("Happy Agent catalog targets require the Happy Agent harness")
            }
            val effort = o.effort ?: o.effortLevel
            return when {
                o.agent == "rig" && o.happyAgentTarget != null -> buildJsonObject {
                    put("type", "happy-agent-spawn")
                    put("clientRequestId", o.clientRequestId)
                    put("target", o.happyAgentTarget.toJson())
                    put("agentConfiguration", buildJsonObject {
                        put("type", "happy-agent")
                        putIfPresent("permissionMode", o.permissionMode)
                        putIfPresent("providerId", o.providerId)
                        putIfPresent("modelId", o.modelId)
                        putIfPresent("effort", effort)
                    })
                }
                o.agent == "rig" -> buildJsonObject {
                    put("type", "spawn-in-directory")
                    put("agent", "rig")
                    put("directory", o.directory)
                    put("approvedNewDirectoryCreation", o.approvedNewDirectoryCreation)
                    putIfPresent("clientRequestId", o.clientRequestId)
                    putIfPresent("permissionMode", o.permissionMode)
                    putIfPresent("providerId", o.providerId)
                    putIfPresent("modelId", o.modelId)
                    putIfPresent("effort", effort)
                }
                else -> buildJsonObject {
                    put("type", "spawn-in-directory")
                    put("directory", o.directory)
                    put("approvedNewDirectoryCreation", o.approvedNewDirectoryCreation)
                    putIfNotNull("token", o.token)
                    putIfNotNull("agent", o.agent)
                    putIfNotNull("permissionMode", o.permissionMode)
                    putIfNotNull("modelMode", o.modelMode)
                    putIfNotNull("effortLevel", o.effortLevel)
                    putIfNotNull("resumeClaudeSessionId", o.resumeClaudeSessionId)
                    putIfNotNull("resumeCodexThreadId", o.resumeCodexThreadId)
                    putIfNotNull("parentSessionId", o.parentSessionId)
                    putIfNotNull("forkedFromMessageId", o.forkedFromMessageId)
                    putIfNotNull("isSideChat", o.isSideChat)
                }
            }
        }

        /** A daemon's answer as [serializer] reads it; an answer it cannot read is a failure. */
        internal fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, answer: JsonElement?): T {
            answer ?: throw RpcException(SpawnSessionResult.UNREADABLE)
            return try {
                HappyJson.decodeFromJsonElement(serializer, answer)
            } catch (_: IllegalArgumentException) {
                throw RpcException(SpawnSessionResult.UNREADABLE)
            }
        }
    }
}
