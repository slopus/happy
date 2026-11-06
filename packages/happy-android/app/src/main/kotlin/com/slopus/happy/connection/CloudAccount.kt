package com.slopus.happy.connection

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A server the account is on (`GET /v1/servers`). */
@Serializable
data class CloudServer(
    val id: String,
    val name: String,
    val url: String,
    val role: String,
    val createdAt: String? = null,
    /** The server's own name for itself (its node name); [name] until it has one. */
    val displayName: String? = null,
    val image: CloudServerImage? = null,
) {
    /** The server's origin, as its connection keeps it; null for a URL that isn't one. */
    val origin: String? get() = runCatching { ServerAuthClient.parseAddress(url).value }.getOrNull()
    val owner: Boolean get() = role == "owner"
    val title: String get() = displayName?.takeIf { it.isNotBlank() } ?: name
}

/** A server's picture: its ThumbHash to paint first, and its bytes at [url] on the accounts origin, with the account token. */
@Serializable
data class CloudServerImage(val thumbhash: String? = null, val width: Int? = null, val height: Int? = null, val url: String)

/** What `GET /v1/servers/availability` says of a name. */
enum class CloudName { Available, Taken, Reserved, Invalid }

/** Why an accounts API call failed, from its `code` where it gave one. */
class CloudException(val reason: Reason) : Exception(reason.name) {
    enum class Reason { Taken, Invalid, NotFound, SignInRequired, Unreachable, Failed }
}

/** Where the Happy Cloud account stands. */
sealed interface CloudAccountState {
    /** [expired]: it was signed in, and its hour is up (or the service said its token is no good). */
    data class SignedOut(val expired: Boolean = false) : CloudAccountState

    /** The account's sign-in page is open; the app waits for it to come back. */
    data object InBrowser : CloudAccountState

    data object Finishing : CloudAccountState

    data object SignedIn : CloudAccountState

    data class Failed(val reason: ServerAuthException.Reason) : CloudAccountState
}

/**
 * The person's Happy Cloud account (accounts contract, token lifetimes v4)
 * at [origin], the accounts service: signed in with the authorization code
 * flow and PKCE in the system browser, `resource` the accounts origin. Its
 * token is a pass of about an hour, with no refresh: held in memory only,
 * for picking, creating or joining servers, each of which then gets a
 * server token of its own ([serverToken]), the long-lived session. Past its
 * hour, or on any 401, the account is signed out ([CloudAccountState.SignedOut]
 * `expired`) and the person signs in again; nothing retries. The account
 * token goes only to [origin], never to a server.
 */
