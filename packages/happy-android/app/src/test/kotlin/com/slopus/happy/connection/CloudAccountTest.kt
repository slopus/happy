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
 * The Happy Cloud account against a fake accounts service ([accounts]),
 * which only signs in for an identity token, and a fake cluster API
 * ([server]), which turns it into the account's session: held in memory
 * only, refreshed at the API's `/token` as it runs out and once on a 401,
 * ended when a refresh is refused but kept when one can't be asked. The
 * API's answers as the picker reads them, and each server's own token.
 */
@RunWith(AndroidJUnit4::class)
class CloudAccountTest {
    private var now = 1_000_000L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
    private fun mock() = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
        protocols = listOf(Protocol.HTTP_1_1)
        start()
    }
    /** The accounts service: identity tokens only. */
    private val accounts = mock()
    /** The cluster's API: the session, servers, invites and every refresh. */
    private val server = mock()
    private val roots = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val http = OkHttpClient.Builder().sslSocketFactory(roots.sslSocketFactory(), roots.trustManager).build()
    private val accountsOrigin = AgentOrigin.parse("https://localhost:${accounts.port}")
    private val origin = AgentOrigin.parse("https://localhost:${server.port}")
    /** The account session's audience: the API. */
    private val audience = "${origin.value}/"

    private fun account() = CloudAccount(scope, accountsOrigin, origin, ServerAuthClient(http, now = { now }), http, now = { now })

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    /** The accounts service's answer: a five-minute identity token for this app's client, `happy`. */
    private fun identity(aud: String = "happy", tag: String = "id1") = json("""{"id_token":"${jwt(aud, tag = tag)}","expires_in":300}""")

    /** `POST /v1/session`'s answer: the account's session, an hour's access token and a refresh token. */
    private fun session(access: String, refresh: String = "r1") = json("""{"access_token":"$access","refresh_token":"$refresh","expires_in":3600}""")

    /** The API's `/token` answer to a refresh: a new access token and the rotated refresh token. */
    private fun refreshed(access: String, refresh: String) = json("""{"access_token":"$access","token_type":"Bearer","refresh_token":"$refresh","expires_in":3600}""")

    @After
    fun tearDown() {
        scope.cancel()
        accounts.close()
        server.close()
    }

    /** Opens the page, comes back with a code, and waits until signed in (or not). */
    private fun signIn(account: CloudAccount, access: String, provider: CloudProvider = CloudProvider.GitHub, refresh: String = "r1") = runBlocking {
        val page = account.browserUrl(provider).toHttpUrl()
        // The service goes straight to that provider, past its own chooser.
        assertEquals(provider.id, page.queryParameter("provider"))
        assertEquals(accounts.port, page.port)
        assertEquals("/authorize", page.encodedPath)
        assertEquals("happy", page.queryParameter("client_id"))
        // Identity only: no resource.
        assertEquals("openid", page.queryParameter("scope"))
        assertEquals(null, page.queryParameter("resource"))
        assertEquals("S256", page.queryParameter("code_challenge_method"))
        accounts.enqueue(identity())
        server.enqueue(session(access, refresh))
        account.callback("happy://oauth/callback?code=c1&state=${page.queryParameter("state")}")
        withTimeout(5_000) { account.state.first { it == CloudAccountState.SignedIn || it is CloudAccountState.Failed } }
        val exchange = accounts.takeRequest()
        assertEquals("/token", exchange.target)
        assertEquals(false, exchange.body?.utf8()?.contains("resource="))
        if (account.state.value == CloudAccountState.SignedIn) assertSession(server.takeRequest())
    }

    /** `POST /v1/session` at the API, with the identity token and nothing else. */
    private fun assertSession(request: mockwebserver3.RecordedRequest, tag: String = "id1") {
        assertEquals("POST /v1/session", "${request.method} ${request.target}")
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"id_token":"${jwt("happy", tag = tag)}"}""", request.body?.utf8())
    }

    @Test
    fun signsInForASessionAndKeepsNothing() = runBlocking {
        val account = account()
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        signIn(account, jwt(audience, tag = "a1"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        assertEquals(true, account.signedIn())
        // Nothing is kept: a restart is signed out.
        assertEquals(CloudAccountState.SignedOut(), account().state.value)
        // Past the access token's hour the refresh token carries it, for its 30 days.
        now += 2 * 3_600_000L
        assertEquals(true, account.signedIn())
        now += 30L * 24 * 3_600_000
        assertEquals(false, account.signedIn())
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        assertEquals(1, accounts.requestCount)
        assertEquals(1, server.requestCount)
    }

    /** Apple is the same web sign-in, the service sent to Apple instead. */
    @Test
    fun signsInWithAppleTheSameWay() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"), CloudProvider.Apple)
        assertEquals(CloudAccountState.SignedIn, account.state.value)
    }

    /**
     * The session refreshes at the API's `/token`, rotating its refresh
     * token: before an access token near its end is sent, and once on a
     * 401. Nothing goes to the accounts service after the sign-in.
     */
    @Test
    fun theSessionRefreshesAtTheAPI() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        // Within two minutes of its hour: refreshed first.
        now += 3_600_000L - 119_000L
        val a2 = jwt(audience, tag = "a2")
        server.enqueue(refreshed(a2, "r2"))
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        val refresh = server.takeRequest()
        assertEquals("POST /token", "${refresh.method} ${refresh.target}")
        assertEquals(null, refresh.headers["Authorization"])
        assertEquals(
            "grant_type=refresh_token&refresh_token=r1&client_id=happy&resource=" + java.net.URLEncoder.encode(audience, "UTF-8"),
            refresh.body?.utf8(),
        )
        assertEquals("Bearer $a2", server.takeRequest().headers["Authorization"])
        // A 401: refreshed once, with the rotated token, and sent again.
        val a3 = jwt(audience, tag = "a3")
        server.enqueue(json("""{"code":"unauthorized"}""", 401))
        server.enqueue(refreshed(a3, "r3"))
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $a2", server.takeRequest().headers["Authorization"])
        assertEquals(true, server.takeRequest().body?.utf8()?.contains("refresh_token=r2&"))
        assertEquals("Bearer $a3", server.takeRequest().headers["Authorization"])
        // A refresh for another audience is no session.
        server.enqueue(json("""{"code":"unauthorized"}""", 401))
        server.enqueue(refreshed(jwt("https://acme.example/", tag = "x"), "r4"))
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        assertEquals(1, accounts.requestCount)
    }

    /** A refresh that couldn't be asked (offline, any 5xx, a 429) keeps the session; a refused one (400 `invalid_grant`) ends it. */
    @Test
    fun anUnreachableRefreshKeepsTheSessionARefusedOneEndsIt() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        for (answer in listOf(
            json("""{"error":"temporarily_unavailable"}""", 503),
            json("""{"error":"server_error"}""", 500),
            MockResponse.Builder().code(502).addHeader("Content-Type", "text/html").body("<html>Bad Gateway</html>").build(),
            MockResponse.Builder().code(429).addHeader("Content-Type", "text/html").body("<html>Too Many Requests</html>").build(),
        )) {
            server.enqueue(json("""{"code":"unauthorized"}""", 401))
            server.enqueue(answer)
            assertFails(CloudException.Reason.Unreachable) { account.servers() }
            assertEquals(CloudAccountState.SignedIn, account.state.value)
            assertEquals(true, account.signedIn())
        }
        // The same refresh token again, as nothing rotated it.
        server.enqueue(json("""{"code":"unauthorized"}""", 401))
        server.enqueue(json("""{"error":"invalid_grant"}""", 400))
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        repeat(2 * 4 + 1) { server.takeRequest() }
        assertEquals(true, server.takeRequest().body?.utf8()?.contains("refresh_token=r1&"))
        // Over: nothing more is sent.
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(1 + 2 * 5, server.requestCount)
    }

    /** The identity token must name this app; the session must be the API's. */
    @Test
    fun aTokenForAnotherAudienceIsRefused() = runBlocking {
        val account = account()
        val page = account.browserUrl(CloudProvider.GitHub).toHttpUrl()
        accounts.enqueue(identity(aud = "happy-web"))
        account.callback("happy://oauth/callback?code=c1&state=${page.queryParameter("state")}")
        withTimeout(5_000) { account.state.first { it is CloudAccountState.Failed } }
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.WrongAudience), account.state.value)
        // Never sent on to the API.
        assertEquals(0, server.requestCount)
        account.reset()
        signIn(account, jwt("https://acme.example/", tag = "a1"))
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.WrongAudience), account.state.value)
        assertEquals(false, account.signedIn())
    }

    /** The API refusing the identity token (401 `invalid_token`) is a failed sign-in, never a session. */
    @Test
    fun aRefusedIdentityTokenSignsNothingIn() = runBlocking {
        val account = account()
        val page = account.browserUrl(CloudProvider.GitHub).toHttpUrl()
        accounts.enqueue(identity())
        server.enqueue(json("""{"code":"invalid_token","error":"That sign-in could not be verified."}""", 401))
        account.callback("happy://oauth/callback?code=c1&state=${page.queryParameter("state")}")
        withTimeout(5_000) { account.state.first { it is CloudAccountState.Failed } }
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.Rejected), account.state.value)
        assertEquals(false, account.signedIn())
    }

    @Test
    fun aCallbackForAnotherSignInIsIgnored() {
        val account = account()
        account.browserUrl(CloudProvider.GitHub)
        account.callback("happy://oauth/callback?code=c1&state=someone-elses")
        assertEquals(CloudAccountState.InBrowser, account.state.value)
        assertEquals(0, accounts.requestCount + server.requestCount)
    }

    @Test
    fun aTestAccountSignsInWithItsPasswordForTheSameSession() = runBlocking {
        val account = account()
        val access = jwt(audience, tag = "p1")
        accounts.enqueue(identity())
        server.enqueue(session(access))
        assertEquals(PasswordSignIn.SignedIn, account.signInWithPassword("qa-android", "s3cret pass"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        val request = accounts.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v2/auth/password", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"login":"qa-android","password":"s3cret pass"}""", request.body?.utf8())
        assertSession(server.takeRequest())
        // From here it is the browser's session.
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $access", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun aWrongPasswordOrALockoutLeavesItSignedOut() = runBlocking {
        val account = account()
        accounts.enqueue(json("""{"code":"invalid_credentials"}""", code = 401))
        assertEquals(PasswordSignIn.Wrong, account.signInWithPassword("qa-android", "nope"))
        accounts.enqueue(json("""{"code":"locked","retryAfter":61}""", code = 429))
        assertEquals(PasswordSignIn.Locked(2), account.signInWithPassword("qa-android", "nope"))
        accounts.enqueue(json("""{"code":"locked"}""", code = 429))
        assertEquals(PasswordSignIn.Locked(15), account.signInWithPassword("qa-android", "nope"))
        accounts.enqueue(json("""{"code":"internal"}""", code = 503))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Unreachable), account.signInWithPassword("qa-android", "pw"))
        accounts.enqueue(json("""{"code":"not_found"}""", code = 404))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Failed), account.signInWithPassword("qa-android", "pw"))
        accounts.enqueue(json("""{"token_type":"Bearer"}"""))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Failed), account.signInWithPassword("qa-android", "pw"))
        // A good password, but the API couldn't make the session.
        accounts.enqueue(identity())
        server.enqueue(json("""{"code":"internal"}""", code = 503))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Unreachable), account.signInWithPassword("qa-android", "pw"))
        accounts.enqueue(identity())
        server.enqueue(json("""{"code":"invalid_token"}""", code = 401))
        assertEquals(PasswordSignIn.Failed(CloudException.Reason.Failed), account.signInWithPassword("qa-android", "pw"))
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        assertEquals(false, account.signedIn())
    }

    /** Google on the phone: the ID token and the raw nonce it was asked with go to the native route, for the same session. */
    @Test
    fun signsInWithGoogleOnThePhoneForTheSameSession() = runBlocking {
        val account = account()
        val access = jwt(audience, tag = "g1")
        accounts.enqueue(identity())
        server.enqueue(session(access))
        var asked: String? = null
        val signedIn = account.signInWithGoogle { nonce ->
            asked = nonce
            // The welcome waits while Google's sheet is up.
            assertEquals(CloudAccountState.Finishing, account.state.value)
            GoogleCredential.Token("google.id.token")
        }
        assertEquals(true, signedIn)
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        val nonce = requireNotNull(asked)
        // 32 random bytes, base64url without padding.
        assertEquals(true, Regex("[A-Za-z0-9_-]{43}").matches(nonce))
        val request = accounts.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v2/auth/native", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("application/json; charset=utf-8", request.headers["Content-Type"])
        assertEquals("""{"provider":"google","idToken":"google.id.token","nonce":"$nonce"}""", request.body?.utf8())
        assertSession(server.takeRequest())
        // From here it is the browser's session.
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $access", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun eachGoogleSignInHasAFreshNonce() = runBlocking {
        val account = account()
        val nonces = mutableListOf<String>()
        repeat(2) { account.signInWithGoogle { nonces += it; GoogleCredential.Cancelled } }
        assertEquals(2, nonces.toSet().size)
        assertEquals(0, accounts.requestCount + server.requestCount)
    }

    /** A refused ID token (401 `invalid_token`) is a failed sign-in, not an ended session; nor is any other bad answer a session. */
    @Test
    fun aRefusedGoogleSignInSaysWhyAndSignsNothingIn() = runBlocking {
        val account = account()
        val google: suspend (String) -> GoogleCredential = { GoogleCredential.Token("id") }
        for ((answer, reason) in listOf(
            json("""{"code":"invalid_token","error":"That sign-in could not be verified."}""", code = 401) to ServerAuthException.Reason.Rejected,
            json("""{"code":"unsupported_provider"}""", code = 400) to ServerAuthException.Reason.Denied,
            json("""{"code":"internal"}""", code = 503) to ServerAuthException.Reason.Unreachable,
            json("""{"access_token":"x","token_type":"Bearer"}""") to ServerAuthException.Reason.InvalidToken,
            identity(aud = "https://acme.example/") to ServerAuthException.Reason.WrongAudience,
        )) {
            accounts.enqueue(answer)
            assertEquals(true, account.signInWithGoogle(google))
            assertEquals(CloudAccountState.Failed(reason), account.state.value)
            assertEquals(false, account.signedIn())
        }
        assertEquals(5, accounts.requestCount)
        // None of them reached the API.
        assertEquals(0, server.requestCount)
        // The API's refusal of a good one.
        accounts.enqueue(identity())
        server.enqueue(json("""{"code":"invalid_token"}""", code = 401))
        assertEquals(true, account.signInWithGoogle(google))
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.Rejected), account.state.value)
    }

    /** Closing Google's sheet says nothing; no Google account here asks for the browser's sign-in; a broken one says it failed. */
    @Test
    fun aCancelIsSilentAndNoAccountFallsBackToTheBrowser() = runBlocking {
        val account = account()
        assertEquals(true, account.signInWithGoogle { GoogleCredential.Cancelled })
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        assertEquals(false, account.signInWithGoogle { GoogleCredential.Unavailable })
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        // The browser's sign-in goes straight to Google.
        assertEquals("google", account.browserUrl(CloudProvider.Google).toHttpUrl().queryParameter("provider"))
        assertEquals(true, account.signInWithGoogle { GoogleCredential.Failed })
        assertEquals(CloudAccountState.Failed(ServerAuthException.Reason.Denied), account.state.value)
        assertEquals(0, accounts.requestCount + server.requestCount)
    }

    /** Google's browser sign-in is the same web sign-in as Apple's and GitHub's. */
    @Test
    fun signsInWithGoogleInTheBrowserTheSameWay() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"), CloudProvider.Google)
        assertEquals(CloudAccountState.SignedIn, account.state.value)
    }

    @Test
    fun anEmailCodeIsAskedForWithNoToken() = runBlocking {
        val account = account()
        accounts.enqueue(json("{}", code = 202))
        assertEquals(EmailSignIn.Sent, account.startEmail("ada@example.com"))
        val request = accounts.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v2/auth/email/start", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"email":"ada@example.com"}""", request.body?.utf8())
        // Asking is not signing in.
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
    }

    @Test
    fun anEmailCodeSignsInForTheSameSessionAsAPassword() = runBlocking {
        val account = account()
        val access = jwt(audience, tag = "e1")
        accounts.enqueue(identity())
        server.enqueue(session(access))
        assertEquals(EmailSignIn.SignedIn, account.verifyEmail("ada@example.com", "123456"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        val request = accounts.takeRequest()
        assertEquals("/v2/auth/email/verify", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"email":"ada@example.com","code":"123456"}""", request.body?.utf8())
        assertSession(server.takeRequest())
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $access", server.takeRequest().headers["Authorization"])
    }

    /** Each refusal by its `code`, the same from either endpoint, and the account still signed out. */
    @Test
    fun anEmailRefusalSaysWhy() = runBlocking {
        val account = account()
        for (path in listOf("start", "verify")) {
            suspend fun ask() = if (path == "start") account.startEmail("ada@example.com") else account.verifyEmail("ada@example.com", "123456")
            accounts.enqueue(json("""{"code":"invalid_email","error":"Enter a valid email address."}""", code = 400))
            assertEquals(EmailSignIn.InvalidEmail, ask())
            accounts.enqueue(json("""{"code":"invalid_code","error":"That code is invalid or expired."}""", code = 400))
            assertEquals(EmailSignIn.InvalidCode, ask())
            accounts.enqueue(json("""{"code":"unavailable","error":"Email sign-in is unavailable."}""", code = 502))
            assertEquals(EmailSignIn.Unavailable, ask())
            accounts.enqueue(json("""{"code":"unsupported_provider","error":"Email sign-in is not configured."}""", code = 400))
            assertEquals(EmailSignIn.Unsupported("Email sign-in is not configured."), ask())
            accounts.enqueue(json("""{"code":"unsupported_provider"}""", code = 400))
            assertEquals(EmailSignIn.Unsupported(null), ask())
            accounts.enqueue(json("""{"code":"internal"}""", code = 503))
            assertEquals(EmailSignIn.Failed(CloudException.Reason.Unreachable), ask())
            accounts.enqueue(json("""{"code":"something_new"}""", code = 400))
            assertEquals(EmailSignIn.Failed(CloudException.Reason.Failed), ask())
            accounts.enqueue(MockResponse.Builder().code(404).body("not json").build())
            assertEquals(EmailSignIn.Failed(CloudException.Reason.Failed), ask())
        }
        // A 200 with no token is no sign-in.
        accounts.enqueue(json("""{"token_type":"Bearer"}"""))
        assertEquals(EmailSignIn.Failed(CloudException.Reason.Failed), account.verifyEmail("ada@example.com", "123456"))
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        assertEquals(false, account.signedIn())
    }

    /** A 429 waits for its Retry-After, else the body's retryAfter, else a minute; its words are the service's. */
    @Test
    fun anEmailRateLimitSaysHowLong() = runBlocking {
        val account = account()
        val limited = """{"code":"rate_limited","error":"Too many requests. Try again later.","retryAfter":42}"""
        accounts.enqueue(MockResponse.Builder().code(429).addHeader("Content-Type", "application/json").addHeader("Retry-After", "37").body(limited).build())
        assertEquals(EmailSignIn.RateLimited(37, "Too many requests. Try again later."), account.startEmail("ada@example.com"))
        accounts.enqueue(json(limited, code = 429))
        assertEquals(EmailSignIn.RateLimited(42, "Too many requests. Try again later."), account.verifyEmail("ada@example.com", "123456"))
        accounts.enqueue(json("""{"code":"rate_limited"}""", code = 429))
        assertEquals(EmailSignIn.RateLimited(60, null), account.startEmail("ada@example.com"))
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
    }

    @Test
    fun anEmailSignInOfflineIsUnreachable() = runBlocking {
        val account = account()
        accounts.close()
        assertEquals(EmailSignIn.Failed(CloudException.Reason.Unreachable), account.startEmail("ada@example.com"))
        assertEquals(EmailSignIn.Failed(CloudException.Reason.Unreachable), account.verifyEmail("ada@example.com", "123456"))
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
    fun aPictureIsFetchedWithTheSessionOnlyFromTheAPI() = runBlocking {
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
        // Nor the accounts service: the session is the API's.
        assertEquals(null, account.image("${accountsOrigin.value}/v1/servers/s1/image"))
        assertEquals(2, server.requestCount)
        assertEquals(1, accounts.requestCount)
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
    fun removingAServerRevokesItsRefreshTokenAtTheAPIWithNoSession() = runBlocking {
        val account = account()
        val issued = OAuthCredential("happy-accounts", "happy", "${origin.value}/token", "server-refresh", "https://acme.happy.computer/")
        assertEquals(true, account.issued(issued))
        server.enqueue(json("{}"))
        account.revoke(issued)
        val revoke = server.takeRequest()
        assertEquals("POST /revoke", "${revoke.method} ${revoke.target}")
        assertEquals(null, revoke.headers["Authorization"])
        assertEquals("token=server-refresh&token_type_hint=refresh_token&client_id=happy", revoke.body?.utf8())
        // A session refreshed elsewhere (another service, an earlier build's at the accounts service, or none) is never sent.
        val earlier = OAuthCredential("happy-accounts", "happy", "${accountsOrigin.value}/token", "old-refresh", "https://acme.happy.computer/")
        assertEquals(false, account.issued(earlier))
        account.revoke(earlier)
        account.revoke(OAuthCredential("jwt", "happy", "https://sso.acme.example/token", "theirs", null))
        account.revoke(OAuthCredential("happy-accounts", "happy", "${origin.value}/token", null, null))
        kotlinx.coroutines.delay(200)
        assertEquals(1, server.requestCount)
        assertEquals(0, accounts.requestCount)
    }

    @Test
    fun signingOutRevokesTheSessionOnly() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"), refresh = "session-refresh")
        server.enqueue(json("{}"))
        account.signOut()
        assertEquals(CloudAccountState.SignedOut(expired = false), account.state.value)
        val revoke = server.takeRequest()
        assertEquals("POST /revoke", "${revoke.method} ${revoke.target}")
        assertEquals(null, revoke.headers["Authorization"])
        assertEquals("token=session-refresh&token_type_hint=refresh_token&client_id=happy", revoke.body?.utf8())
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun serversListedWithoutARoleStillRead() = runBlocking {
        // Since the roles cutover the accounts service lists no role: the server holds it.
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        server.enqueue(json("""{"servers":[{"createdAt":"2026-11-07T14:07:45Z","displayName":"probe","id":"s1","image":null,"name":"probe","url":"https://probe.happy.computer/","webUrl":"https://probe.happybases.com/"}]}"""))
        val listed = account.servers().single()
        assertEquals("s1", listed.id)
        assertEquals(null, listed.role)
    }

    @Test
    fun availabilityAndCreateReadTheContractsAnswers() = runBlocking {
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
    }

    @Test
    fun a401AfterARefreshSignsTheAccountOut() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        server.enqueue(json("""{"code":"unauthorized","error":"A valid account token is required."}""", 401))
        server.enqueue(refreshed(jwt(audience, tag = "a2"), "r2"))
        server.enqueue(json("""{"code":"unauthorized","error":"A valid account token is required."}""", 401))
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
        // The session, the refused call, one refresh and the second try: no more.
        assertEquals(4, server.requestCount)
        assertFails(CloudException.Reason.SignInRequired) { account.servers() }
        assertEquals(4, server.requestCount)
    }

    private val invite = CloudInvite("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde")

    /** The preview reads before any sign-in, with no session; the accept is the account's. */
    @Test
    fun anInvitePreviewsSignedOutAndAcceptsSignedIn() = runBlocking {
        val account = account()
        server.enqueue(json("""{"server":{"name":"acme","displayName":"Acme","image":"data:image/png;base64,iVBORw0KGgo="},"roleName":"Viewer","expiresAt":"2026-11-19T09:28:08.851234Z","inviter":{"name":"Ada Lovelace","image":null}}"""))
        val preview = account.previewInvite(invite)
        assertEquals("Acme", preview.server.title)
        assertEquals("@acme", "@${preview.server.name}")
        assertEquals("Viewer", preview.roleName)
        assertEquals(CloudInviter("Ada Lovelace", image = null), preview.inviter)
        assertEquals("data:image/png;base64,iVBORw0KGgo=", preview.server.image?.url)
        assertEquals(listOf(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), inviteImage(preview.server.image!!.url)!!.map { it.toInt() and 0xFF })
        assertEquals(null, inviteImage("https://evil.example/a.png"))
        val asked = server.takeRequest()
        assertEquals("POST /v1/invites/preview", "${asked.method} ${asked.target}")
        assertEquals("""{"token":"${invite.token}"}""", asked.body?.utf8())
        assertEquals(null, asked.headers["Authorization"])

        // Signed out, the accept asks for the sign-in and sends nothing.
        assertFails(CloudException.Reason.SignInRequired) { account.acceptInvite(invite) }
        assertEquals(1, server.requestCount)
        assertEquals(0, accounts.requestCount)

        val pass = jwt(audience, tag = "a1")
        signIn(account, pass)
        server.enqueue(json("""{"server":{"id":"6f1c","name":"acme","displayName":"acme","url":"https://acme.happy.computer/","webUrl":"https://acme.happybases.com/","image":null,"createdAt":"2026-11-12T09:00:00Z"}}"""))
        val joined = account.acceptInvite(invite)
        assertEquals("6f1c", joined.id)
        assertEquals("https://acme.happy.computer", joined.origin)
        val accept = server.takeRequest()
        assertEquals("POST /v1/invites/accept", "${accept.method} ${accept.target}")
        assertEquals("Bearer $pass", accept.headers["Authorization"])
        assertEquals("""{"token":"${invite.token}"}""", accept.body?.utf8())
    }

    @Test
    fun anInviteThatCantBeUsedSaysWhy() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"))
        val answers = listOf(
            json("""{"code":"expired","error":"Expired"}""", 410) to CloudInviteRefusal.Expired,
            json("""{"code":"revoked","error":"Revoked"}""", 410) to CloudInviteRefusal.Revoked,
            json("""{"code":"exhausted","error":"Used up"}""", 410) to CloudInviteRefusal.UsedUp,
            json("""{"code":"accepted","error":"Already accepted"}""", 410) to CloudInviteRefusal.Accepted,
            json("""{"code":"invalid","error":"No such invite"}""", 410) to CloudInviteRefusal.Unknown,
            json("""{"code":"email_mismatch","error":"Wrong email","emailHint":"s…@…"}""", 403) to CloudInviteRefusal.EmailMismatch("s…@…"),
        )
        for ((answer, refusal) in answers) {
            server.enqueue(answer)
            try {
                account.acceptInvite(invite)
                fail("expected $refusal")
            } catch (e: CloudInviteException) {
                assertEquals(refusal, e.refusal)
            }
        }
        server.enqueue(json("""{"code":"unavailable","error":"Try again"}""", 503))
        assertFails(CloudException.Reason.Unreachable) { account.previewInvite(invite) }
        // A 401 on the accept, and the refresh refused: the session is over.
        server.enqueue(json("""{"code":"unauthorized"}""", 401))
        server.enqueue(json("""{"error":"invalid_grant"}""", 400))
        assertFails(CloudException.Reason.SignInRequired) { account.acceptInvite(invite) }
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
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
