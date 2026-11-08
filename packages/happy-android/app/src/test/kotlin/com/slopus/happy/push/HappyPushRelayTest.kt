package com.slopus.happy.push

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class HappyPushRelayTest {
    private val server = MockWebServer()
    private lateinit var relay: HappyPushRelay
    private val token = "HappyPushToken[0123456789ABCDEFGHIJKL]"
    private val install = "6f1c1a44-5e0b-4d9a-9c0b-2b1f6a0c9e71"

    @Before fun start() {
        server.start()
        relay = HappyPushRelay(OkHttpClient(), server.url("/v1/devices/register").toString())
    }
    @After fun stop() = server.close()
    private fun response(body: String, code: Int = 200) = MockResponse.Builder().code(code).body(body).build()
    private suspend fun exchange() = relay.exchange("private-native-token", install.uppercase(), "com.slopus.happy.dev", "en-US")

    @Test fun nativeExchangeHasOnlyRelayFieldsAndNoCloudAuthority() = runBlocking {
        server.enqueue(response("""{"token":"$token"}"""))
        val result = exchange()
        assertEquals(token, result.value)
        assertEquals("HappyPushToken(…)", result.toString())
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/devices/register", request.url.encodedPath)
        assertEquals("application/json", request.headers["Content-Type"])
        assertNull(request.headers["Authorization"])
        assertEquals("""{"deviceId":"$install","appId":"com.slopus.happy.dev","platform":"android","provider":"fcm","pushToken":"private-native-token","metadata":{"locale":"en-US"}}""", request.body!!.utf8())
        assertEquals("https://push.cluster-fluster.com/v1/devices/register", HappyPushRelay.URL)
    }

    @Test fun redirectsNeverForwardNativeCredentials() {
        MockWebServer().use { other ->
            other.start()
            server.enqueue(MockResponse.Builder().code(307).addHeader("Location", other.url("/collect")).build())
            assertThrows(HappyPushExchangeException::class.java) { runBlocking { exchange() } }
            assertEquals(0, other.requestCount)
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun malformedOrProviderErrorsContainNoResponseSecrets() {
        for ((code, body) in listOf(
            503 to "private-native-token $install $token",
            200 to "private-native-token $install $token",
            200 to """{"token":123}""",
            200 to """{"token":"ExponentPushToken[0123456789ABCDEFGHIJKL]"}""",
            200 to """{"token":"HappyPushToken[short]"}""",
            200 to """{"token":" $token"}""",
            200 to "x".repeat(8_193),
        )) {
            server.enqueue(response(body, code))
            val error = assertThrows(HappyPushExchangeException::class.java) { runBlocking { exchange() } }
            assertEquals("Happy push registration failed", error.message)
            assertNull(error.cause)
        }
    }

    @Test fun unsupportedAppAndInvalidInstallationNeverMakeRequests() {
        for ((appId, deviceId) in listOf("com.slopus.happy.bench" to install, "com.slopus.happy.dev" to "invalid")) {
            assertThrows(HappyPushExchangeException::class.java) {
                runBlocking { relay.exchange("native", deviceId, appId, null) }
            }
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun cancellationIsNotTurnedIntoARegistrationFailure() = runBlocking<Unit> {
        server.enqueue(MockResponse.Builder().body("""{"token":"$token"}""").headersDelay(10, TimeUnit.SECONDS).build())
        val pending = async { exchange() }
        // The HTTP callback is asynchronous; wait for the request without blocking this coroutine's dispatcher.
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { server.takeRequest() }
        pending.cancelAndJoin()
        assertThrows(CancellationException::class.java) { runBlocking { pending.await() } }
    }
}