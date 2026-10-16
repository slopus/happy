package com.slopus.happy.sync

import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.LiveMessageResult
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionAvatarDescriptor
import com.slopus.happy.model.StoredSessionAvatar
import com.slopus.happy.model.mergeSessionAvatar
import com.slopus.happy.model.parseSessionAvatarRevision
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Applies what the `/v1/updates` socket delivers (sync.ts handleUpdate and
 * handleEphemeralUpdate) to the store and to [presence].
 *
 * Every write goes through the store's merge, so an update that arrives
 * before, after or twice relative to a page of the delta sync ends in the
 * same state. When an update cannot be applied on its own (a session or
 * machine this device has not seen, a gap in a session's messages) it asks
 * for the fetch that settles it instead of guessing.
 *
 * Calls run on the caller's dispatcher and block on SQLite: call from a
 * background dispatcher, in arrival order.
 */
class LiveUpdates(
    private val store: HappyStore,
    private val decoder: RecordDecoder,
    private val presence: Presence,
    private val messages: MessageSync,
    /** The delta sync: sessions, machines, settings and profile. */
    private val requestSync: () -> Unit,
    private val onSessionDeleted: (String) -> Unit = {},
) {
    private val projectEvents = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** A project was created, changed or deleted; the catalog endpoint says how (sync.ts projectsSync). */
    val projectChanges: SharedFlow<Unit> = projectEvents.asSharedFlow()

    private val sessionDataEvents = MutableSharedFlow<String>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val agentStateEvents = MutableSharedFlow<String>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** sync.ts onSessionDataUpdated: a message arrived for a known session, or control moved. Git status refreshes on it. */
    val sessionDataUpdates: SharedFlow<String> = sessionDataEvents.asSharedFlow()

    /** A session's agent state changed, so its files may have (sync.ts gitStatusSync.invalidate). */
    val agentStateUpdates: SharedFlow<String> = agentStateEvents.asSharedFlow()

    fun handle(name: String, payload: JsonElement?) {
        val body = payload as? JsonObject ?: return
        when (name) {
            "update" -> decode(ApiUpdateContainer.serializer(), body)?.let(::handleUpdate)
            "ephemeral" -> handleEphemeral(body)
        }
    }

    fun handleUpdate(update: ApiUpdateContainer) {
        val body = update.body
        when (body["t"]?.jsonPrimitive?.contentOrNull) {
            "new-message" -> decode(ApiNewMessageUpdate.serializer(), body)?.let(::newMessage)
            // happy-app only invalidates its listing here: a body this app can't read still means a session to fetch.
            "new-session" -> decode(ApiSession.serializer(), body)?.let(::newSession) ?: requestSync()
            "update-session" -> decode(ApiSessionUpdate.serializer(), body)?.let { updateSession(it, body, update) }
            "delete-session" -> decode(ApiDeleteSessionUpdate.serializer(), body)?.let { deleteSession(it.sid) }
            "new-machine" -> decode(ApiNewMachineUpdate.serializer(), body)?.let(::newMachine)
            "update-machine" -> decode(ApiMachineUpdate.serializer(), body)?.let { updateMachine(it, update) }
            "delete-machine" -> decode(ApiDeleteMachineUpdate.serializer(), body)?.let {
                store.deleteMachine(it.machineId)
                presence.removeMachine(it.machineId)
            }
            "update-account" -> decode(ApiAccountUpdate.serializer(), body)?.let { updateAccount(it, body, update) }
            "new-project", "update-project" -> projectEvents.tryEmit(Unit)
            // Deleting a project also unlinks its sessions on the server.
            "delete-project" -> {
                projectEvents.tryEmit(Unit)
                requestSync()
            }
            // Artifacts, friends and feed are not part of this app yet; KV is unused by happy-app.
            else -> Unit
        }
    }

    private fun newMessage(update: ApiNewMessageUpdate) {
        val sessionId = update.sid
        val session = store.session(sessionId)
        val cipher = session?.let { decoder.cipher(it.wrappedDataKey) }
        if (cipher == null) {
            // A session this device has not listed yet: the listing brings it.
            requestSync()
            return
        }
        val message = decoder.message(sessionId, update.message, cipher)
        message.contentJson?.let { lifecycle(it) }?.let { presence.setThinking(sessionId, it) }
        when (store.insertLiveMessage(sessionId, message)) {
            // Fast path only for the next seq; anything else is fetched.
            LiveMessageResult.GAP -> messages.invalidate(sessionId)
            LiveMessageResult.UNKNOWN_SESSION -> requestSync()
            LiveMessageResult.APPENDED -> messages.noteStored(sessionId, listOf(message))
            LiveMessageResult.KNOWN -> Unit
        }
        sessionDataEvents.tryEmit(sessionId)
    }

    /** The server sends the whole record; storing it saves a listing round trip. */
    private fun newSession(session: ApiSession) {
        val record = decoder.session(session)
        if (record == null) requestSync() else store.upsertSessions(listOf(record))
    }

    private fun updateSession(update: ApiSessionUpdate, body: JsonObject, container: ApiUpdateContainer) {
        val session = store.session(update.id)
        val cipher = session?.let { decoder.cipher(it.wrappedDataKey) }
        if (session == null || cipher == null) {
            requestSync()
            return
        }
        if ("avatar" in body) {
            val descriptor = SessionAvatarDescriptor.parse(body["avatar"])
            val incoming = StoredSessionAvatar(
                descriptor?.toJson()?.toString(),
                parseSessionAvatarRevision(body["avatarVersion"]) ?: descriptor?.version,
                container.seq,
            )
            val current = StoredSessionAvatar(session.avatarJson, session.avatarRevision, session.avatarUpdateSeq)
            val avatarChanged = mergeSessionAvatar(current, incoming, listingIsNewer = false) != current
            // An avatar update that changes nothing, and carries nothing else, is not news.
            if (!avatarChanged && update.metadata == null && update.agentState == null && "projectId" !in body) return
        }
        var next = session.copy(updatedAt = maxOf(session.updatedAt, container.createdAt))
        if ("avatar" in body) {
            val descriptor = SessionAvatarDescriptor.parse(body["avatar"])
            next = next.copy(
                avatarJson = descriptor?.toJson()?.toString(),
                avatarRevision = parseSessionAvatarRevision(body["avatarVersion"]) ?: descriptor?.version,
                avatarUpdateSeq = container.seq,
            )
        }
        update.metadata?.let { metadata ->
            val value = metadata.value?.let { cipher.decryptFromBase64(it) }
            if (value != null) next = next.copy(metadataJson = value.toString(), metadataVersion = metadata.version)
        }
        update.agentState?.let { state ->
            // A null value clears the state; one that does not open is skipped.
            val encrypted = state.value
            val value = if (encrypted == null) null else (cipher.decryptFromBase64(encrypted) ?: return@let)
            next = next.copy(agentStateJson = value?.toString(), agentStateVersion = state.version)
        }
        if ("projectId" in body) next = next.copy(projectId = body["projectId"]?.jsonPrimitive?.contentOrNull)
        store.upsertSessions(listOf(next))

        // Control moved between the terminal and the phone: the side taking
        // over catches up on what was said while it was passive.
        if (update.agentState != null) agentStateEvents.tryEmit(update.id)
        if (update.agentState != null && !isRig(next) && handoff(session, next)) {
            messages.invalidate(update.id)
            sessionDataEvents.tryEmit(update.id)
        }
    }

    private fun deleteSession(sessionId: String) {
        store.deleteSessions(listOf(sessionId))
        presence.removeSession(sessionId)
        messages.forget(sessionId)
        onSessionDeleted(sessionId)
    }

    private fun newMachine(update: ApiNewMachineUpdate) {
        val record = decoder.machine(
            ApiMachine(
                id = update.machineId,
                seq = update.seq,
                createdAt = update.createdAt,
                updatedAt = update.updatedAt,
                active = update.active,
                activeAt = update.activeAt,
                metadata = update.metadata,
                metadataVersion = update.metadataVersion,
                daemonState = update.daemonState,
                daemonStateVersion = update.daemonStateVersion,
                dataEncryptionKey = update.dataEncryptionKey,
            ),
        )
        if (record == null) requestSync() else store.upsertMachines(listOf(record))
    }

    private fun updateMachine(update: ApiMachineUpdate, container: ApiUpdateContainer) {
        val machine = store.machine(update.machineId)
        val cipher = machine?.let { decoder.cipher(it.wrappedDataKey) }
        if (machine == null || cipher == null) {
            requestSync()
            return
        }
        var next = machine.copy(
            updatedAt = maxOf(machine.updatedAt, container.createdAt),
            // As sync.ts: a machine that just changed its state is alive.
            active = update.active ?: true,
            activeAt = update.activeAt ?: container.createdAt,
        )
        update.metadata?.value?.let { cipher.decryptFromBase64(it) }?.let {
            next = next.copy(metadataJson = it.toString(), metadataVersion = update.metadata.version)
        }
        update.daemonState?.value?.let { cipher.decryptFromBase64(it) }?.let {
            next = next.copy(daemonStateJson = it.toString(), daemonStateVersion = update.daemonState.version)
        }
        store.upsertMachines(listOf(next))
    }

    private fun updateAccount(update: ApiAccountUpdate, body: JsonObject, container: ApiUpdateContainer) {
        store.transaction {
            val profileFields = PROFILE_FIELDS.filter { it in body }
            if (profileFields.isNotEmpty()) {
                val profile = store.profile() ?: JsonObject(emptyMap())
                val merged = profile.toMutableMap()
                for (field in profileFields) merged[field] = body.getValue(field)
                merged["timestamp"] = JsonPrimitive(container.createdAt)
                store.saveProfile(JsonObject(merged))
            }
            val settings = update.settings
            val value = settings?.value?.let { decoder.encryption.settingsCipher().decryptFromBase64(it) as? JsonObject }
            // Pending local changes stay pending and keep winning on top.
            if (settings != null && value != null && settings.version >= (store.settings()?.version ?: -1)) {
                store.saveSettings(value, settings.version)
            }
        }
    }

    private fun handleEphemeral(body: JsonObject) {
        when (body["type"]?.jsonPrimitive?.contentOrNull) {
            "activity" -> decode(ApiActivityEphemeral.serializer(), body)?.let {
                presence.activity(it.id, it.active, it.activeAt, it.thinking)
            }
            "machine-activity" -> decode(ApiMachineActivityEphemeral.serializer(), body)?.let {
                presence.machineActivity(it.id, it.active, it.activeAt)
            }
            "usage" -> decode(ApiUsageEphemeral.serializer(), body)?.let {
                presence.usage(it.id, SessionUsage(it.key, it.timestamp, it.tokens, it.cost))
            }
            // session-event drives a browser tab counter; machine-status is deprecated.
            else -> Unit
        }
    }

    private fun <T> decode(serializer: DeserializationStrategy<T>, body: JsonObject): T? = try {
        HappyJson.decodeFromJsonElement(serializer, body)
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    companion object {
        private val PROFILE_FIELDS = listOf("firstName", "lastName", "avatar", "github")

        /**
         * Whether a message starts (true) or ends (false) an agent turn, or
         * neither (null): sync.ts reads it from task lifecycle events so the
         * thinking state holds even when an activity ephemeral is lost.
         */
        fun lifecycle(contentJson: String): Boolean? {
            val raw = try {
                HappyJson.parseToJsonElement(contentJson) as? JsonObject
            } catch (_: SerializationException) {
                null
            } ?: return null
            val content = raw["content"] as? JsonObject ?: return null
            val type = content["type"]?.let { (it as? JsonPrimitive)?.contentOrNull }
            val data = content["data"] as? JsonObject
            val dataType = data?.get("type")?.let { (it as? JsonPrimitive)?.contentOrNull }
            val event = (data?.get("ev") as? JsonObject)?.get("t")?.let { (it as? JsonPrimitive)?.contentOrNull }
            val agentProtocol = type == "acp" || type == "codex"
            return when {
                agentProtocol && (dataType == "task_complete" || dataType == "turn_aborted") -> false
                type == "session" && event == "turn-end" -> false
                agentProtocol && dataType == "task_started" -> true
                type == "session" && event == "turn-start" -> true
                else -> null
            }
        }

        /** rig.ts isRigMetadata: Happy Agent sessions have no terminal to hand control back and forth with. */
        fun isRig(session: SessionRecord): Boolean = metadataOf(session)
            ?.get("client")?.let { it as? JsonObject }
            ?.get("id")?.let { (it as? JsonPrimitive)?.contentOrNull } == "rig"

        /** controlHandoff.ts resolveControlHandoffDirection, either direction. */
        private fun handoff(before: SessionRecord, after: SessionRecord): Boolean {
            val was = controlledByUser(before)
            val now = controlledByUser(after)
            return (now == true && was != true) || (was == true && now == false)
        }

        private fun controlledByUser(session: SessionRecord): Boolean? = session.agentStateJson
            ?.let { runCatching { HappyJson.parseToJsonElement(it).jsonObject }.getOrNull() }
            ?.get("controlledByUser")
            ?.let { (it as? JsonPrimitive)?.booleanOrNull }

        fun metadataOf(session: SessionRecord): JsonObject? = session.metadataJson
            ?.let { runCatching { HappyJson.parseToJsonElement(it).jsonObject }.getOrNull() }
    }
}
