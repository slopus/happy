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
    private fun signIn(account: CloudAccount, access: String, provider: CloudProvider = CloudProvider.GitHub) = runBlocking {
        val page = account.browserUrl(provider).toHttpUrl()
        // The service goes straight to that provider, past its own chooser.
        assertEquals(provider.id, page.queryParameter("provider"))
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

    /** Apple is the same web sign-in, the service sent to Apple instead. */
    @Test
    fun signsInWithAppleTheSameWay() = runBlocking {
        val account = account()
        signIn(account, jwt(audience, tag = "a1"), CloudProvider.Apple)
        assertEquals(CloudAccountState.SignedIn, account.state.value)
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
        account.browserUrl(CloudProvider.GitHub)
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

    /** Google on the phone: the ID token and the raw nonce it was asked with go to the native route, for the same hour's pass. */
    @Test
    fun signsInWithGoogleOnThePhoneForTheSameHour() = runBlocking {
        val account = account()
        val access = jwt(audience, tag = "g1")
        server.enqueue(token(access))
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
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/auth/native", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("application/json; charset=utf-8", request.headers["Content-Type"])
        assertEquals("""{"provider":"google","idToken":"google.id.token","nonce":"$nonce"}""", request.body?.utf8())
        // From here it is the browser's pass: servers with it, and signed out at its hour.
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $access", server.takeRequest().headers["Authorization"])
        now += 3_600_000L - 119_000L
        assertEquals(false, account.signedIn())
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
    }

    @Test
    fun eachGoogleSignInHasAFreshNonce() = runBlocking {
        val account = account()
        val nonces = mutableListOf<String>()
        repeat(2) { account.signInWithGoogle { nonces += it; GoogleCredential.Cancelled } }
        assertEquals(2, nonces.toSet().size)
        assertEquals(0, server.requestCount)
    }

    /** A refused ID token (401 `invalid_token`) is a failed sign-in, not an ended pass; nor is any other bad answer a pass. */
    @Test
    fun aRefusedGoogleSignInSaysWhyAndSignsNothingIn() = runBlocking {
        val account = account()
        val google: suspend (String) -> GoogleCredential = { GoogleCredential.Token("id") }
        for ((answer, reason) in listOf(
            json("""{"code":"invalid_token","error":"That sign-in could not be verified."}""", code = 401) to ServerAuthException.Reason.Rejected,
            json("""{"code":"unsupported_provider"}""", code = 400) to ServerAuthException.Reason.Denied,
            json("""{"code":"internal"}""", code = 503) to ServerAuthException.Reason.Unreachable,
            json("""{"token_type":"Bearer"}""") to ServerAuthException.Reason.InvalidToken,
            token(jwt("https://acme.example/", tag = "x")) to ServerAuthException.Reason.WrongAudience,
        )) {
            server.enqueue(answer)
            assertEquals(true, account.signInWithGoogle(google))
            assertEquals(CloudAccountState.Failed(reason), account.state.value)
            assertEquals(false, account.signedIn())
        }
        assertEquals(5, server.requestCount)
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
        assertEquals(0, server.requestCount)
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
        server.enqueue(json("{}", code = 202))
        assertEquals(EmailSignIn.Sent, account.startEmail("ada@example.com"))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/auth/email/start", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"email":"ada@example.com"}""", request.body?.utf8())
        // Asking is not signing in.
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
    }

    @Test
    fun anEmailCodeSignsInForTheSameHourAsAPassword() = runBlocking {
        val account = account()
        val access = jwt(audience, tag = "e1")
        server.enqueue(token(access))
        assertEquals(EmailSignIn.SignedIn, account.verifyEmail("ada@example.com", "123456"))
        assertEquals(CloudAccountState.SignedIn, account.state.value)
        val request = server.takeRequest()
        assertEquals("/v1/auth/email/verify", request.target)
        assertEquals(null, request.headers["Authorization"])
        assertEquals("""{"email":"ada@example.com","code":"123456"}""", request.body?.utf8())
        server.enqueue(json("""{"servers":[]}"""))
        assertEquals(emptyList<CloudServer>(), account.servers())
        assertEquals("Bearer $access", server.takeRequest().headers["Authorization"])
        now += 3_600_000L - 119_000L
        assertEquals(false, account.signedIn())
        assertEquals(CloudAccountState.SignedOut(expired = true), account.state.value)
    }

    /** Each refusal by its `code`, the same from either endpoint, and the account still signed out. */
    @Test
    fun anEmailRefusalSaysWhy() = runBlocking {
        val account = account()
        for (path in listOf("start", "verify")) {
            suspend fun ask() = if (path == "start") account.startEmail("ada@example.com") else account.verifyEmail("ada@example.com", "123456")
            server.enqueue(json("""{"code":"invalid_email","error":"Enter a valid email address."}""", code = 400))
            assertEquals(EmailSignIn.InvalidEmail, ask())
            server.enqueue(json("""{"code":"invalid_code","error":"That code is invalid or expired."}""", code = 400))
            assertEquals(EmailSignIn.InvalidCode, ask())
            server.enqueue(json("""{"code":"unavailable","error":"Email sign-in is unavailable."}""", code = 502))
            assertEquals(EmailSignIn.Unavailable, ask())
            server.enqueue(json("""{"code":"unsupported_provider","error":"Email sign-in is not configured."}""", code = 400))
            assertEquals(EmailSignIn.Unsupported("Email sign-in is not configured."), ask())
            server.enqueue(json("""{"code":"unsupported_provider"}""", code = 400))
            assertEquals(EmailSignIn.Unsupported(null), ask())
            server.enqueue(json("""{"code":"internal"}""", code = 503))
            assertEquals(EmailSignIn.Failed(CloudException.Reason.Unreachable), ask())
            server.enqueue(json("""{"code":"something_new"}""", code = 400))
            assertEquals(EmailSignIn.Failed(CloudException.Reason.Failed), ask())
            server.enqueue(MockResponse.Builder().code(404).body("not json").build())
            assertEquals(EmailSignIn.Failed(CloudException.Reason.Failed), ask())
        }
        // A 200 with no token is no sign-in.
        server.enqueue(json("""{"token_type":"Bearer"}"""))
        assertEquals(EmailSignIn.Failed(CloudException.Reason.Failed), account.verifyEmail("ada@example.com", "123456"))
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
        assertEquals(false, account.signedIn())
    }

    /** A 429 waits for its Retry-After, else the body's retryAfter, else a minute; its words are the service's. */
    @Test
    fun anEmailRateLimitSaysHowLong() = runBlocking {
        val account = account()
        val limited = """{"code":"rate_limited","error":"Too many requests. Try again later.","retryAfter":42}"""
        server.enqueue(MockResponse.Builder().code(429).addHeader("Content-Type", "application/json").addHeader("Retry-After", "37").body(limited).build())
        assertEquals(EmailSignIn.RateLimited(37, "Too many requests. Try again later."), account.startEmail("ada@example.com"))
        server.enqueue(json(limited, code = 429))
        assertEquals(EmailSignIn.RateLimited(42, "Too many requests. Try again later."), account.verifyEmail("ada@example.com", "123456"))
        server.enqueue(json("""{"code":"rate_limited"}""", code = 429))
        assertEquals(EmailSignIn.RateLimited(60, null), account.startEmail("ada@example.com"))
        assertEquals(CloudAccountState.SignedOut(), account.state.value)
    }

    @Test
    fun anEmailSignInOfflineIsUnreachable() = runBlocking {
        val account = account()
        server.close()
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

    private val invite = CloudInvite("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde")

    /** The preview reads before any sign-in, with no account token; the accept is the account's. */
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
            json("""{"code":"accepted","error":"Already accepted"}""", 410) to CloudInviteRefusal.UsedUp,
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
        // A 401 on the accept is the pass over.
        server.enqueue(json("""{"code":"unauthorized"}""", 401))
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
