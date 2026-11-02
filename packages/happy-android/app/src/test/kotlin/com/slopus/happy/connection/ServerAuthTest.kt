package com.slopus.happy.connection

import kotlinx.coroutines.runBlocking
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.URLDecoder

/**
 * Team server sign-in against a mock daemon and authorization server
 * (edge SSO contract §1–3): discovery, PKCE, the code exchange and refresh,
 * with nothing followed through a redirect.
 */
class ServerAuthTest {
    private val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
        protocols = listOf(Protocol.HTTP_1_1)
        start()
    }
    private val roots = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val http = OkHttpClient.Builder().sslSocketFactory(roots.sslSocketFactory(), roots.trustManager).build()
    private val auth = ServerAuthClient(http, now = { 1_000_000L })
    private val origin = AgentOrigin.parse("https://localhost:${server.port}")
    private val base = "https://localhost:${server.port}"
    private val redirect = ServerSignInFlow.REDIRECT_URI

    @After
    fun tearDown() = server.close()

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun method(resource: Boolean = true) = OAuthMethod(
        id = "jwt", name = "Acme SSO", authorizationUrl = "$base/oauth/authorize?tenant=acme", tokenUrl = "$base/oauth/token",
        refreshUrl = "$base/oauth/refresh", clientId = "happy", scope = "happy offline_access",
        resource = if (resource) "https://happy.acme.example" else null,
    )

    private fun form(body: String): Map<String, String> = body.split('&').associate {
        URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }

    @Test
    fun discoveryListsOAuthMethodsWithoutACredential() = runBlocking {
        server.enqueue(json("""{"authenticated":false,"userId":null,"methods":[
            {"type":"saml","id":"x","name":"Unknown"},
            {"type":"oauth","id":"bad","name":"Plain http","authorizationUrl":"http://sso.example/a","tokenUrl":"https://sso.example/t","clientId":"c"},
            {"type":"oauth","id":"jwt","name":"Acme SSO","authorizationUrl":"https://sso.acme.example/oauth/authorize","tokenUrl":"https://sso.acme.example/oauth/token","refreshUrl":"https://sso.acme.example/oauth/token","clientId":"happy","scope":"happy","resource":"https://happy.acme.example"}
        ]}"""))
        val methods = auth.discover(origin)
        assertEquals(1, methods.size)
        assertEquals("jwt", methods[0].id)
        assertEquals("https://happy.acme.example", methods[0].resource)
        assertEquals("sso.acme.example", methods[0].authorizationHost)
        val request = server.takeRequest()
        assertEquals("/v0/authentication", request.target)
        assertNull(request.headers["Authorization"])
    }

    @Test
    fun discoveryThatTheEdgeIntercepts() = runBlocking {
        // An SSO edge redirecting to its IdP: never followed.
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://idp.example/login").build())
        assertReason(ServerAuthException.Reason.EdgeBlocked) { auth.discover(origin) }
        assertEquals(1, server.requestCount)
        // A login page served as 200, and the edge's own 403.
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/html").body("<html>Sign in</html>").build())
        assertReason(ServerAuthException.Reason.EdgeBlocked) { auth.discover(origin) }
        server.enqueue(MockResponse.Builder().code(403).addHeader("Content-Type", "text/html").body("Forbidden").build())
        assertReason(ServerAuthException.Reason.EdgeBlocked) { auth.discover(origin) }
        // An older daemon, and one without OAuth.
        server.enqueue(json("""{"error":"Not found","code":"not_found"}""", 404))
        assertReason(ServerAuthException.Reason.NoSignIn) { auth.discover(origin) }
        server.enqueue(json("""{"authenticated":false,"userId":null,"methods":[]}"""))
        assertReason(ServerAuthException.Reason.NoSignIn) { auth.discover(origin) }
    }

    @Test
    fun authorizationUsesPkceS256AndTheResource() {
        val pending = auth.begin(origin, method(), redirect)
        val url = pending.authorizeUrl.toHttpUrl()
        assertEquals("acme", url.queryParameter("tenant"))
        assertEquals("code", url.queryParameter("response_type"))
        assertEquals("happy", url.queryParameter("client_id"))
        assertEquals(redirect, url.queryParameter("redirect_uri"))
        assertEquals(pending.state, url.queryParameter("state"))
        assertEquals("S256", url.queryParameter("code_challenge_method"))
        assertEquals(PendingOAuth.challenge(pending.verifier), url.queryParameter("code_challenge"))
        assertEquals("happy offline_access", url.queryParameter("scope"))
        assertEquals("https://happy.acme.example", url.queryParameter("resource"))
        assertTrue(pending.verifier.length in 43..128)
        assertNull(auth.begin(origin, method(resource = false), redirect).authorizeUrl.toHttpUrl().queryParameter("resource"))
        // RFC 7636 appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", PendingOAuth.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun theCodeIsExchangedOnlyForThisSignIn() = runBlocking {
        val pending = auth.begin(origin, method(), redirect)
        assertReason(ServerAuthException.Reason.Expired) { auth.complete(pending, "$redirect?code=abc&state=other") }
        assertReason(ServerAuthException.Reason.Expired) { auth.complete(pending, "com.example.other:/oauth/callback?code=abc&state=${pending.state}") }
        assertReason(ServerAuthException.Reason.Expired) { auth.complete(pending, "$redirect?code=abc&state=%") }
        assertReason(ServerAuthException.Reason.Denied) { auth.complete(pending, "$redirect?error=access_denied&state=${pending.state}") }
        assertEquals(0, server.requestCount)

        val access1 = jwt("$base/", tag = "access-1")
        server.enqueue(json("""{"access_token":"$access1","token_type":"bearer","expires_in":300,"refresh_token":"refresh-1"}"""))
        val (grant, credential) = auth.complete(pending, "$redirect?code=the%20code&state=${pending.state}")
        assertEquals(access1, grant.access.value)
        assertEquals(1_000_000L + 300_000, grant.access.expiresAtMillis)
        assertEquals(OAuthCredential("jwt", "happy", "$base/oauth/refresh", "refresh-1", "https://happy.acme.example"), credential)
        val request = server.takeRequest()
        assertEquals("/oauth/token", request.target)
        assertNull(request.headers["Authorization"])
        val body = form(request.body!!.utf8())
        assertEquals("authorization_code", body["grant_type"])
        assertEquals("the code", body["code"])
        assertEquals(redirect, body["redirect_uri"])
        assertEquals("happy", body["client_id"])
        assertEquals(pending.verifier, body["code_verifier"])
        assertEquals("https://happy.acme.example", body["resource"])
    }

    @Test
    fun aTokenEndpointRedirectIsNotFollowed() = runBlocking {
        val pending = auth.begin(origin, method(), redirect)
        server.enqueue(MockResponse.Builder().code(307).addHeader("Location", "$base/elsewhere").build())
        assertReason(ServerAuthException.Reason.Denied) { auth.complete(pending, "$redirect?code=abc&state=${pending.state}") }
        assertEquals(1, server.requestCount)
        val again = auth.begin(origin, method(), redirect)
        server.enqueue(json("""{"access_token":"x","token_type":"mac"}"""))
        assertReason(ServerAuthException.Reason.InvalidToken) { auth.complete(again, "$redirect?code=abc&state=${again.state}") }
    }

    @Test
    fun refreshGoesOnlyToTheRecordedUrlAndRotates() = runBlocking {
        val credential = OAuthCredential("jwt", "happy", "$base/oauth/refresh", "refresh-1", "https://happy.acme.example")
        val access2 = jwt(base, tag = "access-2")
        server.enqueue(json("""{"access_token":"$access2","token_type":"Bearer","refresh_token":"refresh-2"}"""))
        val (access, rotated) = auth.refresh(credential, origin)
        assertEquals(access2, access.value)
        assertNull(access.expiresAtMillis)
        assertEquals("refresh-2", rotated.refreshToken)
        val body = form(server.takeRequest().also { assertEquals("/oauth/refresh", it.target) }.body!!.utf8())
        assertEquals(mapOf("grant_type" to "refresh_token", "refresh_token" to "refresh-1", "client_id" to "happy", "resource" to "https://happy.acme.example"), body)

        // No new refresh token: the old one stays.
        server.enqueue(json("""{"access_token":"${jwt(base, tag = "access-3")}","token_type":"Bearer"}"""))
        assertEquals("refresh-2", auth.refresh(rotated, origin).second.refreshToken)
        // Refused: sign in again. Unreachable: try later.
        server.enqueue(json("""{"error":"invalid_grant"}""", 400))
        assertReason(ServerAuthException.Reason.SignInRequired) { auth.refresh(rotated, origin) }
        server.enqueue(json("""{}""", 503))
        assertReason(ServerAuthException.Reason.Unreachable) { auth.refresh(rotated, origin) }
        assertReason(ServerAuthException.Reason.SignInRequired) { auth.refresh(rotated.copy(refreshUrl = null), origin) }
    }

    @Test
    fun aMethodMustKeepItsTokenEndpointsOnItsAuthorizationOrigin() {
        assertTrue(method().oneSite)
        // The default port is the same origin; a path or query doesn't matter.
        assertTrue(OAuthMethod("j", "n", "https://sso.example/a?x=1", "https://sso.example:443/t", "https://SSO.example/r", "c").oneSite)
        listOf(
            OAuthMethod("j", "n", "https://sso.example/a", "https://evil.example/t", null, "c"),
            OAuthMethod("j", "n", "https://sso.example/a", "https://sso.example/t", "https://evil.example/r", "c"),
            OAuthMethod("j", "n", "https://sso.example/a", "https://sso.example:8443/t", null, "c"),
            OAuthMethod("j", "n", "https://sso.example/a", "http://sso.example/t", null, "c"),
            OAuthMethod("j", "n", "https://sso.example/a", "https://sso.example.evil.example/t", null, "c"),
        ).forEach { method ->
            assertFalse(method.toString(), method.oneSite)
            assertReason(ServerAuthException.Reason.CrossOrigin) { auth.begin(origin, method, redirect) }
        }
    }

    @Test
    fun aTokenIsForTheServerItsAudienceNames() {
        val acme = AgentOrigin.parse("https://happy.acme.example")
        assertTrue(ServerAuthClient.audienceIs(jwt("https://happy.acme.example"), acme))
        assertTrue(ServerAuthClient.audienceIs(jwt("https://happy.acme.example/"), acme))
        assertTrue(ServerAuthClient.audienceIs(jwt("https://happy.acme.example:443/"), acme))
        assertTrue(ServerAuthClient.audienceIs(jwt("happy-api", "https://happy.acme.example/"), acme))
        listOf(
            jwt("https://happy.acme.example/happy/"),
            jwt("https://acme.example/"),
            jwt("https://happy.acme.example:8443/"),
            jwt("http://happy.acme.example/"),
            jwt("happy.acme.example"),
            jwt("happy-api", "urn:x"),
            "not-a-jwt",
            "a.b.c",
            "a.${java.util.Base64.getUrlEncoder().encodeToString("{}".toByteArray())}.c",
        ).forEach { assertFalse(it, ServerAuthClient.audienceIs(it, acme)) }
    }

    @Test
    fun aTokenForAnotherServerIsRefused() = runBlocking {
        val pending = auth.begin(origin, method(), redirect)
        server.enqueue(json("""{"access_token":"${jwt("https://happy.other.example/")}","token_type":"Bearer","refresh_token":"r"}"""))
        assertReason(ServerAuthException.Reason.WrongAudience) { auth.complete(pending, "$redirect?code=abc&state=${pending.state}") }
        server.enqueue(json("""{"access_token":"opaque","token_type":"Bearer"}"""))
        assertReason(ServerAuthException.Reason.WrongAudience) { auth.refresh(OAuthCredential("jwt", "happy", "$base/oauth/refresh", "r"), origin) }
    }

    @Test
    fun checkingTheTokenSaysWhetherTheMemberHasAProfile() = runBlocking {
        server.enqueue(json("""{"authenticated":true,"userId":null,"methods":[]}"""))
        assertEquals(true to null, auth.check(origin, "access-1"))
        assertEquals("Bearer access-1", server.takeRequest().headers["Authorization"])
        server.enqueue(json("""{"profile":{}}"""))
        auth.saveName(origin, "access-1", "Steve")
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("/v0/profile", patch.target)
        assertEquals("""{"name":"Steve"}""", patch.body!!.utf8())
        server.enqueue(json("""{"authenticated":true,"userId":"u1","methods":[]}"""))
        assertEquals(true to "u1", auth.check(origin, "access-1"))
    }

    @Test
    fun signInRule() {
        val happy = """{"error":"Forbidden","code":"forbidden"}""".toByteArray()
        assertTrue(SignInRule.requiresSignIn(302, null, ByteArray(0)))
        assertTrue(SignInRule.requiresSignIn(401, "application/json", happy))
        assertTrue(SignInRule.requiresSignIn(403, "text/html", "<html>".toByteArray()))
        assertTrue(SignInRule.requiresSignIn(403, "application/json", """{"error":"x"}""".toByteArray()))
        assertFalse(SignInRule.requiresSignIn(403, "application/json; charset=utf-8", happy))
        assertFalse(SignInRule.requiresSignIn(404, "text/html", ByteArray(0)))
        assertFalse(SignInRule.requiresSignIn(200, null, ByteArray(0)))
        assertFalse(SignInRule.requiresSignIn(304, null, ByteArray(0)))
    }

    @Test
    fun serverAddresses() {
        assertEquals("https://happy.acme.example", ServerAuthClient.parseAddress(" happy.acme.example ").value)
        assertEquals("https://happy.acme.example", ServerAuthClient.parseAddress("https://happy.acme.example/").value)
        assertEquals("https://happy.acme.example:8443", ServerAuthClient.parseAddress("HTTPS://Happy.Acme.Example:8443").value)
        for (bad in listOf("http://happy.acme.example", "https://happy.acme.example/path", "https://u:p@happy.acme.example", "https://happy.acme.example?x=1", "", "ftp://x")) {
            assertReason(ServerAuthException.Reason.InvalidAddress) { ServerAuthClient.parseAddress(bad) }
        }
    }

    private inline fun assertReason(reason: ServerAuthException.Reason, block: () -> Unit) {
        try {
            block()
            fail("expected $reason")
        } catch (e: ServerAuthException) {
            assertEquals(reason, e.reason)
        }
    }
}
