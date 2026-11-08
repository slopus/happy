package com.slopus.happy.connection

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * Why signing in to a team server failed, or why one wants signing in
 * again. [text] is what the person reads.
 */
class ServerAuthException(val reason: Reason, cause: Throwable? = null) : Exception(reason.name, cause) {
    enum class Reason {
        /** Not an `https://` origin (a path, a query or `http:` included). */
        InvalidAddress,
        /** `GET /v0/authentication` is 404, or lists no sign-in this app knows. */
        NoSignIn,
        /** Discovery was redirected or refused by something that isn't Happy: the load balancer authenticates it. */
        EdgeBlocked,
        Unreachable,
        /** The authorization server said no, or the person closed the page. */
        Denied,
        /** The callback is for no sign-in in progress (state mismatch, or the app was restarted). */
        Expired,
        /** The token endpoint answered something that isn't a bearer token. */
        InvalidToken,
        /** The daemon doesn't accept the token it issued. */
        Rejected,
        /** The access token expired and can't be refreshed: sign in again. */
        SignInRequired,
        /** The server at the code's address is another installation than the code names, or names none (edge SSO §8). */
        WrongServer,
        /** The method's token or refresh URL isn't on its authorization URL's origin: the code and verifier would go elsewhere. */
        CrossOrigin,
        /** The token's `aud` names no audience that is this server: it was issued for another (or isn't a JWT). */
        WrongAudience,
    }
}

/**
 * happy-agent's "needs sign-in" rule (edge SSO contract §3), for servers
 * signed in with OAuth: behind an SSO load balancer a refusal may come from
 * the edge rather than the daemon, so only the daemon's own JSON errors are
 * taken as what they say.
 */
object SignInRule {
    /** A daemon error: `application/json` whose body is an object with string `error` and `code`. */
    fun isHappyError(contentType: String?, body: ByteArray): Boolean {
        if (contentType?.substringBefore(';')?.trim()?.equals("application/json", ignoreCase = true) != true) return false
        val root = runCatching { Json.parseToJsonElement(body.decodeToString()) as? JsonObject }.getOrNull() ?: return false
        return root["error"].isString() && root["code"].isString()
    }

    /** A redirect (any 3xx but 304 Not Modified), any 401, or a 403 that isn't the daemon's: the person must sign in (again). */
    fun requiresSignIn(status: Int, contentType: String?, body: ByteArray): Boolean =
        (status in 300..399 && status != 304) || status == 401 || (status == 403 && !isHappyError(contentType, body))

    fun requiresSignIn(response: TransportResponse): Boolean =
        requiresSignIn(response.status, response.headers["content-type"], response.body)

    /** The profile gate: a good token, no profile saved yet, `403 {"code":"profile_required"}`. The person adds a name. */
    fun requiresProfile(status: Int, contentType: String?, body: ByteArray): Boolean {
        if (status != 403 || !isHappyError(contentType, body)) return false
        val root = runCatching { Json.parseToJsonElement(body.decodeToString()) as? JsonObject }.getOrNull()
        return (root?.get("code") as? JsonPrimitive)?.content == "profile_required"
    }

    fun requiresProfile(response: TransportResponse): Boolean =
        requiresProfile(response.status, response.headers["content-type"], response.body)

    private fun kotlinx.serialization.json.JsonElement?.isString() = (this as? JsonPrimitive)?.isString == true
}

/**
 * One `oauth` sign-in method from `GET /v0/authentication` (API.md, and
 * the edge SSO contract's `resource`). The URLs come from a daemon the app
 * doesn't trust with credentials: they are only ever sent the code and
 * tokens of a sign-in started with them.
 */
@Serializable
data class OAuthMethod(
    val id: String,
    val name: String,
    val authorizationUrl: String,
    val tokenUrl: String,
    val refreshUrl: String? = null,
    val clientId: String,
    val scope: String? = null,
    val resource: String? = null,
) {
    /**
     * Whether the token and refresh URLs are on the authorization URL's
     * origin (scheme, host and port, parsed): a server can't pair the real
     * authorization page with a token endpoint of its own, which would get
     * the code and the verifier.
     */
    val oneSite: Boolean get() {
        val authorization = authorizationUrl.toHttpUrlOrNull() ?: return false
        fun same(url: String?) = url?.toHttpUrlOrNull()?.let { it.scheme == authorization.scheme && it.host == authorization.host && it.port == authorization.port } == true
        return same(tokenUrl) && (refreshUrl == null || same(refreshUrl))
    }

    /** The authorization server's host, shown before the browser opens. */
    val authorizationHost: String get() = authorizationUrl.toHttpUrlOrNull()?.host.orEmpty()
}

