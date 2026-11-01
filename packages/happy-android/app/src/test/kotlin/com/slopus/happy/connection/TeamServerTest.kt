package com.slopus.happy.connection

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A team server behind an SSO edge, kept as an agent connection: its
 * refresh token Keystore-encrypted, its access token refreshed before it
 * expires and after a 401, and the edge's refusals read as "sign in again".
 */
@RunWith(AndroidJUnit4::class)
class TeamServerTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
    private val sso = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
        protocols = listOf(Protocol.HTTP_1_1)
        start()
    }
    private val roots = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val http = OkHttpClient.Builder().sslSocketFactory(roots.sslSocketFactory(), roots.trustManager).build()
    private var now = 1_000_000L
    private val auth = ServerAuthClient(http, now = { now })
    private val daemon = Daemon()
    private val origin = AgentOrigin.parse("https://happy.acme.example")
    private val secretPrefs get() = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE)
    private val registryPrefs get() = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE)

    private fun connections() = AgentConnections(
        secrets = ExpoSecureStore(secretPrefs, keys, keychainService = AgentConnections.KEYCHAIN_SERVICE),
        registry = registryPrefs,
        makeTransport = { daemon },
        now = { now },
        serverAuth = auth,
    )

    private val refreshUrl get() = "https://localhost:${sso.port}/oauth/token"
    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    /** The daemon behind the edge: accepts [valid] tokens; [edge] answers in its place when set. */
    private class Daemon : Transport {
        val valid = mutableSetOf<String>()
        var edge: TransportResponse? = null
        /** Tokens of a member without a profile: everything but health, profile and discovery is a 401. */
        val noProfile = mutableSetOf<String>()
        val calls = mutableListOf<Pair<String, String>>()

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            calls += path to credential
            edge?.let { return it }
            if (path == "/v0/authentication") {
                val ok = credential in valid
                val user = if (ok && credential !in noProfile) "\"u1\"" else "null"
                return TransportResponse(200, mapOf("content-type" to "application/json"), "{\"authenticated\":$ok,\"userId\":$user,\"methods\":[]}".toByteArray())
            }
            if (credential !in valid) return happy(401, "unauthorized")
            if (credential in noProfile && path !in setOf("/v0/health", "/v0/profile")) return happy(401, "unauthorized")
            return when (path) {
                "/v0/health" -> TransportResponse(200, mapOf("content-type" to "application/json"), """{"healthy":true,"ready":true,"version":{"protocol":33,"daemon":"1"},"capabilities":{"webSocketTunnels":true}}""".toByteArray())
                // A member may not read the node's configuration.
                "/v0/config" -> happy(403, "forbidden")
                "/v0/forbidden" -> happy(403, "forbidden")
                else -> TransportResponse(200, mapOf("content-type" to "application/json"), "{}".toByteArray())
            }
        }

        override suspend fun close() {}

        fun happy(status: Int, code: String) = TransportResponse(status, mapOf("content-type" to "application/json"), """{"error":"$code","code":"$code"}""".toByteArray())
    }

    @Before
    fun setUp() {
        secretPrefs.edit().clear().commit()
        registryPrefs.edit().clear().commit()
    }

    @After
    fun tearDown() {
        scope.cancel()
        sso.close()
    }

    private suspend fun signedIn(connections: AgentConnections, expiresIn: Long = 300_000): AgentConnection {
        daemon.valid += "access-1"
        val credential = OAuthCredential("jwt", "happy", refreshUrl, "refresh-1", "https://happy.acme.example")
        return connections.addServer(origin, credential, AccessToken("access-1", now + expiresIn), fallbackName = "happy.acme.example")
    }

    private fun client(connections: AgentConnections, id: String) = AgentClient.lazy {
        val credentials = connections.credentials(id)!!
        AgentClient.Link(daemon, connections.bearer(id, credentials), renew = { stale -> connections.renew(id, stale) })
    }

    @Test
    fun aServerIsKeptWithItsRefreshTokenEncrypted() = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        assertEquals("https://happy.acme.example", account.server)
        assertEquals("happy.acme.example", account.name)
        val credentials = connections()
            .credentials(account.id)!!
        assertEquals("https://happy.acme.example", credentials.publicUrl)
        assertEquals("", credentials.deviceToken)
        assertEquals("refresh-1", credentials.oauth?.refreshToken)
        assertFalse((secretPrefs.all.values + registryPrefs.all.values).joinToString().contains("refresh-1"))
        // The access token is in memory only.
        assertFalse((secretPrefs.all.values + registryPrefs.all.values).joinToString().contains("access-1"))
        assertEquals("access-1", connections.bearer(account.id, credentials))
        // Signing in again renews the same connection.
        assertEquals(account.id, signedIn(connections).id)
        assertEquals(1, connections.accounts.value.size)
    }

    @Test
    fun anExpiringTokenIsRefreshedAndTheRotationKept() = runBlocking {
        val connections = connections()
        val account = signedIn(connections, expiresIn = 30_000)
        sso.enqueue(json("""{"access_token":"access-2","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-2"}"""))
        daemon.valid += "access-2"
        // Within a minute of expiry: refreshed before it is sent.
        assertEquals("access-2", connections.bearer(account.id, connections.credentials(account.id)!!))
        assertEquals("refresh-2", connections().credentials(account.id)?.oauth?.refreshToken)
        assertEquals("/oauth/token", sso.takeRequest().target)
        // Fresh now: no second refresh.
        assertEquals("access-2", connections.bearer(account.id, connections.credentials(account.id)!!))
        assertEquals(1, sso.requestCount)
    }

    @Test
    fun a401IsRetriedOnceWithARenewedToken() = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        // The IdP revoked access-1 early: the daemon refuses it.
        daemon.valid.clear()
        daemon.valid += "access-2"
        sso.enqueue(json("""{"access_token":"access-2","token_type":"Bearer","expires_in":600}"""))
        val client = client(connections, account.id)
        assertEquals(200, client.send("GET", "/v0/projects").status)
        assertEquals(listOf("/v0/projects" to "access-1", "/v0/authentication" to "access-1", "/v0/projects" to "access-2"), daemon.calls.filter { it.first == "/v0/projects" || it.first == "/v0/authentication" })
        // A refusal from the daemon itself is an ordinary error, not a sign-in.
        try { client.send("GET", "/v0/forbidden"); fail() } catch (e: AgentApiException) { assertEquals("forbidden", e.code) }
    }

    @Test
    fun aDaemon401WithAValidTokenIsTheProfileGate() = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        daemon.noProfile += "access-1"
        val client = client(connections, account.id)
        try { client.send("GET", "/v0/projects"); fail() } catch (e: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.ProfileRequired, e.reason) }
        // Asked, not refreshed.
        assertEquals(0, sso.requestCount)
        assertEquals("access-1", daemon.calls.last { it.first == "/v0/authentication" }.second)
    }

    @Test
    fun theEdgeAndAFailedRefreshMeanSignInAgain() = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        val client = client(connections, account.id)
        for (edge in listOf(
            TransportResponse(302, mapOf("location" to "https://idp.example/login")),
            // The edge's own 401: no refresh, no discovery check.
            TransportResponse(401, mapOf("content-type" to "text/html"), "<html>login</html>".toByteArray()),
            TransportResponse(403, mapOf("content-type" to "text/html"), "<html>denied</html>".toByteArray()),
        )) {
            daemon.edge = edge
            try { client.send("GET", "/v0/projects"); fail() } catch (e: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.SignInRequired, e.reason) }
        }
        assertEquals(0, sso.requestCount)
        assertTrue(daemon.calls.none { it.first == "/v0/authentication" })
        // A 401 the refresh can't fix: the connection is flagged for the person.
        daemon.edge = null
        daemon.valid.clear()
        sso.enqueue(json("""{"error":"invalid_grant"}""", 400))
        try { client.send("GET", "/v0/projects"); fail() } catch (e: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.SignInRequired, e.reason) }
        assertTrue(withTimeout(5_000) { connections.accounts.first { list -> list.any { it.signInRequired } } }.isNotEmpty())
    }

    @Test
    fun identityReadsHealthsTunnelCapabilityWithoutTheConfig() = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        val info = AgentIdentity.refresh(client(connections, account.id).requester, "fallback", oauth = true)
        assertEquals("fallback", info.name)
        assertTrue(info.webSocketTunnels)
    }

    @Test
    fun aSignInRunsDiscoveryBrowserCallbackAndProfile() = runBlocking {
        val connections = connections()
        // The daemon's origin is this mock (discovery and profile), and so is the SSO.
        val server = "https://localhost:${sso.port}"
        val flow = ServerSignInFlow(scope, connections, auth)
        sso.enqueue(json("""{"authenticated":false,"userId":null,"methods":[{"type":"oauth","id":"jwt","name":"Acme SSO","authorizationUrl":"$server/authorize","tokenUrl":"$server/token","refreshUrl":"$server/token","clientId":"happy","resource":"https://happy.acme.example"}]}"""))
        flow.start(server)
        val ready = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Ready } } as ServerSignInState.Ready
        assertEquals("Acme SSO", ready.method.name)
        val url = flow.browserUrl()!!.toHttpUrl()
        val state = url.queryParameter("state")!!
        // A stale page's callback is ignored; this one's is taken.
        flow.callback("happy://oauth/callback?code=old&state=stale")
        assertTrue(flow.state.value is ServerSignInState.InBrowser)
        sso.enqueue(json("""{"access_token":"access-1","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-1"}"""))
        sso.enqueue(json("""{"authenticated":true,"userId":null,"methods":[]}"""))
        daemon.valid += "access-1"
        flow.callback("happy://oauth/callback?code=c1&state=$state")
        withTimeout(5_000) { flow.state.first { it is ServerSignInState.NeedsName } }
        // The access token expired while the name was typed: refreshed (rotating) once, and saved.
        sso.enqueue(json("""{"error":"Unauthorized","code":"unauthorized"}""", 401))
        sso.enqueue(json("""{"access_token":"access-2","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-2"}"""))
        sso.enqueue(json("""{"profile":{}}"""))
        flow.submitName("Steve")
        val done = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Done } } as ServerSignInState.Done
        assertEquals(server, done.account.server)
        assertEquals("refresh-2", connections.credentials(done.account.id)?.oauth?.refreshToken)
        val patches = (0 until sso.requestCount).map { sso.takeRequest() }.filter { it.method == "PATCH" }
        assertEquals(listOf("Bearer access-1", "Bearer access-2"), patches.map { it.headers["Authorization"] })
    }
}
