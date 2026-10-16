package com.slopus.happy.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.model.settings.PushTokenSync
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/**
 * apiPush.ts (with utils/time.ts backoff) and pushRegistration.ts
 * syncCurrentPushToken, against a mock of happy-server's push routes and
 * Expo's token endpoint on one server.
 */
@RunWith(AndroidJUnit4::class)
class PushRegistrationTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    /** The next happy-server responses (status, body); success when empty. */
    private val failures = ArrayDeque<Pair<Int, String>>()
    private var fcmToken: String? = "fcm-1"
    private val retries = CopyOnWriteArrayList<Int>()

    private lateinit var api: PushApi
    private lateinit var store: RegisteredPushTokenStore
    private lateinit var registrar: PushRegistrar

    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.url.encodedPath
                if (path == EXPO_PATH) {
                    val fcm = HappyJson.parseToJsonElement(request.body!!.utf8()).jsonObject["deviceToken"]!!.jsonPrimitive.content
                    return json(200, """{"data":{"expoPushToken":"ExponentPushToken[$fcm]"}}""")
                }
                synchronized(failures) { failures.removeFirstOrNull() }?.let { (code, body) -> return json(code, body) }
                return json(200, """{"success":true}""")
            }
        }
        server.start()
        val http = HappyHttp(OkHttpClient(), serverUrl = { server.url("/").toString().trimEnd('/') }, clientId = "android/test")
        api = PushApi(http, retryDelay = { retries += it })
        val context = ApplicationProvider.getApplicationContext<Context>()
        store = RegisteredPushTokenStore(context.getSharedPreferences(RegisteredPushTokenStore.PREFS_NAME, Context.MODE_PRIVATE))
        registrar = PushRegistrar(
            deviceTokens = { fcmToken },
            expo = ExpoPushTokenClient(OkHttpClient(), url = server.url(EXPO_PATH).toString()),
            api = api,
            store = store,
            installationId = { "6f1c1a44-5e0b-4d9a-9c0b-2b1f6a0c9e71" },
            applicationId = "com.slopus.happy.dev",
        )
    }

    @After
    fun tearDown() = server.close()

    private val happyRequests get() = requests.filter { it.url.encodedPath != EXPO_PATH }
    private fun summary(request: RecordedRequest) = "${request.method} ${request.url.encodedPath}"

    @Test
    fun theServerRoutes() = runBlocking {
        api.register("token-1", "ExponentPushToken[a b]")
        api.unregister("token-1", "ExponentPushToken[a b]")

        // encodeURIComponent of the token in the DELETE path.
        assertEquals(
            listOf("POST /v1/push-tokens", "DELETE /v1/push-tokens/ExponentPushToken%5Ba%20b%5D"),
            requests.map(::summary),
        )
        assertEquals("""{"token":"ExponentPushToken[a b]"}""", requests[0].body!!.utf8())
        requests.forEach {
            assertEquals("Bearer token-1", it.headers["Authorization"])
            assertEquals("android/test", it.headers["X-Happy-Client"])
        }
        assertTrue(retries.isEmpty())
    }

    @Test
    fun everyCallRetriesUntilItWorks() = runBlocking {
        failures += listOf(500 to "{}", 502 to "{}", 401 to """{"error":"Unauthorized"}""")
        api.register("token-1", "ExponentPushToken[a]")
        assertEquals(4, requests.size)
        assertEquals(listOf(1, 2, 3), retries)

        // A 200 without success, or with a body that isn't JSON, is a failure too.
        requests.clear()
        retries.clear()
        failures += listOf(200 to """{"success":false}""", 200 to "<html>")
        api.unregister("token-1", "ExponentPushToken[a]")
        assertEquals(3, requests.size)
        assertEquals(listOf(1, 2), retries)
    }

    @Test
    fun syncRegistersTheExpoTokenAndRemembersIt() = runBlocking {
        assertEquals(PushSyncResult.Registered("ExponentPushToken[fcm-1]"), registrar.sync("token-1"))
        assertEquals(listOf("POST $EXPO_PATH", "POST /v1/push-tokens"), requests.map(::summary))
        val expo = HappyJson.parseToJsonElement(requests[0].body!!.utf8()).jsonObject
        assertEquals("com.slopus.happy.dev", expo["appId"]!!.jsonPrimitive.content)
        assertEquals("fcm-1", expo["deviceToken"]!!.jsonPrimitive.content)
        assertEquals("""{"token":"ExponentPushToken[fcm-1]"}""", requests[1].body!!.utf8())
        assertEquals("ExponentPushToken[fcm-1]", store.load())

        // The same token again (every foreground): registered again, nothing dropped.
        requests.clear()
        registrar.sync("token-1")
        assertEquals(listOf("POST /v1/push-tokens"), happyRequests.map(::summary))
    }

    @Test
    fun aRotatedTokenReplacesTheOldOne() = runBlocking {
        registrar.sync("token-1")
        requests.clear()
        fcmToken = "fcm-2"
        assertEquals(PushSyncResult.Registered("ExponentPushToken[fcm-2]"), registrar.sync("token-1"))
        assertEquals(
            listOf("POST /v1/push-tokens", "DELETE /v1/push-tokens/ExponentPushToken%5Bfcm-1%5D"),
            happyRequests.map(::summary),
        )
        assertEquals("""{"token":"ExponentPushToken[fcm-2]"}""", happyRequests[0].body!!.utf8())
        assertEquals("ExponentPushToken[fcm-2]", store.load())
    }

    @Test
    fun withoutAnFcmTokenPushIsUnsupported() = runBlocking {
        fcmToken = null
        assertEquals(PushSyncResult.Unsupported, registrar.sync("token-1"))
        assertTrue(requests.isEmpty())
        assertNull(store.load())
        assertNull(registrar.currentExpoToken())
    }

    @Test
    fun removingAndForgetting() = runBlocking {
        registrar.sync("token-1")
        assertEquals("ExponentPushToken[fcm-1]", registrar.currentExpoToken())

        // Another device's token: this one stays registered.
        requests.clear()
        registrar.remove("token-1", "ExponentPushToken[other]")
        assertEquals(listOf("DELETE /v1/push-tokens/ExponentPushToken%5Bother%5D"), requests.map(::summary))
        assertEquals("ExponentPushToken[fcm-1]", store.load())

        registrar.remove("token-1", "ExponentPushToken[fcm-1]")
        assertNull(store.load())

        registrar.sync("token-1")
        registrar.forget()
        assertNull(store.load())
    }

    private fun settingsRegistration(permission: NotificationPermission, supported: Boolean = true, signedIn: Boolean = true) =
        AppPushRegistration(permission, supported = { supported }, registrar = registrar, store = store, authToken = { "token-1".takeIf { signedIn } })

    @Test
    fun settingsSyncAsksFirstThenRegisters() = runBlocking {
        val asking = PushPromptTest.FakePermission(PushPromptTest.UNDETERMINED, answer = PushPromptTest.GRANTED)
        assertEquals(
            PushTokenSync(registered = true, token = "ExponentPushToken[fcm-1]", permission = PushPromptTest.GRANTED),
            settingsRegistration(asking).syncCurrentToken(),
        )
        assertEquals(1, asking.requests.get())
        assertEquals("ExponentPushToken[fcm-1]", settingsRegistration(asking).currentToken())

        // Refused or blocked: nothing registered, the last registered token reported.
        requests.clear()
        val refusing = PushPromptTest.FakePermission(PushPromptTest.UNDETERMINED, answer = PushPromptTest.BLOCKED)
        assertEquals(
            PushTokenSync(registered = false, token = "ExponentPushToken[fcm-1]", permission = PushPromptTest.BLOCKED),
            settingsRegistration(refusing).syncCurrentToken(),
        )
        val blocked = PushPromptTest.FakePermission(PushPromptTest.BLOCKED)
        assertEquals(
            PushTokenSync(registered = false, token = "ExponentPushToken[fcm-1]", permission = PushPromptTest.BLOCKED),
            settingsRegistration(blocked).syncCurrentToken(),
        )
        assertEquals(0, blocked.requests.get())
        // getCurrentExpoPushToken without permission: the stored token, no exchange.
        fcmToken = "fcm-2"
        assertEquals("ExponentPushToken[fcm-1]", settingsRegistration(blocked).currentToken())
        assertTrue(requests.isEmpty())
    }

    @Test
    fun settingsWhereUnsupportedRegistersNothing() = runBlocking {
        val allowed = PushPromptTest.FakePermission(PushPromptTest.GRANTED)
        assertEquals(
            PushTokenSync(registered = false, token = null, permission = PushPromptTest.GRANTED),
            settingsRegistration(allowed, supported = false).syncCurrentToken(),
        )
        assertNull(settingsRegistration(allowed, supported = false).currentToken())
        assertTrue(requests.isEmpty())
    }

    @Test
    fun settingsRemovesADevice() = runBlocking {
        val allowed = PushPromptTest.FakePermission(PushPromptTest.GRANTED)
        val registration = settingsRegistration(allowed)
        registration.syncCurrentToken()
        requests.clear()
        registration.removeToken("ExponentPushToken[fcm-1]")
        assertEquals(listOf("DELETE /v1/push-tokens/ExponentPushToken%5Bfcm-1%5D"), requests.map(::summary))
        assertNull(store.load())
    }

    private companion object {
        const val EXPO_PATH = "/--/api/v2/push/getExpoPushToken"
    }
}