/**
 * What a team server's refresh needs, recorded at sign-in and kept
 * Keystore-encrypted with the connection: the refresh token goes only to
 * this [refreshUrl] with this [clientId] and [resource], never to a URL a
 * daemon advertises afterwards. No refresh token or URL: the person signs
 * in again when the access token expires.
 */
@Serializable
data class OAuthCredential(
    val methodId: String,
    val clientId: String,
    val refreshUrl: String? = null,
    val refreshToken: String? = null,
    val resource: String? = null,
    /** Who signed in: `GET /v0/authentication`'s `userId`, once the member has a profile. */
    val userId: String? = null,
) {
    val canRefresh: Boolean get() = refreshUrl != null && refreshToken != null
    override fun toString() = "OAuthCredential(methodId=$methodId, clientId=$clientId, canRefresh=$canRefresh)"
}

/** An access token, held in memory only, and when it stops working. */
class AccessToken(val value: String, val expiresAtMillis: Long?) {
    override fun toString() = "AccessToken(expiresAt=$expiresAtMillis)"
}

/** A token endpoint's answer: the access token and, for [OAuthCredential], a refresh token if one came. */
class OAuthGrant(val access: AccessToken, val refreshToken: String?) {
    override fun toString() = "OAuthGrant($access, refresh=${refreshToken != null})"
}

/**
 * One sign-in in progress (RFC 6749, 7636, 8252): the PKCE verifier and
 * [state] stay in memory, in this object; the browser gets [authorizeUrl].
 */
