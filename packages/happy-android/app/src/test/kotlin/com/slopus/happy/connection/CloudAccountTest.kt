package com.slopus.happy.connection

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Happy Cloud account against a fake accounts service: signed in with
 * PKCE for the accounts origin, kept across restarts, its token refreshed
 * after a 401, and the accounts API's answers as the picker reads them.
 */
@RunWith(AndroidJUnit4::class)
class CloudAccountTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
        protocols = listOf(Protocol.HTTP_1_1)
        start()
    }
    private val roots = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val http = OkHttpClient.Builder().sslSocketFactory(roots.sslSocketFactory(), roots.trustManager).build()
    private val origin = AgentOrigin.parse("https://localhost:${server.port}")
    private val audience = "${origin.value}/"
    private val prefs get() = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE)

    private fun account() = CloudAccount(
        scope,
        origin,
        ServerAuthClient(http),
        http,
        ExpoSecureStore(prefs, keys, keychainService = CloudAccount.KEYCHAIN_SERVICE),
    )

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun token(access: String, refresh: String = "refresh-1") =
        json("""{"access_token":"$access","token_type":"Bearer","expires_in":900,"refresh_token":"$refresh"}""")

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
        prefs.edit().clear().commit()
    }

    /** Opens the page, comes back with a code, and waits until signed in. */
    private fun signIn(account: CloudAccount, access: String) = runBlocking {
        val page = account.browserUrl().toHttpUrl()
        assertEquals("/authorize", page.encodedPath)
        assertEquals("happy", page.queryParameter("client_id"))
        assertEquals(audience, page.queryParameter("resource"))
        assertEquals("S256", page.queryParameter("code_challenge_method"))
        server.enqueue(token(access))
        account.callback("happy://oauth/callback?code=c1&state=${page.queryParameter("state")}")
        withTimeout(5_000) { account.state.first { it == CloudAccountState.SignedIn || it is CloudAccountState.Failed } }
        val exchange = server.takeRequest()
        assertEquals("/token", exchange.target)
        assertEquals(true, exchange.body?.utf8()?.contains("resource=" + java.net.URLEncoder.encode(audience, "UTF-8")))
    }

    @Test
    fun signsInForTheAccountsOriginAndStaysSignedIn() = runBlocking {
        val account = account()
        assertEquals(CloudAccountState.SignedOut, account.state.value)
        signIn(account, jwt(audience, tag = "a1"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        // A restart reads the kept refresh token: still signed in, with no page.
        assertEquals(CloudAccountState.SignedIn, account().state.value)
    }

    @Test
    fun aTokenForAnotherAudienceIsRefused() = runBlocking {
        val account = account()
        signIn(account, jwt("https://acme.example/", tag = "a1"))
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.WrongAudience), account.state.value)
        assertEquals(CloudAccountState.SignedOut, account().state.value)
    }

    @Test
    fun aCallbackForAnotherSignInIsIgnored() {
        val account = account()
        account.browserUrl()
        account.callback("happy://oauth/callback?code=c1&state=someone-elses")
        assertEquals(CloudAccountState.InBrowser, account.state.value)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun listsServersWithTheAccountToken() = runBlocking {
        val access = jwt(audience, tag = "a1")
        val account = account()
        signIn(account, access)
        server.enqueue(json("""{"servers":[{"id":"s1","name":"acme","url":"https://acme.happy.computer/","role":"owner","createdAt":"2026-11-06T00:00:00Z","extra":1}]}"""))
        val servers = account.servers()
        assertEquals(listOf(CloudServer("s1", "acme", "https://acme.happy.computer/", "owner", "2026-11-06T00:00:00Z")), servers)
        assertEquals("https://acme.happy.computer", servers.single().origin)
        val request = server.takeRequest()
        assertEquals("/v1/servers", request.target)
        assertEquals("Bearer $access", request.headers["Authorization"])
    }

    @Test
    fun availabilityCreateAndJoinReadTheContractsAnswers() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        server.enqueue(json("""{"name":"acme","available":true}"""))
        server.enqueue(json("""{"name":"acme","available":false,"reason":"taken"}"""))
        server.enqueue(json("""{"name":"api","available":false,"reason":"reserved"}"""))
        server.enqueue(json("""{"name":"-x","available":false,"reason":"invalid"}"""))
        assertEquals(CloudName.Available, account.availability("acme"))
        assertEquals(CloudName.Taken, account.availability("acme"))
        assertEquals(CloudName.Reserved, account.availability("api"))
        assertEquals(CloudName.Invalid, account.availability("-x"))
        assertEquals("/v1/servers/availability?name=acme", server.takeRequest().target)
        repeat(3) { server.takeRequest() }

        server.enqueue(json("""{"server":{"id":"s1","name":"acme","url":"https://acme.happy.computer/","role":"owner"}}""", 201))
        assertEquals("acme", account.create("acme").name)
        val create = server.takeRequest()
        assertEquals("POST /v1/servers", "${create.method} ${create.target}")
        assertEquals("""{"name":"acme"}""", create.body?.utf8())

        server.enqueue(json("""{"code":"taken","error":"Name taken"}""", 409))
        assertFails(CloudException.Reason.Taken) { account.create("acme") }
        server.enqueue(json("""{"code":"invalid","error":"Bad name"}""", 400))
        assertFails(CloudException.Reason.Invalid) { account.create("a") }
        repeat(2) { server.takeRequest() }

        server.enqueue(json("""{"server":{"id":"s2","name":"beta","url":"https://beta.happy.computer/","role":"member"}}"""))
        assertEquals("member", account.join("beta", "ABCD1234").role)
        val join = server.takeRequest()
        assertEquals("POST /v1/servers/join", "${join.method} ${join.target}")
        assertEquals("""{"name":"beta","code":"ABCD1234"}""", join.body?.utf8())
        server.enqueue(json("""{"code":"not_found","error":"No such server"}""", 404))
        assertFails(CloudException.Reason.NotFound) { account.join("beta", "WRONG") }
    }

    @Test
    fun a401RefreshesOnceAndRetries() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        val fresh = jwt(audience, tag = "a2")
        server.enqueue(json("""{"code":"unauthorized","error":"expired"}""", 401))
        server.enqueue(token(fresh, refresh = "refresh-2"))
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        server.takeRequest()
        val refresh = server.takeRequest()
        assertEquals("/token", refresh.target)
        assertEquals(true, refresh.body?.utf8()?.contains("grant_type=refresh_token"))
        assertEquals("Bearer $fresh", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun aRefusedRefreshSignsTheAccountOut() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        server.enqueue(json("""{"code":"unauthorized","error":"expired"}""", 401))
        server.enqueue(json("""{"error":"invalid_grant"}""", 400))
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(CloudAccountState.SignedOut, account.state.value)
        assertEquals(CloudAccountState.SignedOut, account().state.value)
    }

    private suspend fun assertFails(reason: CloudException.Reason, block: suspend () -> Unit) {
        try {
            block()
            fail("expected $reason")
        } catch (e: CloudException) {
            assertEquals(reason, e.reason)
        }
    }
}
