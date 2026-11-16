package com.slopus.happy.connection

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
import okhttp3.HttpUrl.Companion.toHttpUrl
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
    /** The account's role there; the accounts service no longer lists it since roles moved to the server (`GET /v0/permissions`). */
    val role: String? = null,
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

/** A server's picture: its ThumbHash to paint first, and its bytes at [url] on the API's origin, with the account's session. */
@Serializable
data class CloudServerImage(val thumbhash: String? = null, val width: Int? = null, val height: Int? = null, val url: String)

/**
 * A way to sign in to the account, by the accounts service's `provider`
 * hint. Apple and GitHub are web sign-ins on Android (Apple has no native
 * one here). Google signs in on the phone through Credential Manager
 * ([CloudAccount.signInWithGoogle]), and on the web where it has no account
 * to offer. Email is no provider: its code is asked for and typed in the
 * app ([CloudAccount.startEmail], [CloudAccount.verifyEmail]).
 */
enum class CloudProvider(val id: String) { Apple("apple"), GitHub("github"), Google("google") }

/** What `GET /v1/servers/availability` says of a name. */
enum class CloudName { Available, Taken, Reserved, Invalid }

/** Why a Happy Cloud call failed, from its `code` where it gave one. */
class CloudException(val reason: Reason) : Exception(reason.name) {
    enum class Reason { Taken, Invalid, NotFound, SignInRequired, Unreachable, Failed }
}

/** How a test account's password sign-in went ([CloudAccount.signInWithPassword]). */
sealed interface PasswordSignIn {
    data object SignedIn : PasswordSignIn

    /** A wrong login or password, or a disabled account: the service says the same for all three. */
    data object Wrong : PasswordSignIn

    /** Too many wrong tries; it opens again in [minutes]. */
    data class Locked(val minutes: Long) : PasswordSignIn

    data class Failed(val reason: CloudException.Reason) : PasswordSignIn
}

/** How asking for an email code ([CloudAccount.startEmail]) or typing it ([CloudAccount.verifyEmail]) went. */
sealed interface EmailSignIn {
    /** The code is on its way to the address. */
    data object Sent : EmailSignIn

    data object SignedIn : EmailSignIn

    /** `invalid_email`: not an address the service takes. */
    data object InvalidEmail : EmailSignIn

    /** `invalid_code`: wrong, or expired; the service doesn't say which. */
    data object InvalidCode : EmailSignIn

    /** `unavailable`: the service couldn't reach its email sign-in just now. */
    data object Unavailable : EmailSignIn

    /** `unsupported_provider`: this service has no email sign-in; [message] is its own words, shown as they came. */
    data class Unsupported(val message: String?) : EmailSignIn

    /** `429 rate_limited`: nothing more for [seconds]; [message] is the service's own words. */
    data class RateLimited(val seconds: Long, val message: String?) : EmailSignIn

    data class Failed(val reason: CloudException.Reason) : EmailSignIn
}

/** Where the Happy Cloud account stands. */
sealed interface CloudAccountState {
    /** [expired]: it was signed in, and its session ended (its refresh was refused, or the API refused it twice). */
    data class SignedOut(val expired: Boolean = false) : CloudAccountState

    /** The account's sign-in page is open; the app waits for it to come back. */
    data object InBrowser : CloudAccountState

    data object Finishing : CloudAccountState

    data object SignedIn : CloudAccountState

    data class Failed(val reason: ServerAuthException.Reason) : CloudAccountState
}