class PendingOAuth internal constructor(
    val origin: AgentOrigin,
    val method: OAuthMethod,
    val redirectUri: String,
    val state: String,
    internal val verifier: String,
) {
    val authorizeUrl: String = method.authorizationUrl.toHttpUrlOrNull()!!.newBuilder()
        .addQueryParameter("response_type", "code")
        .addQueryParameter("client_id", method.clientId)
        .addQueryParameter("redirect_uri", redirectUri)
        .addQueryParameter("state", state)
        .addQueryParameter("code_challenge", challenge(verifier))
        .addQueryParameter("code_challenge_method", "S256")
        .apply { method.scope?.let { addQueryParameter("scope", it) } }
        .apply { method.resource?.let { addQueryParameter("resource", it) } }
        .build().toString()

    /** Whether [callback] is the redirect for this app (scheme and path, nothing after them but the query). */
    fun isCallback(callback: String): Boolean = callback.substringBefore('?').substringBefore('#') == redirectUri

    override fun toString() = "PendingOAuth(${origin.value}, ${method.id})"

    companion object {
        fun challenge(verifier: String): String =
            base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

        internal fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

/**
 * Team server sign-in over HTTPS with OkHttp: discovery, the code exchange
 * and refresh. Nothing here follows a redirect, and no request carries a
 * credential anywhere but its body or `Authorization` header.
 */
class ServerAuthClient(
    base: OkHttpClient,
    private val random: SecureRandom = SecureRandom(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val http = base.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * The `oauth` methods [origin] offers, in its order, without a
     * credential. Throws [ServerAuthException]: NoSignIn, EdgeBlocked or
     * Unreachable.
     */
    suspend fun discover(origin: AgentOrigin): List<OAuthMethod> {
        val (status, type, body) = call(Request.Builder().url("${origin.value}/v0/authentication").header("Accept", "application/json").build())
        if (status in 300..399 || ((status == 401 || status == 403) && !SignInRule.isHappyError(type, body))) {
            throw ServerAuthException(ServerAuthException.Reason.EdgeBlocked)
        }
        if (status == 404) throw ServerAuthException(ServerAuthException.Reason.NoSignIn)
        val root = if (status == 200) parse(body) else null
        if (root == null) {
            // A login page served as 200 is the edge too; anything else is the server failing.
            throw ServerAuthException(if (status == 200) ServerAuthException.Reason.EdgeBlocked else ServerAuthException.Reason.Unreachable)
        }
        return methods(root["methods"]).ifEmpty { throw ServerAuthException(ServerAuthException.Reason.NoSignIn) }
    }

    /** `GET /v0/authentication` with [token]: whether it is valid, and the member's user ID (null until they have a profile). */
    suspend fun check(origin: AgentOrigin, token: String): Pair<Boolean, String?> {
        val (status, _, body) = call(
            Request.Builder().url("${origin.value}/v0/authentication").header("Accept", "application/json").header("Authorization", "Bearer $token").build(),
        )
        val root = (if (status == 200) parse(body) else null) ?: throw ServerAuthException(ServerAuthException.Reason.Rejected)
        val authenticated = (root["authenticated"] as? JsonPrimitive)?.booleanOrNull == true
        return authenticated to (root["userId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

    /**
     * Saves the new member's [name] (`PATCH /v0/profile`): until a team
     * member has a profile, the daemon refuses everything else with `401`.
     * An expired [token] is SignInRequired.
     */
    suspend fun saveName(origin: AgentOrigin, token: String, name: String) {
        val body = Json.encodeToString(JsonObject.serializer(), JsonObject(mapOf("name" to JsonPrimitive(name))))
        val (status, _, _) = call(
            Request.Builder().url("${origin.value}/v0/profile")
                .header("Accept", "application/json")
                .header("Authorization", "Bearer $token")
                .patch(body.toRequestBody("application/json".toMediaType()))
                .build(),
        )
        if (status != 200) throw ServerAuthException(
            when (status) {
                401 -> ServerAuthException.Reason.SignInRequired
                in 500..599 -> ServerAuthException.Reason.Unreachable
                else -> ServerAuthException.Reason.Rejected
            },
        )
    }

    /**
     * Health's `instanceId` at [origin] with [token] (edge SSO §8): the
     * installation a server QR code names; null from a daemon without one.
     */
    suspend fun instanceId(origin: AgentOrigin, token: String): String? {
        val (status, type, body) = call(
            Request.Builder().url("${origin.value}/v0/health").header("Accept", "application/json").header("Authorization", "Bearer $token").build(),
        )
        if (SignInRule.requiresSignIn(status, type, body)) throw ServerAuthException(ServerAuthException.Reason.SignInRequired)
        if (status != 200) throw ServerAuthException(ServerAuthException.Reason.Unreachable)
        val root = parse(body) ?: throw ServerAuthException(ServerAuthException.Reason.Unreachable)
        return (root["instanceId"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(com.slopus.happy.agent.HappyUrls::isInstanceId)
    }

    /**
     * Starts a sign-in with [method]: a fresh state and verifier, and the
     * page to open. The attempt keeps [origin] and the method's URLs, client
     * and resource as they are now; nothing is read from the server again.
     * Throws CrossOrigin for a method whose token endpoint is elsewhere.
     */
    fun begin(origin: AgentOrigin, method: OAuthMethod, redirectUri: String): PendingOAuth {
        if (!method.oneSite) throw ServerAuthException(ServerAuthException.Reason.CrossOrigin)
        return PendingOAuth(origin, method, redirectUri, state = token(16), verifier = token(48))
    }

    /**
     * The browser came back to [callback]: checks it is [pending]'s and
     * exchanges its code at the method's token endpoint, with the verifier
     * and the `resource` the sign-in started with.
     */
    suspend fun complete(pending: PendingOAuth, callback: String): Pair<OAuthGrant, OAuthCredential> {
        if (!pending.isCallback(callback)) throw ServerAuthException(ServerAuthException.Reason.Expired)
        val query = query(callback) ?: throw ServerAuthException(ServerAuthException.Reason.Expired)
        if (query["state"] != pending.state) throw ServerAuthException(ServerAuthException.Reason.Expired)
        if (query["error"] != null) throw ServerAuthException(ServerAuthException.Reason.Denied)
        val code = query["code"]?.takeIf { it.isNotEmpty() } ?: throw ServerAuthException(ServerAuthException.Reason.Denied)
        val method = pending.method
        val form = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("redirect_uri", pending.redirectUri)
            .add("client_id", method.clientId)
            .add("code_verifier", pending.verifier)
            .apply { method.resource?.let { add("resource", it) } }
            .build()
        val grant = token(method.tokenUrl, form) ?: throw ServerAuthException(ServerAuthException.Reason.Denied)
        if (!audienceIs(grant.access.value, pending.origin)) throw ServerAuthException(ServerAuthException.Reason.WrongAudience)
        return grant to OAuthCredential(method.id, method.clientId, method.refreshUrl, grant.refreshToken, method.resource)
    }

    /**
     * A new access token from [credential]'s refresh token, sent only to its
     * recorded refresh URL. The credential to keep comes back with it: a
     * rotated refresh token replaces the old, none keeps it. Throws
     * SignInRequired when there is none or the server refuses it, and
     * Unreachable when it couldn't ask.
     */
    /** A new access token for [server]'s [credential], checked to be [server]'s like the first. */
    suspend fun refresh(credential: OAuthCredential, server: AgentOrigin): Pair<AccessToken, OAuthCredential> {
        val url = credential.refreshUrl ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired)
        val refreshToken = credential.refreshToken ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired)
        val form = FormBody.Builder()
            .add("grant_type", "refresh_token")
            .add("refresh_token", refreshToken)
            .add("client_id", credential.clientId)
            .apply { credential.resource?.let { add("resource", it) } }
            .build()
        val grant = token(url, form) ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired)
        if (!audienceIs(grant.access.value, server)) throw ServerAuthException(ServerAuthException.Reason.WrongAudience)
        return grant.access to credential.copy(refreshToken = grant.refreshToken ?: refreshToken)
    }

    /** A token endpoint's grant; null when it refused (4xx, or a redirect, which is never followed). */
    private suspend fun token(url: String, form: FormBody): OAuthGrant? {
        val target = checkedUrl(url) ?: throw ServerAuthException(ServerAuthException.Reason.InvalidToken)
        val (status, _, body) = call(Request.Builder().url(target).header("Accept", "application/json").post(form).build())
        if (status in 300..499) return null
        if (status != 200) throw ServerAuthException(ServerAuthException.Reason.Unreachable)
        val root = parse(body) ?: throw ServerAuthException(ServerAuthException.Reason.InvalidToken)
        val access = (root["access_token"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() && it.length <= 16384 && it.none { c -> c.code <= 32 || c.code >= 127 } }
        val type = (root["token_type"] as? JsonPrimitive)?.contentOrNull
        if (access == null || !type.equals("bearer", ignoreCase = true)) throw ServerAuthException(ServerAuthException.Reason.InvalidToken)
        val expiresIn = (root["expires_in"] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() }?.takeIf { it > 0 }
        val refresh = (root["refresh_token"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        return OAuthGrant(AccessToken(access, expiresIn?.let { now() + it * 1000 }), refresh)
    }

    private suspend fun call(request: Request): Triple<Int, String?, ByteArray> = withContext(Dispatchers.IO) {
        try {
            http.newCall(request).execute().use { response ->
                Triple(response.code, response.header("Content-Type"), response.peekBody(MAX_BODY.toLong()).bytes())
            }
        } catch (e: IOException) {
            throw ServerAuthException(ServerAuthException.Reason.Unreachable, e)
        }
    }

    private fun token(bytes: Int): String = ByteArray(bytes).also(random::nextBytes).let(PendingOAuth::base64Url)

    companion object {
        private const val MAX_BODY = 1024 * 1024
        private val json = Json { ignoreUnknownKeys = true }

        private fun parse(body: ByteArray): JsonObject? = runCatching { json.parseToJsonElement(body.decodeToString()) as? JsonObject }.getOrNull()

        /**
         * Whether [token], a JWT, is for [server]: one entry of its `aud`
         * (a string or an array; the signature isn't checked, the server
         * does that) is an absolute URL on [server]'s origin whose path, with
         * a trailing `/` when it has none, is the server's (`/`). A token
         * that isn't a JWT is for no one.
         */
        internal fun audienceIs(token: String, server: AgentOrigin): Boolean {
            val parts = token.split('.')
            if (parts.size != 3) return false
            val claims = try {
                parse(Base64.getUrlDecoder().decode(parts[1]))
            } catch (_: IllegalArgumentException) {
                null
            } ?: return false
            val audiences = when (val aud = claims["aud"]) {
                is JsonPrimitive -> listOfNotNull(aud.takeIf { it.isString }?.content)
                is JsonArray -> aud.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                else -> emptyList()
            }
            val base = "${server.value}/".toHttpUrlOrNull() ?: return false
            return audiences.any { audience ->
                val url = audience.toHttpUrlOrNull() ?: return@any false
                url.scheme == base.scheme && url.host == base.host && url.port == base.port &&
                    url.encodedPath.let { if (it.endsWith("/")) it else "$it/" } == base.encodedPath
            }
        }

        /** The methods this app can use: `oauth` ones with valid URLs; others are skipped, as API.md asks. */
        internal fun methods(element: kotlinx.serialization.json.JsonElement?): List<OAuthMethod> =
            (element as? JsonArray).orEmpty().mapNotNull { item ->
                val method = item as? JsonObject ?: return@mapNotNull null
                fun text(key: String) = (method[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
                if (text("type") != "oauth") return@mapNotNull null
                val parsed = OAuthMethod(
                    id = text("id") ?: return@mapNotNull null,
                    name = text("name") ?: return@mapNotNull null,
                    authorizationUrl = text("authorizationUrl")?.takeIf { checkedUrl(it) != null } ?: return@mapNotNull null,
                    tokenUrl = text("tokenUrl")?.takeIf { checkedUrl(it) != null } ?: return@mapNotNull null,
                    refreshUrl = text("refreshUrl")?.takeIf { checkedUrl(it) != null },
                    clientId = text("clientId") ?: return@mapNotNull null,
                    scope = text("scope"),
                    resource = text("resource")?.takeIf { runCatching { URI(it).isAbsolute && URI(it).fragment == null }.getOrDefault(false) && it.length <= 2048 },
                )
                parsed
            }

        /** An `https` URL, or `http` on a loopback host (API.md); anything else is refused. */
        internal fun checkedUrl(text: String): HttpUrl? {
            val url = text.toHttpUrlOrNull() ?: return null
            if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            return when (url.scheme) {
                "https" -> url
                "http" -> url.takeIf { it.host == "localhost" || it.host == "::1" || it.host.matches(Regex("""127\.\d+\.\d+\.\d+""")) }
                else -> null
            }
        }

        /**
         * A callback's query parameters, decoded; the first of each name.
         * Null for a malformed one (a bad escape): any app can send the
         * redirect URI, so it is never trusted to parse.
         */
        internal fun query(callback: String): Map<String, String>? {
            val raw = callback.substringAfter('?', "").substringBefore('#')
            if (raw.isEmpty()) return emptyMap()
            return try {
                raw.split('&').mapNotNull { part ->
                    if (part.isEmpty()) return@mapNotNull null
                    val name = URLDecoder.decode(part.substringBefore('='), "UTF-8")
                    val value = URLDecoder.decode(part.substringAfter('=', ""), "UTF-8")
                    name to value
                }.distinctBy { it.first }.toMap()
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        /**
         * What the person typed as a server: `https://host[:port]`, a bare
         * host meaning https, a trailing slash allowed. A path, query,
         * credentials or plain http are not a team server address.
         */
        fun parseAddress(input: String): AgentOrigin {
            fun invalid(): Nothing = throw ServerAuthException(ServerAuthException.Reason.InvalidAddress)
            val text = input.trim().let { if ("://" in it) it else "https://$it" }
            val url = text.toHttpUrlOrNull() ?: invalid()
            if (url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() || url.encodedPath != "/" || url.query != null || url.fragment != null) invalid()
            val host = if (url.host.contains(':')) "[${url.host}]" else url.host
            return try {
                AgentOrigin.parse("https://$host" + if (url.port == 443) "" else ":${url.port}")
            } catch (_: AgentConnectionException) {
                invalid()
            }
        }
    }
}
