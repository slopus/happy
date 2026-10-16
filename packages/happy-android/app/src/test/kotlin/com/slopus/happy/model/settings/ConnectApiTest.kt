package com.slopus.happy.model.settings

import com.slopus.happy.net.HappyHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

/** apiGithub.ts and apiServices.ts: paths, methods, bodies and error messages. */
class ConnectApiTest {
    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()
    private var respond: (RecordedRequest) -> MockResponse = { json(200, """{"success":true}""") }
    private lateinit var api: HttpConnectApi

    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(requests) { requests += request }
                return respond(request)
            }
        }
        server.start()
        val http = HappyHttp(OkHttpClient(), serverUrl = { server.url("/").toString().trimEnd('/') }, clientId = "android/test")
        api = HttpConnectApi(http) { "token-1" }
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun gitHubOAuthUrl() = runTest {
        respond = { json(200, """{"url":"https://github.com/login/oauth/authorize?x=1"}""") }
        assertEquals("https://github.com/login/oauth/authorize?x=1", api.gitHubOAuthUrl())
        val request = requests.single()
        assertEquals("GET", request.method)
        assertEquals("/v1/connect/github/params", request.url.encodedPath)
        assertEquals("Bearer token-1", request.headers["Authorization"])
        assertEquals("android/test", request.headers["X-Happy-Client"])

        respond = { json(400, """{"error":"GitHub OAuth is not configured"}""") }
        assertEquals("GitHub OAuth is not configured", assertThrows(ConnectException::class.java) { kotlinx.coroutines.runBlocking { api.gitHubOAuthUrl() } }.message)
        respond = { json(500, "{}") }
        assertEquals("Failed to get GitHub OAuth params: 500", assertThrows(ConnectException::class.java) { kotlinx.coroutines.runBlocking { api.gitHubOAuthUrl() } }.message)
    }

    @Test
    fun disconnects() = runTest {
        api.disconnectGitHub()
        api.disconnectService("anthropic")
        assertEquals(listOf("DELETE /v1/connect/github", "DELETE /v1/connect/anthropic"), requests.map { "${it.method} ${it.url.encodedPath}" })

        respond = { json(404, "{}") }
        assertEquals("anthropic account not connected", assertThrows(ConnectException::class.java) { kotlinx.coroutines.runBlocking { api.disconnectService("anthropic") } }.message)
        respond = { json(200, """{"success":false}""") }
        assertEquals("Failed to disconnect GitHub account", assertThrows(ConnectException::class.java) { kotlinx.coroutines.runBlocking { api.disconnectGitHub() } }.message)
    }

    @Test
    fun connectServiceSendsTheTokenAsJsonText() = runTest {
        api.connectService("anthropic", JsonObject(mapOf("raw" to JsonPrimitive("abc"))))
        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("/v1/connect/anthropic/register", request.url.encodedPath)
        assertEquals("""{"token":"{\"raw\":\"abc\"}"}""", request.body?.utf8())
    }
}
