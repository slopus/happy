package com.slopus.happy.sync

import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1
import com.slopus.happy.model.qualifyRigModelKey
import com.slopus.happy.model.rigComposerMode
import com.slopus.happy.model.rigModels
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** The per-session picks that sync through session metadata (storageTypes.ts `SessionAgentModesPatch`). */
enum class AgentModeField(val key: String) {
    PERMISSION_MODE("permissionMode"),
    MODEL_MODE("modelMode"),
    EFFORT_LEVEL("effortLevel"),
}

/**
 * This device's side of a session's composer: the fields storage.ts keeps on
 * a Session next to the synced record. For a Happy CLI session the picks
 * mirror session metadata and the draft is device-local; for a Happy Agent
 * session all of it mirrors the synced composer draft (rigComposer.ts).
 */
@Serializable
data class ComposerMirror(
    val draft: String? = null,
    /** Happy Agent: when the draft was last edited, on any device. */
    val draftUpdatedAt: Long? = null,
    val permissionMode: String? = null,
    val modelMode: String? = null,
    val effortLevel: String? = null,
    /** Happy Agent's service tier; meaningful only when [hasServiceTier], else the session's own applies. */
    val serviceTier: String? = null,
    val hasServiceTier: Boolean = false,
) {
    fun mode(field: AgentModeField): String? = when (field) {
        AgentModeField.PERMISSION_MODE -> permissionMode
        AgentModeField.MODEL_MODE -> modelMode
        AgentModeField.EFFORT_LEVEL -> effortLevel
    }

    fun withMode(field: AgentModeField, value: String?): ComposerMirror = when (field) {
        AgentModeField.PERMISSION_MODE -> copy(permissionMode = value)
        AgentModeField.MODEL_MODE -> copy(modelMode = value)
        AgentModeField.EFFORT_LEVEL -> copy(effortLevel = value)
    }

    fun withModes(patch: Map<AgentModeField, String?>): ComposerMirror =
        patch.entries.fold(this) { mirror, (field, value) -> mirror.withMode(field, value) }
}

/**
 * Keeps [ComposerMirror]s in step with session metadata and writes the
 * device's edits back (ops.ts `sessionSetAgentModes`, rigComposer.ts, and the
 * composer half of storage.ts `applySessions`).
 *
 * A pick is applied locally at once and pushed with `update-metadata`; while
 * the push is in flight an inbound update still carries the old value, so
 * the pick is kept (agentModesPending.ts). Otherwise metadata that has the
 * field wins whenever a newer metadata version arrives. A Happy Agent draft
 * is one stamped document: typing is debounced, picks and clears are written
 * at once, one write in flight per session, and on a conflict the draft goes
 * onto the newest metadata unless the remote one is stamped the same or later.
 *
 * Everything runs confined to one serial dispatcher; the public calls return
 * once the mirror has changed, and the write carries on behind them.
 */
