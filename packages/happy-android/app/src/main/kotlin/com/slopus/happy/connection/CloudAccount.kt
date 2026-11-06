package com.slopus.happy.connection

import com.slopus.happy.auth.ExpoSecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A server the account is on (`GET /v1/servers`). */
@Serializable
data class CloudServer(val id: String, val name: String, val url: String, val role: String, val createdAt: String? = null) {
    /** The server's origin, as its connection keeps it; null for a URL that isn't one. */
    val origin: String? get() = runCatching { ServerAuthClient.parseAddress(url).value }.getOrNull()
    val owner: Boolean get() = role == "owner"
}

/** What `GET /v1/servers/availability` says of a name. */
enum class CloudName { Available, Taken, Reserved, Invalid }

/** Why an accounts API call failed, from its `code` where it gave one. */
class CloudException(val reason: Reason) : Exception(reason.name) {
    enum class Reason { Taken, Invalid, NotFound, SignInRequired, Unreachable, Failed }
}

/** Where the Happy Cloud account stands. */
sealed interface CloudAccountState {
    data object SignedOut : CloudAccountState

    /** The account's sign-in page is open; the app waits for it to come back. */
    data object InBrowser : CloudAccountState

    data object Finishing : CloudAccountState

    data object SignedIn : CloudAccountState

    data class Failed(val reason: ServerAuthException.Reason) : CloudAccountState
}

/**
 * The person's Happy Cloud account (accounts contract v1) at [origin], the
 * accounts service: signed in with the authorization code flow and PKCE in
 * the system browser, `resource` the accounts origin, so the browser keeps
 * the account's session for the servers' sign-ins after it. Its refresh
 * token is kept Keystore-encrypted in [secrets], beside the servers'; the
 * access token stays in memory. The account token goes only to [origin],
 * never to a server.
 */
class CloudAccount(
    private val scope: CoroutineScope,
    val origin: AgentOrigin,
    private val auth: ServerAuthClient,
    http: OkHttpClient,
    private val secrets: ExpoSecureStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val http = http.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val mutableState = MutableStateFlow(if (KEY in secrets.keys()) CloudAccountState.SignedIn else CloudAccountState.SignedOut)
    val state: StateFlow<CloudAccountState> = mutableState.asStateFlow()

    private var pending: PendingOAuth? = null
    private var access: AccessToken? = null
    private val refreshing = Mutex()

    /** The accounts service's own sign-in: the contract fixes its endpoints, so nothing is discovered. */
    private val method = OAuthMethod(
        id = "happy-accounts",
        name = "Happy Cloud",
        authorizationUrl = "${origin.value}/authorize",
        tokenUrl = "${origin.value}/token",
        refreshUrl = "${origin.value}/token",
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
                val (grant, credential) = auth.complete(pending, uri)
                withContext(Dispatchers.IO) { secrets.setItem(KEY, json.encodeToString(OAuthCredential.serializer(), credential)) }
                access = grant.access
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
        if (mutableState.value != CloudAccountState.SignedIn) mutableState.value = CloudAccountState.SignedOut
    }

    fun signOut() {
        access = null
        pending = null
        secrets.deleteItem(KEY)
        mutableState.value = CloudAccountState.SignedOut
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

    private fun server(body: JsonObject): CloudServer =
        json.decodeFromJsonElement(CloudServer.serializer(), body["server"]?.jsonObject ?: throw CloudException(CloudException.Reason.Failed))

    /** One accounts API request; a 401 refreshes the token once and asks again, and a second signs the account out. */
    private suspend fun call(verb: String, path: String, body: JsonObject? = null): Pair<Int, JsonObject> {
        val token = bearer()
        var answer = send(verb, path, body, token)
        if (answer.first == 401) answer = send(verb, path, body, refresh(stale = token))
        if (answer.first == 401) {
            signOut()
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

    private suspend fun bearer(): String = access?.takeIf(::fresh)?.value ?: refresh(stale = null)

    private fun fresh(token: AccessToken) = token.expiresAtMillis == null || token.expiresAtMillis - now() > REFRESH_MARGIN_MILLIS

    /** A new access token, unless another request already got one newer than [stale]. Signs out when the refresh token is refused. */
    private suspend fun refresh(stale: String?): String = refreshing.withLock {
        access?.takeIf { it.value != stale && fresh(it) }?.let { return@withLock it.value }
        val credential = withContext(Dispatchers.IO) { readCredential() } ?: run {
            signOut()
            throw CloudException(CloudException.Reason.SignInRequired)
        }
        val (token, next) = try {
            auth.refresh(credential, origin)
        } catch (e: ServerAuthException) {
            if (e.reason == ServerAuthException.Reason.Unreachable) throw CloudException(CloudException.Reason.Unreachable).initCause(e)
            signOut()
            throw CloudException(CloudException.Reason.SignInRequired).initCause(e)
        }
        // A rotated refresh token: the old one may already be spent.
        if (next != credential) withContext(Dispatchers.IO) { secrets.setItem(KEY, json.encodeToString(OAuthCredential.serializer(), next)) }
        access = token
        token.value
    }

    private fun readCredential(): OAuthCredential? = try {
        secrets.getItem(KEY)?.let { json.decodeFromString(OAuthCredential.serializer(), it) }
    } catch (_: Exception) {
        null
    }

    @Serializable private class ServerList(val servers: List<CloudServer>)

    companion object {
        /** The account's keychain service, in the servers' prefs file ([AgentConnections.SECRETS_PREFS]) under its own prefix. */
        const val KEYCHAIN_SERVICE = "happy-cloud-account"
        private const val KEY = "account"
        private const val MAX_BODY = 1024L * 1024
        private const val REFRESH_MARGIN_MILLIS = 60_000L
        private val json = Json { ignoreUnknownKeys = true }
    }
}
