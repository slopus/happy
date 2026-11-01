package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `GET /v0/profile`'s answer. */
@Serializable
internal data class WireProfileResponse(val profile: WireProfile)

/**
 * What the Profile row and page show (iOS's ProfileState): the newest
 * profile heard from the agent, with this phone's unanswered changes over
 * it, so an older read landing meanwhile never flickers the old name or
 * picture back.
 */
data class AgentProfileState(
    val profile: WireProfile? = null,
    val pendingName: String? = null,
    val pendingPhoto: PendingPhoto? = null,
) {
    /** A picture change sent and not yet answered. */
    sealed interface PendingPhoto {
        /** A new picture, by the id its bytes are kept under. */
        data class Uploading(val id: String) : PendingPhoto
        data object Removing : PendingPhoto
    }

    /** The name to show: the one being saved, else the agent's. */
    val name: String get() = pendingName ?: profile?.name.orEmpty()

    /** Whether a picture shows: one being sent, or the agent's unless it is being removed. */
    val hasPhoto: Boolean get() = when (pendingPhoto) {
        is PendingPhoto.Uploading -> true
        PendingPhoto.Removing -> false
        null -> profile?.photo != null
    }

    /** The agent's picture, while nothing sent here stands over it. */
    val thumbhash: String? get() = if (pendingPhoto == null) profile?.photo?.thumbhash else null

    /** A read or an answer; versions only move forward. */
    fun heard(next: WireProfile): AgentProfileState {
        val have = profile?.version
        val version = next.version
        if (have != null && version != null && version < have) return this
        return copy(profile = next)
    }
}

/**
 * The person's own profile on one agent connection (iOS's ProfileSource):
 * read when asked and whenever the agent says it changed
 * (`profile.updated`), renamed and given or relieved of a picture, each
 * change shown at once and held until the agent answers. [photo] is the
 * picture's bytes: one picked here, or the agent's.
 */
class AgentProfileSource internal constructor(
    private val client: AgentClient,
    private val events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val stateFlow = MutableStateFlow(AgentProfileState())
    val state: StateFlow<AgentProfileState> = stateFlow.asStateFlow()

    private val photoFlow = MutableStateFlow<ByteArray?>(null)
    val photo: StateFlow<ByteArray?> = photoFlow.asStateFlow()

    /** The ThumbHash [photo] stands for, read or being read. */
    private var photoHash: String? = null
    private val picked = HashMap<String, ByteArray>()
    private val readLock = Mutex()
    private var following: Job? = null

    /** Reads the profile again, and from now on follows `profile.updated`. */
    fun refresh() {
        if (following == null) {
            following = scope.launch { events.collect { if (it.type == "profile.updated" || it.type == AgentEvent.HELLO) read() } }
        }
        scope.launch { read() }
    }

    private suspend fun read() {
        readLock.withLock {
            val profile = try {
                client.decode<WireProfileResponse>("GET", "/v0/profile").profile
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return
            }
            stateFlow.update { it.heard(profile) }
            loadPhoto()
        }
    }

    /** Shows [name] at once and saves it over the version last read; a failure shows the agent's again and throws. */
    suspend fun rename(name: String) {
        stateFlow.update { it.copy(pendingName = name) }
        try {
            var version = stateFlow.value.profile?.version ?: client.decode<WireProfileResponse>("GET", "/v0/profile").profile.version
            val body = buildJsonObject {
                put("name", name)
                put("mutationId", AgentClient.newId())
            }
            // One that lost a race reads the newer version and saves over that, once.
            val saved = try {
                client.decode<WireProfileResponse>("PATCH", "/v0/profile", body, version?.let { mapOf("If-Match" to it) } ?: emptyMap())
            } catch (e: AgentApiException) {
                if (e.status != 409) throw e
                version = client.decode<WireProfileResponse>("GET", "/v0/profile").profile.version
                client.decode<WireProfileResponse>("PATCH", "/v0/profile", body, version?.let { mapOf("If-Match" to it) } ?: emptyMap())
            }
            stateFlow.update { state -> state.heard(saved.profile).let { if (it.pendingName == name) it.copy(pendingName = null) else it } }
        } catch (e: Exception) {
            stateFlow.update { if (it.pendingName == name) it.copy(pendingName = null) else it }
            throw e
        }
    }

    /** [jpeg] as the new picture: shown at once, sent, and kept as sent (never read back). */
    suspend fun setPhoto(jpeg: ByteArray) {
        val hold = AgentProfileState.PendingPhoto.Uploading(AgentClient.newId())
        picked[hold.id] = jpeg
        stateFlow.update { it.copy(pendingPhoto = hold) }
        showPhoto(jpeg, null)
        try {
            val response = client.sendBytes("PUT", "/v0/profile/photo", jpeg, mapOf("Content-Type" to "image/jpeg"))
            val saved = AgentClient.json.decodeFromString(WireProfileResponse.serializer(), response.text).profile
            if (stateFlow.value.pendingPhoto == hold) showPhoto(jpeg, saved.photo?.thumbhash)
            stateFlow.update { state -> state.heard(saved).let { if (it.pendingPhoto == hold) it.copy(pendingPhoto = null) else it } }
        } catch (e: Exception) {
            stateFlow.update { if (it.pendingPhoto == hold) it.copy(pendingPhoto = null) else it }
            loadPhoto()
            throw e
        } finally {
            picked.remove(hold.id)
        }
    }

    suspend fun removePhoto() {
        val hold = AgentProfileState.PendingPhoto.Removing
        stateFlow.update { it.copy(pendingPhoto = hold) }
        showPhoto(null, null)
        try {
            val saved = client.decode<WireProfileResponse>("DELETE", "/v0/profile/photo").profile
            stateFlow.update { state -> state.heard(saved).let { if (it.pendingPhoto == hold) it.copy(pendingPhoto = null) else it } }
        } catch (e: Exception) {
            stateFlow.update { if (it.pendingPhoto == hold) it.copy(pendingPhoto = null) else it }
            throw e
        } finally {
            loadPhoto()
        }
    }

    private fun showPhoto(bytes: ByteArray?, hash: String?) {
        photoFlow.value = bytes
        photoHash = hash
    }

    /** The agent's picture, when it is not the one shown. */
    private suspend fun loadPhoto() {
        when (val pending = stateFlow.value.pendingPhoto) {
            is AgentProfileState.PendingPhoto.Uploading -> return showPhoto(picked[pending.id], null)
            AgentProfileState.PendingPhoto.Removing -> return showPhoto(null, null)
            null -> Unit
        }
        val hash = stateFlow.value.thumbhash ?: return showPhoto(null, null)
        if (hash == photoHash && photoFlow.value != null) return
        photoHash = hash
        val bytes = try {
            client.send("GET", "/v0/profile/photo", category = RequestCategory.File).body.takeIf { it.isNotEmpty() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        } ?: return
        if (photoHash == hash) photoFlow.value = bytes
    }
}