class SessionComposer(
    private val store: HappyStore,
    private val decoder: RecordDecoder,
    /** The `update-metadata` round trip ([RpcClient.emitWithAck]). */
    private val emitWithAck: suspend (event: String, payload: JsonElement) -> JsonElement,
    /** Whether the updates socket is connected; a failed draft write retries only while it is. */
    private val isConnected: () -> Boolean,
    parent: Job,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val scope = CoroutineScope(SupervisorJob(parent) + dispatcher)

    /** What is stored per session: the mirror and the metadata it was last reconciled with. */
    @Serializable
    private data class Entry(
        val mirror: ComposerMirror = ComposerMirror(),
        val appliedVersion: Long = -1,
        val appliedLastMode: String? = null,
    )

    private val entries = HashMap<String, Entry>()

    /** Sessions reconciled since this process started; anything else in [entries] was restored from disk. */
    private val seen = HashSet<String>()
    private val pending = HashMap<String, MutableMap<AgentModeField, Int>>()
    private val writers = HashMap<String, Writer>()
    private var loaded = false

    private val state = MutableStateFlow<Map<String, ComposerMirror>>(emptyMap())

    /** Every session's mirror that differs from an empty one. */
    val mirrors: StateFlow<Map<String, ComposerMirror>> = state.asStateFlow()

    fun mirror(sessionId: String): Flow<ComposerMirror> =
        state.map { it[sessionId] ?: ComposerMirror() }.distinctUntilChanged()

    /** Restores the stored mirrors and follows session changes from now on. */
    fun start() {
        scope.launch {
            store.versions.map { it.sessions }.distinctUntilChanged().collect { reconcileAll() }
        }
    }

    /** ops.ts `sessionSetAgentModes`: a pick from the composer, applied now and pushed to the session. */
    suspend fun setAgentModes(sessionId: String, patch: Map<AgentModeField, String?>) = withContext(dispatcher) {
        load()
        val session = store.session(sessionId) ?: return@withContext
        val metadata = SessionMetadata.parse(session.metadataJson)
        // Happy Agent carries its pickers inside the synced draft.
        if (metadata.isRigV1()) return@withContext rigSetMode(sessionId, metadata, patch)

        // Changed when it differs from the mirror or from metadata: a local-only
        // value (plan mode switched on by the agent) must still reach metadata
        // when the user picks it, or other devices never see it.
        val mirror = mirrorOf(sessionId)
        val changed = patch.filter { (field, value) ->
            value != mirror.mode(field) || value != metadataMode(metadata, field)
        }
        if (changed.isEmpty()) return@withContext
        update(sessionId) { it.withModes(changed) }

        val fields = changed.keys
        markPending(sessionId, fields)
        scope.launch {
            try {
                pushAgentModes(sessionId, changed)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The local pick stays until newer metadata settles it.
            } finally {
                clearPending(sessionId, fields)
            }
        }
    }

    /** storage.ts `updateSessionAgentModes`: a local-only change (the agent entered plan mode), not pushed. */
    suspend fun setLocalModes(sessionId: String, patch: Map<AgentModeField, String?>) = withContext(dispatcher) {
        load()
        if (store.session(sessionId) != null) update(sessionId) { it.withModes(patch) }
    }

    /**
     * The composer's text changed. A Happy CLI draft stays on this device; a
     * Happy Agent draft is stamped now and written after a pause in typing,
     * or at once when the text is empty (rigComposer.ts `rigComposerSetText`).
     */
    suspend fun setText(sessionId: String, text: String) = withContext(dispatcher) {
        load()
        val session = store.session(sessionId) ?: return@withContext
        val metadata = SessionMetadata.parse(session.metadataJson)
        val mirror = mirrorOf(sessionId)
        if (!metadata.isRigV1()) {
            update(sessionId) { it.copy(draft = text.ifEmpty { null }) }
            return@withContext
        }
        if ((mirror.draft ?: "") == text) return@withContext
        update(sessionId) { it.copy(draft = text, draftUpdatedAt = stampFor(mirror, metadata)) }
        schedule(sessionId, if (text.isEmpty()) 0 else DRAFT_DEBOUNCE_MS)
    }

    /**
     * A send or a deliberate discard (rigComposer.ts `rigComposerClear`): the
     * draft becomes null under a new stamp and the pickers keep the mode just
     * used. Nothing is written when there is no draft to clear.
     */
    suspend fun clearDraft(sessionId: String) = withContext(dispatcher) {
        load()
        val session = store.session(sessionId) ?: return@withContext
        val metadata = SessionMetadata.parse(session.metadataJson)
        val mirror = mirrorOf(sessionId)
        if (mirror.draft == null) return@withContext
        if (!metadata.isRigV1()) {
            update(sessionId) { it.copy(draft = null) }
            return@withContext
        }
        update(sessionId) { it.copy(draft = null, draftUpdatedAt = stampFor(mirror, metadata)) }
        schedule(sessionId, 0)
    }

    /** rigComposer.ts `rigComposerFlushAheadSessions`: on connect, write every draft stamped ahead of its metadata. */
    suspend fun flushAhead() = withContext(dispatcher) {
        load()
        for ((sessionId, entry) in entries.toList()) {
            val metadata = store.session(sessionId)?.let { SessionMetadata.parse(it.metadataJson) } ?: continue
            if (!metadata.isRigV1()) continue
            val local = entry.mirror.draftUpdatedAt ?: continue
            val remote = metadata.draftUpdatedAt
            if (remote == null || local > remote) flushNow(sessionId)
        }
    }

    // Reconciling with session metadata (storage.ts applySessions).

    private fun load() {
        if (loaded) return
        loaded = true
        for ((sessionId, json) in store.composers()) {
            val entry = try {
                HappyJson.decodeFromString(Entry.serializer(), json)
            } catch (_: SerializationException) {
                continue
            } catch (_: IllegalArgumentException) {
                continue
            }
            entries[sessionId] = entry
        }
        publish()
    }

    private fun reconcileAll() {
        load()
        val sessions = store.sessions()
        val ids = sessions.mapTo(HashSet()) { it.id }
        // Deleted sessions: their stored rows went with them.
        entries.keys.retainAll(ids)
        seen.retainAll(ids)
        writers.keys.filter { it !in ids }.forEach { writers.remove(it)?.timer?.cancel() }
        sessions.forEach(::reconcile)
        publish()
    }

    private fun reconcile(session: SessionRecord) {
        val entry = entries[session.id]
        val first = session.id !in seen
        if (!first && entry != null && entry.appliedVersion >= session.metadataVersion) return
        seen += session.id
        val metadata = SessionMetadata.parse(session.metadataJson)
        val lastMode = metadata?.raw?.get("lastMode")?.toString()
        val mirror = entry?.mirror ?: ComposerMirror()
        val next = if (metadata.isRigV1()) {
            reconcileRig(session.id, mirror, metadata!!, existing = !first && entry != null, lastModeChanged = lastMode != entry?.appliedLastMode)
        } else {
            AgentModeField.entries.fold(mirror) { acc, field ->
                if (isPending(session.id, field) || metadata == null || !metadata.raw.containsKey(field.key)) acc
                else acc.withMode(field, metadataMode(metadata, field))
            }
        }
        store(session.id, Entry(next, session.metadataVersion, lastMode))
    }

    private fun reconcileRig(
        sessionId: String,
        mirror: ComposerMirror,
        metadata: SessionMetadata,
        existing: Boolean,
        lastModeChanged: Boolean,
    ): ComposerMirror {
        val remoteStamp = metadata.draftUpdatedAt
        val localStamp = mirror.draftUpdatedAt
        val adopt = localStamp == null || (remoteStamp != null && remoteStamp >= localStamp)
        if (!adopt) {
            // A draft restored from disk that is still ahead is written once the session is known.
            if (!existing && (remoteStamp == null || localStamp > remoteStamp)) {
                scope.launch { flushNow(sessionId) }
            }
            return mirror
        }
        val mode = metadata.rigComposerMode()
        val text = metadata.draft?.text
        // A clear can echo before the message updates lastMode: keep the
        // captured selection until lastMode actually changes.
        val keepClearedMode = existing && mirror.draft == null && text == null && remoteStamp == localStamp && !lastModeChanged
        val base = mirror.copy(draft = text, draftUpdatedAt = remoteStamp)
        if (keepClearedMode) return base
        return base.copy(
            permissionMode = mode?.permissionMode,
            modelMode = mode?.let { qualifyRigModelKey(it.providerId, it.modelId) },
            effortLevel = mode?.effort,
            serviceTier = mode?.serviceTier,
            hasServiceTier = mode != null,
        )
    }

    private fun mirrorOf(sessionId: String) = entries[sessionId]?.mirror ?: ComposerMirror()

    private fun update(sessionId: String, change: (ComposerMirror) -> ComposerMirror) {
        val entry = entries[sessionId] ?: Entry()
        store(sessionId, entry.copy(mirror = change(entry.mirror)))
        publish()
    }

    private fun store(sessionId: String, entry: Entry) {
        if (entries[sessionId] == entry) return
        entries[sessionId] = entry
        store.saveComposer(sessionId, HappyJson.encodeToString(Entry.serializer(), entry))
    }

    private fun publish() {
        val next = entries.mapNotNull { (id, entry) -> entry.mirror.takeIf { it != ComposerMirror() }?.let { id to it } }.toMap()
        if (next != state.value) state.value = next
    }

    // Happy CLI picks (ops.ts sessionUpdateAgentModesMetadata).

    private fun markPending(sessionId: String, fields: Collection<AgentModeField>) {
        val counters = pending.getOrPut(sessionId) { HashMap() }
        fields.forEach { counters[it] = (counters[it] ?: 0) + 1 }
    }

    private fun clearPending(sessionId: String, fields: Collection<AgentModeField>) {
        val counters = pending[sessionId] ?: return
        for (field in fields) {
            val count = counters[field] ?: 0
            if (count <= 1) counters.remove(field) else counters[field] = count - 1
        }
        if (counters.isEmpty()) pending.remove(sessionId)
    }

    private fun isPending(sessionId: String, field: AgentModeField) = (pending[sessionId]?.get(field) ?: 0) > 0

    /**
     * Writes the picks into session metadata. On a conflict the server's
     * newest metadata is taken as it is, so fields this app does not know
     * survive; a field a newer local action changed since is dropped, so a
     * cleared pick is not resurrected.
     */
    private suspend fun pushAgentModes(sessionId: String, patch: Map<AgentModeField, String?>, maxRetries: Int = 3) {
        val session = store.session(sessionId)
        val raw = session?.metadataJson?.let(::parseObject)
        val cipher = session?.let { decoder.cipher(it.wrappedDataKey) }
        if (session == null || raw == null || cipher == null) {
            throw RpcException("Session $sessionId is not ready for metadata updates")
        }
        val pendingPatch = LinkedHashMap(patch)
        var version = session.metadataVersion
        var current = raw.withModes(pendingPatch)
        repeat(maxRetries) {
            val answer = updateMetadata(sessionId, cipher, current, version)
            when (answer.string("result")) {
                "success" -> return storeAcked(sessionId, current, answer, version)
                "version-mismatch" -> {
                    version = (answer["version"] as? JsonPrimitive)?.longOrNull ?: throw RpcException("Failed to update session metadata")
                    val latest = answer.string("metadata")?.let { cipher.decryptFromBase64(it) } as? JsonObject
                        ?: throw RpcException("Failed to decrypt latest session metadata")
                    val mirror = mirrorOf(sessionId)
                    pendingPatch.keys.retainAll { field -> mirror.mode(field) == pendingPatch[field] }
                    if (pendingPatch.isEmpty()) return
                    current = latest.withModes(pendingPatch)
                }
                else -> throw RpcException("Failed to update session metadata")
            }
        }
        throw RpcException("Failed to update session metadata after $maxRetries retries due to version conflicts")
    }

    // Happy Agent drafts (rigComposer.ts).

    private fun rigSetMode(sessionId: String, metadata: SessionMetadata?, patch: Map<AgentModeField, String?>) {
        val mirror = mirrorOf(sessionId)
        var next = mirror.withModes(patch).copy(draft = mirror.draft ?: "")
        // Keep the mirror concrete so the composer and the written draft agree.
        if (AgentModeField.MODEL_MODE in patch || (AgentModeField.EFFORT_LEVEL in patch && patch[AgentModeField.EFFORT_LEVEL] == null)) {
            val draft = composeRigDraft(metadata, next)
            next = next.copy(
                effortLevel = draft.string("effort")?.ifEmpty { null },
                serviceTier = draft.string("serviceTier"),
                hasServiceTier = true,
            )
        }
        update(sessionId) { next.copy(draftUpdatedAt = stampFor(mirror, metadata)) }
        schedule(sessionId, 0)
    }

    /** Later than now and later than any stamp already seen for the session. */
    private fun stampFor(mirror: ComposerMirror, metadata: SessionMetadata?): Long =
        maxOf(clock(), maxOf(mirror.draftUpdatedAt ?: 0, metadata?.draftUpdatedAt ?: 0) + 1)

    private class Writer {
        var timer: Job? = null
        var running = false
        var dirty = false
        var retryDelayMs = RETRY_DELAY_MS
    }

    private fun schedule(sessionId: String, delayMs: Long) {
        val writer = writers.getOrPut(sessionId) { Writer() }
        writer.timer?.cancel()
        writer.timer = null
        if (delayMs > 0) {
            writer.timer = scope.launch {
                delay(delayMs)
                writer.timer = null
                flush(sessionId)
            }
        } else {
            flush(sessionId)
        }
    }

    private fun flushNow(sessionId: String) {
        val writer = writers.getOrPut(sessionId) { Writer() }
        writer.timer?.cancel()
        writer.timer = null
        flush(sessionId)
    }

    /** One write in flight per session; an edit during a write queues exactly one more. */
    private fun flush(sessionId: String) {
        val writer = writers.getOrPut(sessionId) { Writer() }
        if (writer.running) {
            writer.dirty = true
            return
        }
        writer.running = true
        writer.dirty = false
        scope.launch {
            try {
                writeDraft(sessionId)
                writer.retryDelayMs = RETRY_DELAY_MS
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // A newer edit already scheduled its own write. Otherwise retry
                // while connected; a reconnect writes drafts that are still ahead.
                if (!writer.dirty && writer.timer == null && isConnected()) {
                    val wait = writer.retryDelayMs
                    writer.timer = scope.launch {
                        delay(wait)
                        writer.timer = null
                        if (isConnected() && isAhead(sessionId)) flush(sessionId) else writers.remove(sessionId)
                    }
                    writer.retryDelayMs = minOf(writer.retryDelayMs * 2, MAX_RETRY_DELAY_MS)
                }
            } finally {
                writer.running = false
                if (writer.dirty) flush(sessionId) else if (writer.timer == null) writers.remove(sessionId)
            }
        }
    }

    private fun isAhead(sessionId: String): Boolean {
        val metadata = store.session(sessionId)?.let { SessionMetadata.parse(it.metadataJson) } ?: return false
        if (!metadata.isRigV1()) return false
        return (mirrorOf(sessionId).draftUpdatedAt ?: -1) > (metadata.draftUpdatedAt ?: -1)
    }

    private suspend fun writeDraft(sessionId: String, maxRetries: Int = 3) {
        val first = store.session(sessionId) ?: return
        if (!SessionMetadata.parse(first.metadataJson).isRigV1()) return
        val cipher = decoder.cipher(first.wrappedDataKey) ?: return
        var version = first.metadataVersion
        var base = first.metadataJson?.let(::parseObject) ?: return
        repeat(maxRetries) {
            // Always the newest local state, not the one that scheduled this write.
            val session = store.session(sessionId) ?: return
            val metadata = SessionMetadata.parse(session.metadataJson)
            if (!metadata.isRigV1()) return
            val mirror = mirrorOf(sessionId)
            val draft: JsonElement = if (mirror.draft == null) JsonNull else composeRigDraft(metadata, mirror)
            val document = JsonObject(base + mapOf("draft" to draft, "draftUpdatedAt" to JsonPrimitive(mirror.draftUpdatedAt)))
            val answer = updateMetadata(sessionId, cipher, document, version)
            when (answer.string("result")) {
                "success" -> return storeAcked(sessionId, document, answer, version)
                "version-mismatch" -> {
                    version = (answer["version"] as? JsonPrimitive)?.longOrNull ?: throw RpcException("Failed to update session metadata")
                    val latest = answer.string("metadata")?.let { cipher.decryptFromBase64(it) } as? JsonObject
                        ?: throw RpcException("Failed to decrypt latest session metadata")
                    base = latest
                    // Settle onto the newest metadata. A remote draft stamped
                    // the same or later is adopted; then nothing is left to send.
                    if (SessionMetadata.parse(latest) != null) {
                        storeMetadata(sessionId, latest, version)
                        store.session(sessionId)?.let(::reconcile)
                        publish()
                    }
                    val remoteStamp = (latest["draftUpdatedAt"] as? JsonPrimitive)?.longOrNull
                    if (remoteStamp != null && remoteStamp >= (mirrorOf(sessionId).draftUpdatedAt ?: -1)) return
                }
                else -> throw RpcException("Failed to update session metadata")
            }
        }
        throw RpcException("Failed to update session metadata after $maxRetries retries due to version conflicts")
    }

    private suspend fun updateMetadata(sessionId: String, cipher: PayloadCipher, metadata: JsonObject, expectedVersion: Long): JsonObject =
        emitWithAck("update-metadata", buildJsonObject {
            put("sid", sessionId)
            put("metadata", cipher.encryptToBase64(metadata))
            put("expectedVersion", expectedVersion)
        }) as? JsonObject ?: JsonObject(emptyMap())

    /** The broadcast follows; storing what was accepted now keeps the pick from flickering back. */
    private fun storeAcked(sessionId: String, metadata: JsonObject, answer: JsonObject, expectedVersion: Long) {
        val version = (answer["version"] as? JsonPrimitive)?.longOrNull ?: (expectedVersion + 1)
        storeMetadata(sessionId, metadata, version)
    }

    private fun storeMetadata(sessionId: String, metadata: JsonObject, version: Long) {
        val session = store.session(sessionId) ?: return
        store.upsertSessions(listOf(session.copy(metadataJson = metadata.toString(), metadataVersion = version)))
    }

    companion object {
        const val DRAFT_DEBOUNCE_MS = 250L
        private const val RETRY_DELAY_MS = 1_000L
        private const val MAX_RETRY_DELAY_MS = 30_000L

        private fun parseObject(json: String): JsonObject? = try {
            HappyJson.parseToJsonElement(json).jsonObject
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }

        private fun JsonObject.withModes(patch: Map<AgentModeField, String?>) =
            JsonObject(this + patch.entries.associate { (field, value) -> field.key to JsonPrimitive(value) })

        /** A metadata pick as ops.ts reads it: absent and null are both null. */
        private fun metadataMode(metadata: SessionMetadata?, field: AgentModeField): String? = when (field) {
            AgentModeField.PERMISSION_MODE -> metadata?.permissionMode
            AgentModeField.MODEL_MODE -> metadata?.modelMode
            AgentModeField.EFFORT_LEVEL -> metadata?.effortLevel
        }

        /**
         * rigComposer.ts `composeRigDraft`: the whole draft the daemon expects.
         * Picks the composer left unset fall back to the session's current
         * selection; an effort or service tier the model does not offer is dropped.
         */
        fun composeRigDraft(metadata: SessionMetadata?, mirror: ComposerMirror): JsonObject {
            val mode = metadata.rigComposerMode()
            val modelKey = mirror.modelMode ?: mode?.let { qualifyRigModelKey(it.providerId, it.modelId) }
            val model = metadata.rigModels().find { it.key == modelKey }
            val separator = modelKey?.indexOf(':') ?: -1
            val providerId = model?.providerId
                ?: if (separator > 0) modelKey!!.substring(0, separator) else metadata?.currentModelProviderId ?: ""
            val modelId = model?.id
                ?: if (separator > 0) modelKey!!.substring(separator + 1) else metadata?.currentModelCode ?: ""
            val effort = mirror.effortLevel?.takeIf { it.isNotEmpty() && (model == null || it in model.thinkingLevels) }
                ?: metadata.rigReasoningSelection(modelKey)
                ?: model?.defaultThinkingLevel
                ?: mode?.effort
                ?: metadata?.currentThoughtLevelCode
                ?: ""
            val requestedTier = if (mirror.hasServiceTier) mirror.serviceTier else mode?.serviceTier ?: metadata?.session?.serviceTier
            val serviceTier = when {
                requestedTier == null || model == null -> requestedTier
                model.serviceTiers.isEmpty() -> null
                requestedTier in model.serviceTiers -> requestedTier
                else -> null
            }
            return buildJsonObject {
                put("text", mirror.draft ?: "")
                put("providerId", providerId)
                put("modelId", modelId)
                put("effort", effort)
                put("serviceTier", serviceTier)
                put(
                    "permissionMode",
                    mirror.permissionMode
                        ?: mode?.permissionMode
                        ?: metadata?.currentOperatingModeCode
                        ?: metadata?.permissionMode
                        ?: metadata?.session?.permissionMode
                        ?: "",
                )
            }
        }
    }
}
