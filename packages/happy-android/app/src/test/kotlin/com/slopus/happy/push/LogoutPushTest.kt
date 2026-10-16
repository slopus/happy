package com.slopus.happy.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.runBlocking
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
 * AuthContext.tsx logout: the push token this device registered is dropped
 * on happy-server first, with the account's token, before anything is
 * cleared; a failure only gets logged. Unlike happy-app the attempt is
 * bounded, since apiPush.ts's backoff never gives up and a logout must not hang.
 */
@RunWith(AndroidJUnit4::class)
class LogoutPushTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private var failing = false

    private lateinit var store: RegisteredPushTokenStore
    private lateinit var registrar: PushRegistrar

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val body = if (failing) """{"success":false}""" else """{"success":true}"""
                return MockResponse.Builder().code(if (failing) 500 else 200).addHeader("Content-Type", "application/json").body(body).build()
            }
        }
        server.start()
        val http = HappyHttp(OkHttpClient(), serverUrl = { server.url("/").toString().trimEnd('/') }, clientId = "android/test")
        val context = ApplicationProvider.getApplicationContext<Context>()
        store = RegisteredPushTokenStore(context.getSharedPreferences(RegisteredPushTokenStore.PREFS_NAME, Context.MODE_PRIVATE))
        store.clear()
        registrar = PushRegistrar(
            deviceTokens = { null },
            expo = ExpoPushTokenClient(OkHttpClient(), url = server.url("/expo").toString()),
            api = PushApi(http, retryDelay = { kotlinx.coroutines.delay(20) }),
            store = store,
            installationId = { "id" },
            applicationId = "com.slopus.happy.dev",
        )
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun theRegisteredTokenIsDroppedWithTheAccountsToken() = runBlocking {
        store.save("ExponentPushToken[a]")
        registrar.unregisterOnLogout("token-1")
        assertEquals(listOf("DELETE /v1/push-tokens/ExponentPushToken%5Ba%5D"), requests.map { "${it.method} ${it.url.encodedPath}" })
        assertEquals("Bearer token-1", requests.single().headers["Authorization"])
        assertNull(store.load())
    }

    @Test
    fun withNothingRegisteredNothingIsSent() = runBlocking {
        registrar.unregisterOnLogout("token-1")
        assertTrue(requests.isEmpty())
    }

    @Test
    fun aServerThatKeepsFailingIsGivenUpOn() = runBlocking {
        failing = true
        store.save("ExponentPushToken[a]")
        val started = System.nanoTime()
        registrar.unregisterOnLogout("token-1", timeoutMs = 300)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("took $elapsedMs ms", elapsedMs < 3_000)
        assertTrue(requests.size > 1)
        // Forgotten all the same, as clearPersistence does.
        assertNull(store.load())
    }

    @Test
    fun logoutRunsItsHooksFirstWithTheAccountsToken() = runBlocking {
        val happy = FakeHappyServer().start()
        try {
            val graph = AppGraph(
                context = ApplicationProvider.getApplicationContext(),
                clientId = "android/test",
                defaultServerUrl = happy.url,
                secureStoreKeys = SoftwareKeys(),
                databaseName = null,
            )
            graph.auth.createAccount()
            val token = (graph.auth.state.value as AuthState.SignedIn).credentials.token
            val seen = mutableListOf<Pair<String, Boolean>>()
            graph.beforeLogout { authToken -> seen += authToken to (graph.auth.state.value is AuthState.SignedIn) }
            graph.logout().join()
            assertEquals(listOf(token to true), seen)
            assertEquals(AuthState.SignedOut, graph.auth.state.value)
        } finally {
            happy.close()
        }
    }
}
