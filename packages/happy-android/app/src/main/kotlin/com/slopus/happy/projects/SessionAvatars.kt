package com.slopus.happy.projects

import com.slopus.happy.AppGraph
import com.slopus.happy.attachments.rewriteLoopbackHost
import com.slopus.happy.auth.AuthState
import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.crypto.decryptBlob
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.ProjectAvatar
import com.slopus.happy.model.SessionAvatarDescriptor
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

private val PREVIEW_MIME_TYPES = setOf("image/webp", "image/png", "image/jpeg")
private const val MAX_AVATAR_BYTES = 10 * 1024 * 1024

/** sessionAvatars.ts previewSchema: a 4..128 thumbhash and one of three image types. */
fun parseSessionAvatarPreview(value: Any?): Pair<String, String>? {
    val json = value as? JsonObject ?: return null
    val thumbhash = (json["thumbhash"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length in 4..128 } ?: return null
    val mimeType = (json["mimeType"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it in PREVIEW_MIME_TYPES } ?: return null
    return thumbhash to mimeType
}

/**
 * sessionAvatars.ts loadSessionAvatar: the preview opens with the
 * session's key; the server grants the download, which must still be the
 * descriptor's ref; the bytes (at most 10 MB, from http(s) without
 * credentials in the URL) open with the session's blob key.
 */
suspend fun loadSessionAvatar(
    descriptor: SessionAvatarDescriptor,
    cipher: PayloadCipher,
    blobKey: ByteArray,
    grant: suspend () -> Pair<String, String>?,
    download: suspend (url: String) -> ByteArray?,
): ProjectAvatar? {
    val (thumbhash, mimeType) = parseSessionAvatarPreview(runCatching { cipher.decryptFromBase64(descriptor.preview) }.getOrNull()) ?: return null
    val (ref, url) = grant() ?: return null
    // A replacement may have happened since the descriptor was received.
    if (ref != descriptor.ref) return null
    val parsed = url.toHttpUrlOrNull() ?: return null
    if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return null
    val encrypted = download(url)?.takeIf { it.size <= MAX_AVATAR_BYTES } ?: return null
    val bytes = decryptBlob(encrypted, blobKey) ?: return null
    return ProjectAvatar(descriptor.ref, descriptor.version, mimeType, thumbhash, "data:$mimeType;base64,${encodeBase64(bytes)}")
}

/**
 * SessionAvatarHydrator: one bounded (15 s) download per session. A new
 * descriptor cancels the one in flight; an avatar is published only for
 * the descriptor the session still has.
 */
class SessionAvatarHydrator(
    private val scope: CoroutineScope,
    private val load: suspend (sessionId: String, descriptor: SessionAvatarDescriptor) -> ProjectAvatar?,
) {
    private val state = MutableStateFlow<Map<String, ProjectAvatar>>(emptyMap())
    val avatars: StateFlow<Map<String, ProjectAvatar>> = state.asStateFlow()

    private val pending = HashMap<String, Pair<SessionAvatarDescriptor, Job>>()
    private val wanted = HashMap<String, SessionAvatarDescriptor>()

    /** The sessions' descriptors as stored now. */
    @Synchronized
    fun update(descriptors: Map<String, SessionAvatarDescriptor?>) {
        for (id in (pending.keys + state.value.keys + wanted.keys).toSet() - descriptors.keys) forget(id)
        for ((id, descriptor) in descriptors) {
            if (descriptor == null) {
                forget(id)
                continue
            }
            wanted[id] = descriptor
            if (pending[id]?.first == descriptor) continue
            val shown = state.value[id]
            if (shown != null && shown.ref == descriptor.ref && shown.version == descriptor.version) continue
            pending.remove(id)?.second?.cancel()
            if (shown != null) state.value -= id
            val job = scope.launch {
                val avatar = try {
                    withTimeoutOrNull(15_000) { load(id, descriptor) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Artwork failure must not interrupt anything else.
                    null
                }
                synchronized(this@SessionAvatarHydrator) {
                    if (pending[id]?.first != descriptor) return@launch
                    pending.remove(id)
                    if (avatar != null && wanted[id] == descriptor) state.value += (id to avatar)
                }
            }
            pending[id] = descriptor to job
        }
    }

    private fun forget(id: String) {
        pending.remove(id)?.second?.cancel()
        wanted.remove(id)
        if (id in state.value) state.value -= id
    }
}

/** The signed-in account's session avatars, by session id. */
class SessionAvatarServices private constructor(graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).followRedirects(false).build()

    @OptIn(ExperimentalCoroutinesApi::class)
    val avatars: StateFlow<Map<String, ProjectAvatar>> = graph.account
        .flatMapLatest { account ->
            val signedIn = graph.auth.state.value as? AuthState.SignedIn
            if (account == null || signedIn == null) flowOf(emptyMap()) else follow(graph, signedIn)
        }
        .stateIn(scope, SharingStarted.Eagerly, emptyMap())

    private fun follow(graph: AppGraph, signedIn: AuthState.SignedIn): Flow<Map<String, ProjectAvatar>> = channelFlow {
        val store = graph.store
        val http = graph.http
        val token = signedIn.credentials.token
        val encryption = signedIn.encryption
        val hydrator = SessionAvatarHydrator(this) { id, descriptor -> load(store, http, graph.serverConfig.url.value, token, encryption, id, descriptor) }
        launch { hydrator.avatars.collect { send(it) } }
        launch {
            store.versions.map { it.sessions }.distinctUntilChanged().collect {
                hydrator.update(store.sessions().associate { it.id to SessionAvatarDescriptor.parse(it.avatarJson) })
            }
        }
        awaitClose()
    }

    private suspend fun load(
        store: HappyStore,
        http: HappyHttp,
        server: String,
        token: String,
        encryption: AccountEncryption,
        sessionId: String,
        descriptor: SessionAvatarDescriptor,
    ): ProjectAvatar? {
        val dataKey = store.session(sessionId)?.wrappedDataKey?.let(encryption::decryptDataEncryptionKey) ?: return null
        return loadSessionAvatar(
            descriptor,
            encryption.dataKeyCipher(dataKey),
            AccountEncryption.blobKeyForDataKey(dataKey),
            grant = {
                val text = http.send("POST", "/v1/sessions/${java.net.URLEncoder.encode(sessionId, "UTF-8")}/avatar/request-download", token)
                val body = runCatching { HappyJson.parseToJsonElement(text) }.getOrNull() as? JsonObject
                val ref = (body?.get("ref") as? JsonPrimitive)?.takeIf { it.isString }?.content
                val url = (body?.get("downloadUrl") as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (ref == null || url == null) null else ref to rewriteLoopbackHost(url, server)
            },
            download = { url ->
                val request = Request.Builder().url(url).apply { if (sameOrigin(url, server)) header("Authorization", "Bearer $token") }.get().build()
                withContext(Dispatchers.IO) {
                    client.newCall(request).execute().use { response ->
                        val length = response.header("Content-Length")?.toLongOrNull()
                        if (!response.isSuccessful || (length != null && length > MAX_AVATAR_BYTES)) null else response.body.bytes()
                    }
                }
            },
        )
    }

    companion object {
        private val instances = WeakHashMap<AppGraph, SessionAvatarServices>()

        fun of(graph: AppGraph): SessionAvatarServices = synchronized(instances) { instances.getOrPut(graph) { SessionAvatarServices(graph) } }
    }
}
