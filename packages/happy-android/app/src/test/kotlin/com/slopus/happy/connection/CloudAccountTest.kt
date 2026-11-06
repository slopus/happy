package com.slopus.happy.connection

import androidx.test.ext.junit.runners.AndroidJUnit4
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
 * PKCE for the accounts origin, a pass for its hour held in memory only and
 * never refreshed (a 401 or the hour up signs it out), the accounts API's
 * answers as the picker reads them, and each server's own token.
 */
@RunWith(AndroidJUnit4::class)
class CloudAccountTest {
    private var now = 1_000_000L
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

    private fun account() = CloudAccount(scope, origin, ServerAuthClient(http, now = { now }), http, now = { now })

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    /** The account's pass, as v4's token endpoint answers: an hour, no refresh token. */
    private fun token(access: String) = json("""{"access_token":"$access","token_type":"Bearer","expires_in":3600}""")

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
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
    fun signsInForAnHourAndKeepsNothing() = runBlocking {
        val account = account()
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        signIn(account, jwt(audience, tag = "a1"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        assertEquals(true, account.signedIn())
        // Nothing is kept: a restart is signed out.
        assertEquals(CloudAccountState.SignedOut(), account().state.value)
        // Within two minutes of its hour, the + opens on the sign-in, saying why.
        now += 3_600_000L - 119_000L
        assertEquals(false, account.signedIn())
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun aPassPastItsHourIsNeverSent() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        now += 3_600_000L
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun aTokenForAnotherAudienceIsRefused() = runBlocking {
        val account = account()
        signIn(account, jwt("https://acme.example/", tag = "a1"))
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.WrongAudience), account.state.value)
        assertEquals(false, account.signedIn())
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
    fun aTestAccountSignsInWithItsPasswordForTheSameHour() = runBlocking {
        val account = account()
        val access = jwt(audience, tag = "p1")
        server.enqueue(token(access))
        assertEquals(PasswordSignIn.SignedIn, account.signInWithPassword("qa-android", "s3cret pass"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/auth/password", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"login":"qa-android","password":"s3cret pass"}""", request.body?.utf8())
        // From here it is the browser's pass: servers with it, and signed out at its hour.
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $access", server.takeRequest().headers["Authorization"])
        now += 3_600_000L - 119_000L
        assertEquals(false, account.signedIn())
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
    }

    @Test
    fun aWrongPasswordOrALockoutLeavesItSignedOut() = runBlocking {
        val account = account()
        server.enqueue(json("""{"code":"invalid_credentials"}""", code = 401))
        assertEquals(PasswordSignIn.Wrong, account.signInWithPassword("qa-android", "nope"))
        server.enqueue(json("""{"code":"locked","retryAfter":61}""", code = 429))
        assertEquals(PasswordSignIn.Locked(2), account.signInWithPassword("qa-android", "nope"))
        server.enqueue(json("""{"code":"locked"}""", code = 429))
        assertEquals(PasswordSignIn.Locked(15), account.signInWithPassword("qa-android", "nope"))
        server.enqueue(json("""{"code":"internal"}""", code = 503))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Unreachable), account.signInWithPassword("qa-android", "pw"))
        server.enqueue(json("""{"code":"not_found"}""", code = 404))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Failed), account.signInWithPassword("qa-android", "pw"))
        server.enqueue(json("""{"token_type":"Bearer"}"""))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Failed), account.signInWithPassword("qa-android", "pw"))
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        assertEquals(false, account.signedIn())
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
    fun aServersDisplayNameAndPictureAreRead() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        val url = "${origin.value}/v1/servers/s1/image?v=abc"
        server.enqueue(
            json(
                """{"servers":[""" +
                    """{"id":"s1","name":"acme","url":"https://acme.happy.computer/","role":"owner","displayName":"Acme Inc","image":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI","width":512,"height":512,"url":"$url"}},""" +
                    """{"id":"s2","name":"beta","url":"https://beta.happy.computer/","role":"member","displayName":null,"image":null}]}""",
            ),
        )
        val (acme, beta) = account.servers()
        assertEquals("Acme Inc", acme.title)
        assertEquals(CloudServerImage("1QcSHQRnh493V4dIh4eXh1h4kJUI", 512, 512, url), acme.image)
        assertEquals("beta", beta.title)
        assertEquals(null, beta.image)
    }

    @Test
    fun aPictureIsFetchedWithTheAccountTokenOnlyFromTheAccountsOrigin() = runBlocking {
        val access = jwt(audience, tag = "a1")
        val account = account()
        signIn(account, access)
        val url = "${origin.value}/v1/servers/s1/image?v=abc"
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "image/png").body(okio.Buffer().write(byteArrayOf(1, 2, 3))).build())
        assertEquals(listOf<Byte>(1, 2, 3), account.image(url)?.toList())
        val request = server.takeRequest()
        assertEquals("/v1/servers/s1/image?v=abc", request.target)
        assertEquals("Bearer $access", request.headers["Authorization"])
        // Its URL names its digest: the second ask is answered from memory.
        assertEquals(listOf<Byte>(1, 2, 3), account.image(url)?.toList())
        assertEquals(2, server.requestCount)
        assertEquals(null, account.image("https://elsewhere.example/v1/servers/s1/image"))
        assertEquals(null, account.image("https://localhost:1/v1/servers/s1/image"))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun aServersTokenComesFromTheAccountWithNoBrowser() = runBlocking {
        val access = jwt(audience, tag = "a1")
        val account = account()
        signIn(account, access)
        val acme = AgentOrigin.parse("https://acme.happy.computer")
        val serverAccess = jwt("https://acme.happy.computer/", "https://api.happy.computer/", tag = "s1")
        server.enqueue(json("""{"access_token":"$serverAccess","refresh_token":"server-refresh","expires_in":900}"""))
        val (grant, credential) = account.serverToken(acme, id = "s1")
        val request = server.takeRequest()
        assertEquals("POST /v1/servers/s1/token", "${request.method} ${request.target}")
        assertEquals("Bearer $access", request.headers["Authorization"])
        assertEquals(serverAccess, grant.access.value)
        assertEquals("server-refresh", grant.refreshToken)
        assertEquals(OAuthCredential("happy-accounts", "happy", "${origin.value}/token", "server-refresh", "https://acme.happy.computer/"), credential)
        // The server's session lives on without the account: refreshed at /token with its own refresh token, even past the account's hour.
        now += 2 * 3_600_000L
        val renewed = jwt("https://acme.happy.computer/", tag = "s2")
        server.enqueue(json("""{"access_token":"$renewed","token_type":"Bearer","expires_in":900,"refresh_token":"server-refresh-2"}"""))
        val (next, kept) = ServerAuthClient(http, now = { now }).refresh(credential, acme)
        assertEquals(renewed, next.value)
        assertEquals("server-refresh-2", kept.refreshToken)
        val refresh = server.takeRequest()
        assertEquals("/token", refresh.target)
        assertEquals(null, refresh.headers["Authorization"])
        val form = refresh.body?.utf8().orEmpty()
        assertEquals(true, "grant_type=refresh_token" in form && "refresh_token=server-refresh" in form && "resource=https%3A%2F%2Facme.happy.computer%2F" in form)
    }

    @Test
    fun aServersTokenIsFoundByItsOriginAndCheckedToBeItsOwn() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        val acme = AgentOrigin.parse("https://acme.happy.computer")
        server.enqueue(json("""{"servers":[{"id":"s9","name":"acme","url":"https://acme.happy.computer/","role":"member"}]}"""))
        server.enqueue(json("""{"access_token":"${jwt("https://beta.happy.computer/", tag = "s1")}","refresh_token":"r","expires_in":900}"""))
        try {
            account.serverToken(acme)
            fail("a token for another server")
        } catch (e: ServerAuthException) {
            assertEquals(ServerAuthException.Reason.WrongAudience, e.reason)
        }
        server.takeRequest()
        assertEquals("/v1/servers/s9/token", server.takeRequest().target)
        // Not one of the account's servers: refused before any token is asked for.
        server.enqueue(json("""{"servers":[]}"""))
        try {
            account.serverToken(acme)
            fail("not the account's server")
        } catch (e: ServerAuthException) {
            assertEquals(ServerAuthException.Reason.Denied, e.reason)
        }
        assertEquals(3 + 1, server.requestCount)
    }

    @Test
    fun removingAServerRevokesItsRefreshTokenWithNoAccountToken() = runBlocking {
        val account = account()
        server.enqueue(json("{}"))
        account.revoke(OAuthCredential("happy-accounts", "happy", "${origin.value}/token", "server-refresh", "https://acme.happy.computer/"))
        val revoke = server.takeRequest()
        assertEquals("POST /revoke", "${revoke.method} ${revoke.target}")
        assertEquals(null, revoke.headers["Authorization"])
        assertEquals("token=server-refresh&token_type_hint=refresh_token&client_id=happy", revoke.body?.utf8())
        // A session refreshed elsewhere (another service, or none) is never sent here.
        account.revoke(OAuthCredential("jwt", "happy", "https://sso.acme.example/token", "theirs", null))
        account.revoke(OAuthCredential("happy-accounts", "happy", "${origin.value}/token", null, null))
        kotlinx.coroutines.delay(200)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun signingOutForgetsThePassOnly() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        account.signOut()
        assertEquals(CloudAccountState.SignedOut(expired = false), account.state.value)
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun membersAndLeavingReadTheContractsAnswers() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        server.enqueue(json("""{"servers":[{"id":"s1","name":"acme","url":"https://acme.happy.computer/","role":"member"}]}"""))
        assertEquals("s1", account.serverAt("https://acme.happy.computer").id)
        server.enqueue(json("""{"servers":[]}"""))
        assertFails(CloudException.Reason.NotFound) { account.serverAt("https://acme.happy.computer") }
        server.enqueue(json("""{"members":[{"accountId":"a1","name":"Ada","role":"owner","joinedAt":"2026-11-06T00:00:00Z"},{"accountId":"a2","name":null,"role":"member"}]}"""))
        assertEquals(
            listOf(CloudMember("a1", "Ada", "owner", "2026-11-06T00:00:00Z"), CloudMember("a2", null, "member")),
            account.members("s1"),
        )
        server.enqueue(json("""{"ok":true}"""))
        account.leave("s1")
        server.enqueue(json("""{"code":"last_owner","error":"The last owner can't leave."}""", 409))
        assertFails(CloudException.Reason.LastOwner) { account.leave("s1") }
        // The two server lists asked for by serverAt.
        repeat(2) { server.takeRequest() }
        assertEquals("GET /v1/servers/s1/members", server.takeRequest().let { "${it.method} ${it.target}" })
        assertEquals("POST /v1/servers/s1/leave", server.takeRequest().let { "${it.method} ${it.target}" })
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
    fun a401SignsTheAccountOutWithNoRetry() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        server.enqueue(json("""{"code":"unauthorized","error":"A valid account token is required."}""", 401))
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        // The sign-in's exchange and the one refused call: no refresh, no second try.
        assertEquals(2, server.requestCount)
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(2, server.requestCount)
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
