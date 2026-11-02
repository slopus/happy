package com.slopus.happy.connection

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentSessions
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import java.io.File
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
        val credential = OAuthCredential("jwt", "happy", refreshUrl, "refresh-1", "https://happy.acme.example", userId = "u1")
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
        // The same member signing in again renews the same connection.
        assertEquals(account.id, signedIn(connections).id)
        assertEquals(1, connections.accounts.value.size)
    }

    @Test
    fun anExpiringTokenIsRefreshedAndTheRotationKept() = runBlocking {
        val connections = connections()
        val account = signedIn(connections, expiresIn = 30_000)
        val access2 = jwt("https://happy.acme.example", tag = "access-2")
        sso.enqueue(json("""{"access_token":"$access2","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-2"}"""))
        daemon.valid += access2
        // Within a minute of expiry: refreshed before it is sent.
        assertEquals(access2, connections.bearer(account.id, connections.credentials(account.id)!!))
        assertEquals("refresh-2", connections().credentials(account.id)?.oauth?.refreshToken)
        assertEquals("/oauth/token", sso.takeRequest().target)
        // Fresh now: no second refresh.
        assertEquals(access2, connections.bearer(account.id, connections.credentials(account.id)!!))
        assertEquals(1, sso.requestCount)
    }

    @Test
    fun a401IsRetriedOnceWithARenewedToken() = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        // The IdP revoked access-1 early: the daemon refuses it.
        daemon.valid.clear()
        val access2 = jwt("https://happy.acme.example", tag = "access-2")
        daemon.valid += access2
        sso.enqueue(json("""{"access_token":"$access2","token_type":"Bearer","expires_in":600}"""))
        val client = client(connections, account.id)
        assertEquals(200, client.send("GET", "/v0/projects").status)
        assertEquals(listOf("/v0/projects" to "access-1", "/v0/authentication" to "access-1", "/v0/projects" to access2), daemon.calls.filter { it.first == "/v0/projects" || it.first == "/v0/authentication" })
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

    private fun member(user: String, refresh: String) = OAuthCredential("jwt", "happy", refreshUrl, refresh, "https://happy.acme.example", userId = user)

    @Test
    fun anotherMemberSigningInGetsAConnectionOfTheirOwn(): Unit = runBlocking {
        val connections = connections()
        daemon.valid += setOf("access-a", "access-a2", "access-b")
        val a = connections.addServer(origin, member("u-a", "refresh-a"), AccessToken("access-a", now + 300_000), fallbackName = "happy.acme.example")
        assertEquals("u-a", a.userId)
        // The same member again: the same connection, renewed in place.
        val again = connections.addServer(origin, member("u-a", "refresh-a2"), AccessToken("access-a2", now + 300_000), fallbackName = "happy.acme.example", replacing = a.id)
        assertEquals(a.id, again.id)
        connections.signedOut(a.id)
        // Someone else signs in again on it: a new connection, and the first one is wiped.
        val b = connections.addServer(origin, member("u-b", "refresh-b"), AccessToken("access-b", now + 300_000), fallbackName = "happy.acme.example", replacing = a.id)
        assertTrue(b.id != a.id)
        assertEquals(listOf(b.id), connections.accounts.value.map { it.id })
        assertEquals(null, connections.credentials(a.id))
        assertEquals("refresh-b", connections.credentials(b.id)?.oauth?.refreshToken)
        assertFalse(connections.accounts.value.single().signInRequired)
        // Not replacing, by origin alone: still only the same member's.
        val c = connections.addServer(origin, member("u-c", "refresh-c"), AccessToken("access-b", now + 300_000), fallbackName = "happy.acme.example")
        assertTrue(c.id != b.id)
        assertEquals(setOf(b.id, c.id), connections.accounts.value.map { it.id }.toSet())
    }

    @Test
    fun theReplacedMembersCachesAreWipedEvenWhenItWasntOpen(): Unit = runBlocking {
        val connections = connections()
        daemon.valid += setOf("access-a", "access-b")
        val a = connections.addServer(origin, member("u-a", "refresh-a"), AccessToken("access-a", now + 300_000), fallbackName = "happy.acme.example")
        val dir = kotlin.io.path.createTempDirectory("agent-connections").toFile()
        val catalog = File(dir, "${a.id}.json").apply { writeText("{}") }
        val chat = File(dir, "${a.id}.chats.json").apply { writeText("{}") }
        // Left by a connection forgotten while the app wasn't running.
        val orphan = File(dir, "agent-connection-gone.json").apply { writeText("{}") }
        AgentSessions(connections, scope, dir, openId = MutableStateFlow(null), foreground = MutableStateFlow(false), makeTransport = { daemon })
        withTimeout(5_000) { while (orphan.exists()) delay(10) }
        assertTrue(catalog.exists() && chat.exists())
        connections.addServer(origin, member("u-b", "refresh-b"), AccessToken("access-b", now + 300_000), fallbackName = "happy.acme.example", replacing = a.id)
        withTimeout(5_000) { while (catalog.exists() || chat.exists()) delay(10) }
        dir.deleteRecursively()
    }

    @Test
    fun aRefreshOfAnOlderGrantIsDroppedWhenASignInLandsFirst(): Unit = runBlocking {
        val connections = connections()
        daemon.valid += setOf("access-a", "access-b")
        val a = connections.addServer(origin, member("u-a", "refresh-a"), AccessToken("access-a", now), fallbackName = "happy.acme.example")
        // A's refresh is slow; the person signs in again (as B) before it answers.
        sso.enqueue(json("""{"access_token":"${jwt("https://happy.acme.example", tag = "late")}","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-late"}""").newBuilder().headersDelay(1, java.util.concurrent.TimeUnit.SECONDS).build())
        val late = scope.async { connections.bearer(a.id, connections.credentials(a.id)!!) }
        withTimeout(5_000) { while (sso.requestCount == 0) delay(10) }
        val b = connections.addServer(origin, member("u-a", "refresh-b"), AccessToken("access-b", now + 300_000), fallbackName = "happy.acme.example", replacing = a.id)
        assertEquals(a.id, b.id)
        // The late answer is dropped: B's grant stands, kept and in use.
        assertEquals("access-b", late.await())
        assertEquals("refresh-b", connections.credentials(b.id)?.oauth?.refreshToken)
        assertEquals("access-b", connections.bearer(b.id, connections.credentials(b.id)!!))
    }

    @Test
    fun anOlderGrantsRefusedRefreshDoesntSignOutTheNewOne(): Unit = runBlocking {
        val connections = connections()
        daemon.valid += setOf("access-a", "access-b")
        val a = connections.addServer(origin, member("u-a", "refresh-a"), AccessToken("access-a", now), fallbackName = "happy.acme.example")
        sso.enqueue(json("""{"error":"invalid_grant"}""", 400).newBuilder().headersDelay(1, java.util.concurrent.TimeUnit.SECONDS).build())
        val late = scope.async { runCatching { connections.bearer(a.id, connections.credentials(a.id)!!) } }
        withTimeout(5_000) { while (sso.requestCount == 0) delay(10) }
        connections.addServer(origin, member("u-a", "refresh-b"), AccessToken("access-b", now + 300_000), fallbackName = "happy.acme.example", replacing = a.id)
        assertTrue(late.await().isFailure)
        assertFalse(connections.accounts.value.single().signInRequired)
        assertEquals("refresh-b", connections.credentials(a.id)?.oauth?.refreshToken)
    }

    @Test
    fun aServerWhoseKeystoreKeyIsGoneIsSignedOut(): Unit = runBlocking {
        val connections = connections()
        val account = signedIn(connections)
        // Restored or moved to another phone: the preferences came, the Keystore key didn't.
        keys.delete(ExpoSecureStore(secretPrefs, keys, keychainService = AgentConnections.KEYCHAIN_SERVICE).aesAlias(usesKeystoreSuffix = true))
        val again = connections()
        try { again.linkCredentials(account.id); fail() } catch (e: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.SignInRequired, e.reason) }
        val listed = again.accounts.value.single()
        assertTrue(listed.signInRequired)
        assertFalse(listed.revoked)
        assertEquals(null, again.credentials(account.id))
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
        val flow = ServerSignInFlow(scope, connections, auth, expectedInstance = INSTANCE)
        sso.enqueue(discovery(server))
        flow.start(server)
        val ready = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Ready } } as ServerSignInState.Ready
        assertEquals("Acme SSO", ready.method.name)
        val url = flow.browserUrl()!!.toHttpUrl()
        val state = url.queryParameter("state")!!
        // A stale page's callback is ignored, and so is a malformed one any app could send; this one's is taken.
        flow.callback("happy://oauth/callback?code=old&state=stale")
        assertTrue(flow.state.value is ServerSignInState.InBrowser)
        listOf("happy://oauth/callback?state=%", "happy://oauth/callback?state=%zz&code=x", "happy://oauth/callback?%E0%A4%A=1&state=$state").forEach {
            flow.callback(it)
            assertTrue(it, flow.state.value is ServerSignInState.InBrowser)
        }
        assertEquals(null, ServerAuthClient.query("happy://oauth/callback?state=%"))
        val access1 = jwt(server, tag = "access-1")
        val access2 = jwt(server, tag = "access-2")
        sso.enqueue(json("""{"access_token":"$access1","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-1"}"""))
        sso.enqueue(json("""{"authenticated":true,"userId":null,"methods":[]}"""))
        // The code's installation, checked before the name.
        sso.enqueue(health(INSTANCE))
        daemon.valid += access1
        flow.callback("happy://oauth/callback?code=c1&state=$state")
        withTimeout(5_000) { flow.state.first { it is ServerSignInState.NeedsName } }
        // The access token expired while the name was typed: refreshed (rotating) once, and saved.
        sso.enqueue(json("""{"error":"Unauthorized","code":"unauthorized"}""", 401))
        sso.enqueue(json("""{"access_token":"$access2","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-2"}"""))
        sso.enqueue(json("""{"profile":{}}"""))
        sso.enqueue(json("""{"authenticated":true,"userId":"u1","methods":[]}"""))
        flow.submitName("Steve")
        val done = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Done } } as ServerSignInState.Done
        assertEquals(server, done.account.server)
        assertEquals("refresh-2", connections.credentials(done.account.id)?.oauth?.refreshToken)
        // A new member: who they are is asked once the name is saved, and kept with the credential.
        assertEquals("u1", done.account.userId)
        assertEquals("u1", connections.credentials(done.account.id)?.oauth?.userId)
        val requests = (0 until sso.requestCount).map { sso.takeRequest() }
        val patches = requests.filter { it.method == "PATCH" }
        assertEquals(listOf("Bearer $access1", "Bearer $access2"), patches.map { it.headers["Authorization"] })
        assertEquals(listOf("Bearer $access1"), requests.filter { it.target == "/v0/health" }.map { it.headers["Authorization"] })
    }

    private fun discovery(server: String) =
        json("""{"authenticated":false,"userId":null,"methods":[{"type":"oauth","id":"jwt","name":"Acme SSO","authorizationUrl":"$server/authorize","tokenUrl":"$server/token","refreshUrl":"$server/token","clientId":"happy","resource":"https://happy.acme.example"}]}""")

    private fun health(instanceId: String?) =
        json("""{"healthy":true,"ready":true,"version":{"protocol":33,"daemon":"1"}${instanceId?.let { ",\"instanceId\":\"$it\"" }.orEmpty()}}""")

    /** A sign-in to this mock for [INSTANCE], through discovery and the browser, the code exchanged and checked as [userId]'s. */
    private suspend fun throughBrowser(flow: ServerSignInFlow, userId: String?, vararg then: MockResponse) {
        val server = "https://localhost:${sso.port}"
        sso.enqueue(discovery(server))
        flow.start(server)
        withTimeout(5_000) { flow.state.first { it is ServerSignInState.Ready } }
        val state = flow.browserUrl()!!.toHttpUrl().queryParameter("state")!!
        val access1 = jwt(server, tag = "access-1")
        sso.enqueue(json("""{"access_token":"$access1","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-1"}"""))
        sso.enqueue(json("""{"authenticated":true,"userId":${userId?.let { "\"$it\"" } ?: "null"},"methods":[]}"""))
        then.forEach(sso::enqueue)
        daemon.valid += access1
        flow.callback("happy://oauth/callback?code=c1&state=$state")
    }

    @Test
    fun anotherInstallationAtTheCodesAddressIsNotKept() = runBlocking {
        val connections = connections()
        val flow = ServerSignInFlow(scope, connections, auth, expectedInstance = INSTANCE)
        throughBrowser(flow, "u1", health("z9y8x7w6v5u4t3s2r1q0p9o8"))
        val failed = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Failed } } as ServerSignInState.Failed
        assertEquals(ServerAuthException.Reason.WrongServer, failed.reason)
        assertEquals(emptyList<AgentConnection>(), connections.accounts.value)
    }

    @Test
    fun aHealthWithoutAnInstanceCantBeVerified() = runBlocking {
        val connections = connections()
        val flow = ServerSignInFlow(scope, connections, auth, expectedInstance = INSTANCE)
        throughBrowser(flow, "u1", health(null))
        val failed = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Failed } } as ServerSignInState.Failed
        assertEquals(ServerAuthException.Reason.WrongServer, failed.reason)
        assertEquals(emptyList<AgentConnection>(), connections.accounts.value)
    }

    @Test
    fun aMembersServerIsKeptWhenItIsTheCodesInstallation() = runBlocking {
        val connections = connections()
        val flow = ServerSignInFlow(scope, connections, auth, expectedInstance = INSTANCE)
        throughBrowser(flow, "u1", health(INSTANCE))
        val done = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Done } } as ServerSignInState.Done
        assertEquals("https://localhost:${sso.port}", done.account.server)
    }

    @Test
    fun aNewMembersHealthBehindTheProfileGateIsCheckedAfterTheName() = runBlocking {
        val connections = connections()
        val flow = ServerSignInFlow(scope, connections, auth, expectedInstance = INSTANCE)
        throughBrowser(flow, null, json("""{"error":"Unauthorized","code":"unauthorized"}""", 401))
        withTimeout(5_000) { flow.state.first { it is ServerSignInState.NeedsName } }
        sso.enqueue(json("""{"profile":{}}"""))
        sso.enqueue(health("z9y8x7w6v5u4t3s2r1q0p9o8"))
        flow.submitName("Steve")
        val failed = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Failed } } as ServerSignInState.Failed
        assertEquals(ServerAuthException.Reason.WrongServer, failed.reason)
        assertEquals(emptyList<AgentConnection>(), connections.accounts.value)
    }

    @Test
    fun aMethodWhoseTokenEndpointIsElsewhereIsRefusedBeforeTheBrowser(): Unit = runBlocking {
        val server = "https://localhost:${sso.port}"
        val flow = ServerSignInFlow(scope, connections(), auth, expectedInstance = INSTANCE)
        sso.enqueue(json("""{"authenticated":false,"userId":null,"methods":[{"type":"oauth","id":"jwt","name":"Acme SSO","authorizationUrl":"https://sso.acme.example/authorize","tokenUrl":"$server/token","clientId":"happy"}]}"""))
        flow.start(server)
        val failed = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Failed } } as ServerSignInState.Failed
        assertEquals(ServerAuthException.Reason.CrossOrigin, failed.reason)
        assertEquals(null, flow.browserUrl())
    }

    @Test
    fun aTokenForAnotherServerIsNeitherKeptNorSent(): Unit = runBlocking {
        val connections = connections()
        val server = "https://localhost:${sso.port}"
        val flow = ServerSignInFlow(scope, connections, auth, expectedInstance = INSTANCE)
        sso.enqueue(discovery(server))
        flow.start(server)
        withTimeout(5_000) { flow.state.first { it is ServerSignInState.Ready } }
        val state = flow.browserUrl()!!.toHttpUrl().queryParameter("state")!!
        sso.enqueue(json("""{"access_token":"${jwt("https://happy.other.example/", tag = "stolen")}","token_type":"Bearer","expires_in":600,"refresh_token":"refresh-1"}"""))
        flow.callback("happy://oauth/callback?code=c1&state=$state")
        val failed = withTimeout(5_000) { flow.state.first { it is ServerSignInState.Failed } } as ServerSignInState.Failed
        assertEquals(ServerAuthException.Reason.WrongAudience, failed.reason)
        assertEquals(emptyList<AgentConnection>(), connections.accounts.value)
        // Only discovery and the exchange: the token went nowhere.
        assertEquals(2, sso.requestCount)
    }

    @Test
    fun aRefreshedTokenForAnotherServerSignsOut(): Unit = runBlocking {
        val connections = connections()
        val account = signedIn(connections, expiresIn = 30_000)
        sso.enqueue(json("""{"access_token":"${jwt("https://happy.acme.example/other/", tag = "x")}","token_type":"Bearer","expires_in":600}"""))
        try { connections.bearer(account.id, connections.credentials(account.id)!!); fail() } catch (e: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.SignInRequired, e.reason) }
        assertTrue(connections.accounts.value.single().signInRequired)
    }

    private companion object {
        const val INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2"
    }
}