class CloudAccount(
    private val scope: CoroutineScope,
    val origin: AgentOrigin,
    private val auth: ServerAuthClient,
    http: OkHttpClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val http = http.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val mutableState = MutableStateFlow<CloudAccountState>(CloudAccountState.SignedOut())
    val state: StateFlow<CloudAccountState> = mutableState.asStateFlow()

    private var pending: PendingOAuth? = null
    @Volatile private var access: AccessToken? = null

    /** The accounts service's own sign-in: the contract fixes its endpoints, so nothing is discovered. */
    private val method = OAuthMethod(
        id = "happy-accounts",
        name = "Happy Cloud",
        authorizationUrl = "${origin.value}/authorize",
        tokenUrl = "${origin.value}/token",
        clientId = "happy",
        resource = "${origin.value}/",
    )

    /** The page the browser opens, starting a fresh sign-in each time. */
    fun browserUrl(): String {
        val next = auth.begin(origin, method, ServerSignInFlow.REDIRECT_URI)
        pending = next
        mutableState.value = CloudAccountState.InBrowser
        return next.authorizeUrl
    }

    /** The browser came back to the redirect URI with [uri]; one that isn't this sign-in's is ignored. */
    fun callback(uri: String) {
        val pending = pending ?: return
        if (!pending.isCallback(uri) || ServerAuthClient.query(uri)?.get("state") != pending.state || mutableState.value != CloudAccountState.InBrowser) return
        this.pending = null
        mutableState.value = CloudAccountState.Finishing
        scope.launch {
            mutableState.value = try {
                val (grant, _) = auth.complete(pending, uri)
                // No refresh token is kept, or expected: the pass is the access token, for its hour.
                access = AccessToken(grant.access.value, grant.access.expiresAtMillis ?: (now() + PASS_MILLIS))
                CloudAccountState.SignedIn
            } catch (e: CancellationException) {
                throw e
            } catch (e: ServerAuthException) {
                CloudAccountState.Failed(e.reason)
            } catch (_: Exception) {
                CloudAccountState.Failed(ServerAuthException.Reason.Unreachable)
            }
        }
    }

    /** After a failure, or the page closed: back to signed out, to sign in again. */
    fun reset() {
        pending = null
        if (mutableState.value != CloudAccountState.SignedIn) mutableState.value = CloudAccountState.SignedOut()
    }

    /** Whether the pass is still good; one whose hour is (nearly) up signs the account out now, as the picker opens. */
    fun signedIn(): Boolean {
        if (mutableState.value != CloudAccountState.SignedIn) return false
        if (access?.let(::fresh) == true) return true
        expire()
        return false
    }

    /** The pass is over: its hour is up, or the service refused it. */
    private fun expire() {
        access = null
        pending = null
        mutableState.value = CloudAccountState.SignedOut(expired = true)
    }

    suspend fun servers(): List<CloudServer> {
        val body = call("GET", "/v1/servers").second
        return json.decodeFromJsonElement(ServerList.serializer(), body).servers
    }

    suspend fun availability(name: String): CloudName {
        val body = call("GET", "/v1/servers/availability?name=${java.net.URLEncoder.encode(name, "UTF-8")}").second
        if ((body["available"] as? JsonPrimitive)?.booleanOrNull == true) return CloudName.Available
        return when ((body["reason"] as? JsonPrimitive)?.contentOrNull) {
            "taken" -> CloudName.Taken
            "reserved" -> CloudName.Reserved
            else -> CloudName.Invalid
        }
    }

    /** A new server named [name], the person its owner. */
    suspend fun create(name: String): CloudServer = server(call("POST", "/v1/servers", JsonObject(mapOf("name" to JsonPrimitive(name)))).second)

    /** Joins [name] with an owner's invite [code]. A wrong name or code is NotFound, the same for both. */
    suspend fun join(name: String, code: String): CloudServer =
        server(call("POST", "/v1/servers/join", JsonObject(mapOf("name" to JsonPrimitive(name), "code" to JsonPrimitive(code)))).second)

    /**
     * A token for the Happy Cloud server at [origin] (`POST
     * /v1/servers/:id/token` with the account token, no browser), and the
     * credential its connection keeps, the long-lived session: refreshed with
     * the accounts service's `refresh_token` grant, `resource` the server, and
     * no account token. [id] is the
     * server's when known; otherwise it is found in the account's servers.
     * Throws [ServerAuthException], as a browser sign-in would.
     */
    suspend fun serverToken(origin: AgentOrigin, id: String? = null): Pair<OAuthGrant, OAuthCredential> {
        val body = try {
            val server = id ?: servers().firstOrNull { it.origin == origin.value }?.id ?: throw CloudException(CloudException.Reason.NotFound)
            call("POST", "/v1/servers/${java.net.URLEncoder.encode(server, "UTF-8")}/token", JsonObject(emptyMap())).second
        } catch (e: CloudException) {
            throw ServerAuthException(
                when (e.reason) {
                    CloudException.Reason.SignInRequired -> ServerAuthException.Reason.SignInRequired
                    CloudException.Reason.Unreachable -> ServerAuthException.Reason.Unreachable
                    else -> ServerAuthException.Reason.Denied
                },
                e,
            )
        }
        fun text(key: String) = (body[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        val access = text("access_token") ?: throw ServerAuthException(ServerAuthException.Reason.InvalidToken)
        val expiresIn = (body["expires_in"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()?.takeIf { it > 0 }
        if (!ServerAuthClient.audienceIs(access, origin)) throw ServerAuthException(ServerAuthException.Reason.WrongAudience)
        val refresh = text("refresh_token")
        return OAuthGrant(AccessToken(access, expiresIn?.let { now() + it * 1000 }), refresh) to
            OAuthCredential(methodId = method.id, clientId = method.clientId, refreshUrl = method.tokenUrl, refreshToken = refresh, resource = "${origin.value}/")
    }

    /**
     * A server picture's bytes, kept in memory: its URL names its digest, so
     * it never changes. Null when it can't be had. The account token goes
     * only to the accounts origin, so a URL anywhere else isn't asked.
     */
    suspend fun image(url: String): ByteArray? {
        synchronized(images) { images.get(url) }?.let { return it }
        val target = url.toHttpUrlOrNull()?.takeIf { it.scheme == "https" && it.host == origin.host && it.port == origin.port } ?: return null
        val bytes = try {
            val answer = fetch(target.toString(), bearer())
            if (answer.first == 401) expire()
            answer.second.takeIf { answer.first == 200 }
        } catch (_: CloudException) {
            null
        } ?: return null
        synchronized(images) { images.put(url, bytes) }
        return bytes
    }

    private val images = android.util.LruCache<String, ByteArray>(32)

    private suspend fun fetch(url: String, token: String): Pair<Int, ByteArray?> = withContext(Dispatchers.IO) {
        try {
            http.newCall(Request.Builder().url(url).header("Authorization", "Bearer $token").build()).execute().use { response ->
                response.code to (if (response.isSuccessful) response.body.bytes().takeIf { it.size <= MAX_IMAGE } else null)
            }
        } catch (e: IOException) {
            throw CloudException(CloudException.Reason.Unreachable).initCause(e)
        }
    }

    private fun server(body: JsonObject): CloudServer =
        json.decodeFromJsonElement(CloudServer.serializer(), body["server"]?.jsonObject ?: throw CloudException(CloudException.Reason.Failed))

    /** One accounts API request. A 401 is the pass over: signed out, never retried. */
    private suspend fun call(verb: String, path: String, body: JsonObject? = null): Pair<Int, JsonObject> {
        val answer = send(verb, path, body, bearer())
        if (answer.first == 401) {
            expire()
            throw CloudException(CloudException.Reason.SignInRequired)
        }
        val (status, root) = answer
        if (status in 200..299) return status to (root ?: throw CloudException(CloudException.Reason.Failed))
        throw CloudException(
            when ((root?.get("code") as? JsonPrimitive)?.contentOrNull) {
                "taken" -> CloudException.Reason.Taken
                "invalid" -> CloudException.Reason.Invalid
                "not_found" -> CloudException.Reason.NotFound
                else -> if (status >= 500) CloudException.Reason.Unreachable else CloudException.Reason.Failed
            },
        )
    }

    private suspend fun send(verb: String, path: String, body: JsonObject?, token: String): Pair<Int, JsonObject?> = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${origin.value}$path")
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $token")
            .method(verb, body?.let { json.encodeToString(JsonObject.serializer(), it).toRequestBody("application/json".toMediaType()) })
            .build()
        try {
            http.newCall(request).execute().use { response ->
                response.code to runCatching { json.parseToJsonElement(response.peekBody(MAX_BODY).string()) as? JsonObject }.getOrNull()
            }
        } catch (e: IOException) {
            throw CloudException(CloudException.Reason.Unreachable).initCause(e)
        }
    }

    private fun bearer(): String = access?.takeIf(::fresh)?.value ?: run {
        expire()
        throw CloudException(CloudException.Reason.SignInRequired)
    }

    /** Good for a while yet: a pass with under two minutes left won't see a create or join through. */
    private fun fresh(token: AccessToken) = token.expiresAtMillis == null || token.expiresAtMillis - now() > EXPIRY_MARGIN_MILLIS

    @Serializable private class ServerList(val servers: List<CloudServer>)

    companion object {
        private const val MAX_BODY = 1024L * 1024
        private const val MAX_IMAGE = 8 * 1024 * 1024
        private const val EXPIRY_MARGIN_MILLIS = 120_000L
        /** The pass's life when the token endpoint doesn't say (contract v4: an hour). */
        private const val PASS_MILLIS = 3_600_000L
        private val json = Json { ignoreUnknownKeys = true }
    }
}