/**
 * The person's Happy Cloud account (accounts split, contract v1). [origin],
 * the accounts service, only signs them in: the authorization code flow
 * and PKCE in the system browser (`scope=openid`, no `resource`), or its
 * `/v2/auth` routes with no browser, for a five-minute identity token whose
 * `aud` names this app (`happy`). [api], the cluster's, turns that into the
 * account's session (`POST /v1/session`): an access token and a rotating
 * refresh token, held in memory only, for picking, creating or joining
 * servers, each of which then gets a server token of its own
 * ([serverToken]), the long-lived session. The access token is refreshed at
 * [api]'s `/token` as it runs out and once on a 401; a refresh refused, or
 * a second 401, signs the account out ([CloudAccountState.SignedOut]
 * `expired`), while one that couldn't be asked (offline, a 5xx, a 429)
 * keeps it. The session goes only to [api], never to a server or [origin].
 */
class CloudAccount(
    private val scope: CoroutineScope,
    val origin: AgentOrigin,
    val api: AgentOrigin,
    private val auth: ServerAuthClient,
    http: OkHttpClient,
    private val now: () -> Long = System::currentTimeMillis,
) : CloudInviteService {
    private val http = http.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val mutableState = MutableStateFlow<CloudAccountState>(CloudAccountState.SignedOut())
    override val state: StateFlow<CloudAccountState> = mutableState.asStateFlow()

    private var pending: PendingOAuth? = null
    @Volatile private var session: Session? = null
    /** One refresh of the session at a time: the refresh token rotates, and a reused one ends it. */
    private val refreshing = Mutex()

    /** The account's session at [api]; its refresh token is good until [liveUntil], 30 days from the sign-in. */
    private class Session(val access: AccessToken, val refreshToken: String?, val liveUntil: Long)

    /** The accounts service's identity-only sign-in: the contract fixes its endpoints, so nothing is discovered. */
    private val method = OAuthMethod(
        id = "happy-accounts",
        name = "Happy Cloud",
        authorizationUrl = "${origin.value}/authorize",
        tokenUrl = "${origin.value}/token",
        clientId = CLIENT_ID,
        scope = "openid",
    )

    /** Where every Happy Cloud session refreshes, the account's and its servers' alike. */
    private val tokenUrl = "${api.value}/token"

    /**
     * [provider]'s sign-in, starting a fresh one each time: the PKCE request
     * with `provider=apple`, `github` or `google`, which makes the accounts
     * service skip its chooser and redirect straight to that provider (an
     * unknown provider shows the chooser).
     */
    fun browserUrl(provider: CloudProvider): String {
        val next = auth.begin(origin, method, ServerSignInFlow.REDIRECT_URI)
        pending = next
        mutableState.value = CloudAccountState.InBrowser
        return next.authorizeUrl.toHttpUrl().newBuilder().addQueryParameter("provider", provider.id).build().toString()
    }

    /** The browser came back to the redirect URI with [uri]; one that isn't this sign-in's is ignored. */
    fun callback(uri: String) {
        val pending = pending ?: return
        if (!pending.isCallback(uri) || ServerAuthClient.query(uri)?.get("state") != pending.state || mutableState.value != CloudAccountState.InBrowser) return
        this.pending = null
        mutableState.value = CloudAccountState.Finishing
        scope.launch {
            mutableState.value = try {
                startSession(auth.identity(pending, uri))
            } catch (e: CancellationException) {
                throw e
            } catch (e: ServerAuthException) {
                CloudAccountState.Failed(e.reason)
            } catch (_: Exception) {
                CloudAccountState.Failed(ServerAuthException.Reason.Unreachable)
            }
        }
    }

    /**
     * Signs in with a test account's [login] and [password] (`POST
     * /v2/auth/password`, no browser), for the same session as the
     * browser's sign-in. Test accounts exist only when an operator makes one.
     * The password goes to [origin] in this one request and is kept nowhere.
     */
    suspend fun signInWithPassword(login: String, password: String): PasswordSignIn {
        val (status, body) = try {
            send("POST", origin, "/v2/auth/password", JsonObject(mapOf("login" to JsonPrimitive(login), "password" to JsonPrimitive(password))), token = null)
        } catch (e: CloudException) {
            return PasswordSignIn.Failed(e.reason)
        }
        return when {
            status == 200 -> signedInWith(body)?.let { PasswordSignIn.Failed(it) } ?: PasswordSignIn.SignedIn
            status == 429 -> PasswordSignIn.Locked((((body?.get("retryAfter") as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: LOCKOUT_SECONDS) + 59) / 60)
            status == 401 || status == 400 -> PasswordSignIn.Wrong
            status >= 500 -> PasswordSignIn.Failed(CloudException.Reason.Unreachable)
            else -> PasswordSignIn.Failed(CloudException.Reason.Failed)
        }
    }

    /**
     * Signs in with Google on the phone: [credential] asks Credential Manager
     * for an ID token bound to a fresh random nonce, and `POST
     * /v2/auth/native` trades it, with the same raw nonce, for an identity
     * token and so the same session as the browser's. The
     * welcome waits ([CloudAccountState.Finishing]) from the sheet's opening
     * to the answer; a cancel goes back to signed out, saying nothing. Returns
     * false when the phone had no Google sign-in to offer (no account, no
     * Google Play services), for the browser's instead.
     */
    suspend fun signInWithGoogle(credential: suspend (nonce: String) -> GoogleCredential): Boolean {
        // A second press before the first one's sheet: that one goes on.
        if (mutableState.value == CloudAccountState.Finishing) return true
        pending = null
        mutableState.value = CloudAccountState.Finishing
        try {
            val nonce = nonce()
            val got = credential(nonce)
            mutableState.value = when (got) {
                is GoogleCredential.Token -> signInNatively(CloudProvider.Google, got.idToken, nonce)
                GoogleCredential.Cancelled, GoogleCredential.Unavailable -> CloudAccountState.SignedOut()
                GoogleCredential.Failed -> CloudAccountState.Failed(ServerAuthException.Reason.Denied)
            }
            return got != GoogleCredential.Unavailable
        } finally {
            // Left before an answer (the screen went): not waiting any more.
            if (mutableState.value == CloudAccountState.Finishing) mutableState.value = CloudAccountState.SignedOut()
        }
    }

    /** `POST /v2/auth/native`: a 401 is the ID token refused, never a session ending; nothing was signed in yet. */
    private suspend fun signInNatively(provider: CloudProvider, idToken: String, nonce: String): CloudAccountState {
        val body = JsonObject(mapOf("provider" to JsonPrimitive(provider.id), "idToken" to JsonPrimitive(idToken), "nonce" to JsonPrimitive(nonce)))
        val (status, root) = try {
            send("POST", origin, "/v2/auth/native", body, token = null)
        } catch (_: CloudException) {
            return CloudAccountState.Failed(ServerAuthException.Reason.Unreachable)
        }
        return when {
            status == 200 -> try {
                startSession(ServerAuthClient.identityToken(root, CLIENT_ID))
            } catch (e: ServerAuthException) {
                CloudAccountState.Failed(e.reason)
            }
            status == 401 -> CloudAccountState.Failed(ServerAuthException.Reason.Rejected)
            status >= 500 -> CloudAccountState.Failed(ServerAuthException.Reason.Unreachable)
            else -> CloudAccountState.Failed(ServerAuthException.Reason.Denied)
        }
    }

    /**
     * The account's session for [idToken] (`POST /v1/session` at [api]),
     * its access token checked to be [api]'s. A 401 is the identity token
     * refused (`invalid_token`); nothing was signed in yet.
     */
    private suspend fun startSession(idToken: String): CloudAccountState {
        val (status, root) = try {
            send("POST", api, "/v1/session", JsonObject(mapOf("id_token" to JsonPrimitive(idToken))), token = null)
        } catch (_: CloudException) {
            return CloudAccountState.Failed(ServerAuthException.Reason.Unreachable)
        }
        fun field(key: String) = (root?.get(key) as? JsonPrimitive)?.contentOrNull
        return when {
            status == 200 -> {
                val token = field("access_token")?.takeIf { it.isNotEmpty() } ?: return CloudAccountState.Failed(ServerAuthException.Reason.InvalidToken)
                if (!ServerAuthClient.audienceIs(token, api)) return CloudAccountState.Failed(ServerAuthException.Reason.WrongAudience)
                val life = field("expires_in")?.toLongOrNull()?.takeIf { it > 0 }?.let { it * 1000 } ?: ACCESS_MILLIS
                session = Session(AccessToken(token, now() + life), field("refresh_token")?.takeIf { it.isNotEmpty() }, now() + SESSION_MILLIS)
                pending = null
                CloudAccountState.SignedIn
            }
            status == 401 -> CloudAccountState.Failed(ServerAuthException.Reason.Rejected)
            status >= 500 || status == 429 -> CloudAccountState.Failed(ServerAuthException.Reason.Unreachable)
            else -> CloudAccountState.Failed(ServerAuthException.Reason.Denied)
        }
    }

    /**
     * Emails a one-time code to [email] (`POST /v2/auth/email/start`, no
     * browser), for [verifyEmail]. Asking again sends a new one.
     */
    suspend fun startEmail(email: String): EmailSignIn {
        val answer = try {
            send("POST", origin, "/v2/auth/email/start", JsonObject(mapOf("email" to JsonPrimitive(email))), token = null)
        } catch (e: CloudException) {
            return EmailSignIn.Failed(e.reason)
        }
        return if (answer.status in 200..299) EmailSignIn.Sent else emailRefusal(answer)
    }

    /**
     * Signs in with the [code] emailed to [email] (`POST
     * /v2/auth/email/verify`), for the same session as the browser's
     * sign-in, as the password's is.
     */
    suspend fun verifyEmail(email: String, code: String): EmailSignIn {
        val answer = try {
            send("POST", origin, "/v2/auth/email/verify", JsonObject(mapOf("email" to JsonPrimitive(email), "code" to JsonPrimitive(code))), token = null)
        } catch (e: CloudException) {
            return EmailSignIn.Failed(e.reason)
        }
        if (answer.status == 200) return signedInWith(answer.body)?.let { EmailSignIn.Failed(it) } ?: EmailSignIn.SignedIn
        return emailRefusal(answer)
    }

    /** Why the email sign-in said no, by its `code`; a 429 waits for `Retry-After`, or its `retryAfter`. */
    private fun emailRefusal(answer: Answer): EmailSignIn {
        fun field(key: String) = (answer.body?.get(key) as? JsonPrimitive)?.contentOrNull
        val message = field("error")?.takeIf { it.isNotBlank() }
        return when {
            answer.status == 429 -> EmailSignIn.RateLimited(answer.retryAfter ?: field("retryAfter")?.toLongOrNull()?.takeIf { it > 0 } ?: EMAIL_WAIT_SECONDS, message)
            field("code") == "invalid_email" -> EmailSignIn.InvalidEmail
            field("code") == "invalid_code" -> EmailSignIn.InvalidCode
            field("code") == "unsupported_provider" -> EmailSignIn.Unsupported(message)
            field("code") == "unavailable" -> EmailSignIn.Unavailable
            answer.status >= 500 -> EmailSignIn.Failed(CloudException.Reason.Unreachable)
            else -> EmailSignIn.Failed(CloudException.Reason.Failed)
        }
    }

    /** A password's or email code's `{id_token}` answer, traded for the session as the browser's is; why not, when it couldn't be. */
    private suspend fun signedInWith(body: JsonObject?): CloudException.Reason? {
        val state = try {
            startSession(ServerAuthClient.identityToken(body, CLIENT_ID))
        } catch (_: ServerAuthException) {
            return CloudException.Reason.Failed
        }
        if (state is CloudAccountState.Failed) {
            return if (state.reason == ServerAuthException.Reason.Unreachable) CloudException.Reason.Unreachable else CloudException.Reason.Failed
        }
        mutableState.value = state
        return null
    }

    /** After a failure, or the page closed: back to signed out, to sign in again. */
    fun reset() {
        pending = null
        if (mutableState.value != CloudAccountState.SignedIn) mutableState.value = CloudAccountState.SignedOut()
    }

    /**
     * Whether the session is still good: its access token, or a refresh
     * token in its 30 days. One that is over signs the account out now, as
     * the picker opens.
     */
    fun signedIn(): Boolean {
        if (mutableState.value != CloudAccountState.SignedIn) return false
        if (session?.let { fresh(it.access) || (it.refreshToken != null && now() < it.liveUntil) } == true) return true
        expire()
        return false
    }

    /**
     * "Sign out of Happy Cloud": the session is revoked at [api] (best
     * effort) and forgotten; servers already on the phone stay signed in.
     */
    fun signOut() {
        val ended = session
        session = null
        pending = null
        mutableState.value = CloudAccountState.SignedOut()
        ended?.refreshToken?.let { revoke(it, CLIENT_ID) }
    }

    /** The session is over: its refresh was refused, or the API refused it twice. */
    private fun expire() {
        session = null
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

    /**
     * What [invite] opens (`POST /v1/invites/preview`, no session, so it
     * reads before the sign-in): the server and the role it gives.
     * Throws [CloudInviteException] for an invite that can't be used.
     */
    override suspend fun previewInvite(invite: CloudInvite): CloudInvitePreview {
        val answer = send("POST", api, "/v1/invites/preview", JsonObject(mapOf("token" to JsonPrimitive(invite.token))), token = null)
        val body = inviteAnswer(answer)
        fun text(obj: JsonObject?, key: String) = (obj?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
        val server = body["server"] as? JsonObject
        val name = text(server, "name") ?: throw CloudException(CloudException.Reason.Failed)
        // Its picture comes inline, as a data: URL; the server has no id or address until the accept.
        val image = text(server, "image")?.let { CloudServerImage(url = it) }
        val inviter = (body["inviter"] as? JsonObject)?.let { who -> text(who, "name")?.let { CloudInviter(it, text(who, "image")) } }
        return CloudInvitePreview(CloudServer(id = "", name = name, url = "", displayName = text(server, "displayName"), image = image), text(body, "roleName"), inviter)
    }

    /** Accepts [invite] for the signed-in account (`POST /v1/invites/accept`): the server it is on now. */
    override suspend fun acceptInvite(invite: CloudInvite): CloudServer =
        server(inviteAnswer(authorized("POST", "/v1/invites/accept", JsonObject(mapOf("token" to JsonPrimitive(invite.token))))))

    /** An invite call's body, or why it was refused: the invite's own reasons as [CloudInviteException], the rest as [CloudException]. */
    private fun inviteAnswer(answer: Answer): JsonObject {
        val body = answer.body
        if (answer.status in 200..299) return body ?: throw CloudException(CloudException.Reason.Failed)
        fun field(key: String) = (body?.get(key) as? JsonPrimitive)?.contentOrNull
        val refusal = when (field("code")) {
            "expired" -> CloudInviteRefusal.Expired
            "revoked" -> CloudInviteRefusal.Revoked
            "exhausted", "accepted" -> CloudInviteRefusal.UsedUp
            "invalid" -> CloudInviteRefusal.Unknown
            "email_mismatch" -> CloudInviteRefusal.EmailMismatch(field("emailHint")?.takeIf { it.isNotBlank() })
            else -> null
        }
        if (refusal != null) throw CloudInviteException(refusal)
        throw CloudException(if (answer.status >= 500) CloudException.Reason.Unreachable else CloudException.Reason.Failed)
    }

    /**
     * A token for the Happy Cloud server at [origin] (`POST
     * /v1/servers/:id/token` under the account's session, no browser), and
     * the credential its connection keeps, the long-lived session: refreshed
     * with [api]'s `refresh_token` grant, `resource` the server, and no
     * account session. [id] is the
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
            OAuthCredential(methodId = method.id, clientId = method.clientId, refreshUrl = tokenUrl, refreshToken = refresh, resource = "${origin.value}/")
    }

    /**
     * Whether [credential] is a session [api] issued, refreshed at its
     * `/token`. A cloud server's credential from an earlier build (refreshed
     * at the accounts service, which no longer does) isn't: the launch ends
     * it ([AgentConnections.endSessions], accounts contract C9).
     */
    fun issued(credential: OAuthCredential): Boolean = credential.refreshUrl == tokenUrl

    /**
     * Revokes a cloud server's session (RFC 7009 `POST /revoke` at [api],
     * the refresh token and `client_id`, no account session) as the person
     * removes it from the phone. Only a credential [api] issued is sent
     * there; any other is no business of this service.
     */
    fun revoke(credential: OAuthCredential) {
        val token = credential.refreshToken ?: return
        if (!issued(credential)) return
        revoke(token, credential.clientId)
    }

    /** Best effort, in the account's scope, so nothing waits on it. */
    private fun revoke(token: String, clientId: String) {
        scope.launch(Dispatchers.IO) {
            val form = okhttp3.FormBody.Builder().add("token", token).add("token_type_hint", "refresh_token").add("client_id", clientId).build()
            try {
                http.newCall(Request.Builder().url("${api.value}/revoke").post(form).build()).execute().close()
            } catch (_: IOException) {
                // Offline: the refresh token still runs out in its 30 days, and the person can sign out everywhere.
            }
        }
    }

    private fun segment(id: String) = java.net.URLEncoder.encode(id, "UTF-8")

    /**
     * A server picture's bytes, kept in memory: its URL names its digest, so
     * it never changes. Null when it can't be had. The account's session goes
     * only to [api], so a URL anywhere else isn't asked.
     */
    suspend fun image(url: String): ByteArray? {
        synchronized(images) { images.get(url) }?.let { return it }
        val target = url.toHttpUrlOrNull()?.takeIf { it.scheme == "https" && it.host == api.host && it.port == api.port } ?: return null
        val bytes = try {
            val used = bearer()
            var answer = fetch(target.toString(), used)
            if (answer.first == 401) answer = fetch(target.toString(), renew(used))
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

    /** One API request under the account's session ([authorized]), its body or why not. */
    private suspend fun call(verb: String, path: String, body: JsonObject? = null): Pair<Int, JsonObject> {
        val (status, root) = authorized(verb, path, body)
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

    /**
     * One request to [api] under the account's session: refreshed first
     * when its access token is (nearly) up, and once on a 401, then sent
     * again. A second 401 ends the session.
     */
    private suspend fun authorized(verb: String, path: String, body: JsonObject?): Answer {
        val used = bearer()
        val answer = send(verb, api, path, body, used)
        if (answer.status != 401) return answer
        val again = send(verb, api, path, body, renew(used))
        if (again.status == 401) {
            expire()
            throw CloudException(CloudException.Reason.SignInRequired)
        }
        return again
    }

    /** An API answer: its status, its JSON object if it was one, and a `Retry-After` in seconds. */
    private data class Answer(val status: Int, val body: JsonObject?, val retryAfter: Long? = null)

    private suspend fun send(verb: String, at: AgentOrigin, path: String, body: JsonObject?, token: String?): Answer = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${at.value}$path")
            .header("Accept", "application/json")
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .method(verb, body?.let { json.encodeToString(JsonObject.serializer(), it).toRequestBody("application/json".toMediaType()) })
            .build()
        try {
            http.newCall(request).execute().use { response ->
                Answer(
                    response.code,
                    runCatching { json.parseToJsonElement(response.peekBody(MAX_BODY).string()) as? JsonObject }.getOrNull(),
                    response.header("Retry-After")?.trim()?.toLongOrNull()?.takeIf { it > 0 },
                )
            }
        } catch (e: IOException) {
            throw CloudException(CloudException.Reason.Unreachable).initCause(e)
        }
    }

    /** The session's access token, refreshed first when it is (nearly) up. */
    private suspend fun bearer(): String {
        val current = session ?: run {
            expire()
            throw CloudException(CloudException.Reason.SignInRequired)
        }
        return current.access.takeIf(::fresh)?.value ?: renew(current.access.value)
    }

    /**
     * A new access token after [stale], from the session's refresh token at
     * [api]'s `/token` (rotating it), unless another call already got one.
     * Refused (`invalid_grant`, a wrong token): the session is over and the
     * account signed out. Couldn't ask (offline, a 5xx, a 429): Unreachable,
     * the session kept for the next try.
     */
    private suspend fun renew(stale: String): String = refreshing.withLock {
        val current = session ?: run {
            expire()
            throw CloudException(CloudException.Reason.SignInRequired)
        }
        if (current.access.value != stale && fresh(current.access)) return@withLock current.access.value
        val refreshToken = current.refreshToken?.takeIf { now() < current.liveUntil } ?: run {
            expire()
            throw CloudException(CloudException.Reason.SignInRequired)
        }
        val credential = OAuthCredential(methodId = method.id, clientId = CLIENT_ID, refreshUrl = tokenUrl, refreshToken = refreshToken, resource = "${api.value}/")
        val (access, next) = try {
            auth.refresh(credential, api)
        } catch (e: ServerAuthException) {
            if (e.reason == ServerAuthException.Reason.Unreachable) throw CloudException(CloudException.Reason.Unreachable).initCause(e)
            // Only this session ends; a sign-in that landed meanwhile stands.
            if (session === current) expire()
            throw CloudException(CloudException.Reason.SignInRequired).initCause(e)
        }
        // Signed out, or in again, while it was out: this one is dropped.
        if (session !== current) return@withLock session?.access?.value ?: throw CloudException(CloudException.Reason.SignInRequired)
        session = Session(AccessToken(access.value, access.expiresAtMillis ?: (now() + ACCESS_MILLIS)), next.refreshToken, current.liveUntil)
        access.value
    }

    /** Good for a while yet: an access token with under two minutes left won't see a create or join through. */
    private fun fresh(token: AccessToken) = token.expiresAtMillis == null || token.expiresAtMillis - now() > EXPIRY_MARGIN_MILLIS

    @Serializable private class ServerList(val servers: List<CloudServer>)


    companion object {
        private const val MAX_BODY = 1024L * 1024
        private const val MAX_IMAGE = 8 * 1024 * 1024
        private const val EXPIRY_MARGIN_MILLIS = 120_000L
        /** The app's client id at the accounts service, and the `aud` its identity tokens name. */
        const val CLIENT_ID = "happy"
        /** The session's access token's life when [api] doesn't say (an hour). */
        private const val ACCESS_MILLIS = 3_600_000L
        /** A session's refresh token's life: 30 days from the sign-in, rotations or not. */
        private const val SESSION_MILLIS = 30L * 24 * 3_600_000
        /** A lockout's length when a 429 doesn't say (test accounts: 15 minutes). */
        private const val LOCKOUT_SECONDS = 900L
        /** An email 429's wait when it says none: a resend's own cooldown. */
        private const val EMAIL_WAIT_SECONDS = 60L
        private val json = Json { ignoreUnknownKeys = true }

        /** A native sign-in's nonce: 32 random bytes, base64url. Google puts it in the ID token as given, and the service checks it is the one sent. */
        internal fun nonce(): String {
            val bytes = ByteArray(32).also(java.security.SecureRandom()::nextBytes)
            return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
    }
}
