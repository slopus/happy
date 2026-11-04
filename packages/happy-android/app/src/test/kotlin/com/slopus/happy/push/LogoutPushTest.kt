package com.slopus.happy.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * AuthContext.tsx logout drops this device's push token on happy-server
 * with the account's token. As iOS's c7d74a4e8 does it, a sign-out no
 * longer waits for the server: the removal goes in [PushUnregisterQueue],
 * kept encrypted and retried until the server answers, at the next start too.
 */
@RunWith(AndroidJUnit4::class)
class LogoutPushTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private var answers = ArrayDeque<Int>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val keys = SoftwareKeys()

    private lateinit var store: RegisteredPushTokenStore

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val code = synchronized(answers) { answers.removeFirstOrNull() } ?: 200
                return MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body("""{"success":${code == 200}}""").build()
            }
        }
        server.start()
        store = RegisteredPushTokenStore(context.getSharedPreferences(RegisteredPushTokenStore.PREFS_NAME, Context.MODE_PRIVATE))
        store.clear()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private val serverUrl get() = server.url("/").toString().trimEnd('/')

    private fun items() = ExpoSecureStore(
        context.getSharedPreferences(PushUnregisterQueue.PREFS_NAME, Context.MODE_PRIVATE),
        keys,
        keychainService = PushUnregisterQueue.KEYCHAIN_SERVICE,
    )

    private fun queue(wait: suspend (Int) -> Unit = {}) = PushUnregisterQueue(
        items(),
        scope,
        unregister = { PushApi(HappyHttp(OkHttpClient(), { it.serverUrl }, "android/test")).unregisterOnce(it.authToken, it.pushToken) },
        wait = wait,
    )

    private fun registrar(queue: PushUnregisterQueue) = PushRegistrar(
        deviceTokens = { null },
        expo = ExpoPushTokenClient(OkHttpClient(), url = server.url("/expo").toString()),
        api = PushApi(HappyHttp(OkHttpClient(), { serverUrl }, "android/test")),
        store = store,
        installationId = { "id" },
        applicationId = "com.slopus.happy.dev",
        unregisters = queue,
    )

    private fun deletes() = requests.map { "${it.method} ${it.url.encodedPath} ${it.headers["Authorization"]}" }

    @Test
    fun theRegisteredTokenIsDroppedWithTheAccountsTokenOnItsServer() {
        store.save("ExponentPushToken[a]")
        registrar(queue()).unregisterOnLogout("token-1", serverUrl)
        // Forgotten at once; the server is told behind the screens.
        assertNull(store.load())
        eventually(message = "the DELETE") { requests.isNotEmpty() }
        assertEquals(listOf("DELETE /v1/push-tokens/ExponentPushToken%5Ba%5D Bearer token-1"), deletes())
        eventually(message = "nothing left to send") { items().keys().isEmpty() }
    }

    @Test
    fun removingAnInactiveAccountDropsOnlyItsServerRegistrationAndKeepsTheCurrentToken() {
        store.save("ExponentPushToken[a]")
        registrar(queue()).unregisterOnLogout("inactive-token", serverUrl, forgetCurrentToken = false)
        assertEquals("ExponentPushToken[a]", store.load())
        eventually(message = "inactive account DELETE") { requests.isNotEmpty() }
        assertEquals(listOf("DELETE /v1/push-tokens/ExponentPushToken%5Ba%5D Bearer inactive-token"), deletes())
        assertEquals("ExponentPushToken[a]", store.load())
        eventually(message = "inactive removal answered") { items().keys().isEmpty() }
    }

    @Test
    fun withNothingRegisteredNothingIsQueued() {
        registrar(queue()).unregisterOnLogout("token-1", serverUrl)
        assertTrue(items().keys().isEmpty())
        Thread.sleep(200)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun aFailingServerIsAskedAgainOnTheQueuesClockUntilItAnswers() {
        answers = ArrayDeque(listOf(500, 503))
        val waits = CopyOnWriteArrayList<Int>()
        store.save("ExponentPushToken[a]")
        registrar(queue(wait = { waits += it })).unregisterOnLogout("token-1", serverUrl)
        eventually(message = "the third try") { requests.size == 3 }
        eventually(message = "dropped once answered") { items().keys().isEmpty() }
        assertEquals(listOf(1, 2), waits)
        Thread.sleep(200)
        assertEquals(3, requests.size)
    }

    @Test
    fun aRefusalIsAnAnswerAndIsNotRetried() {
        answers = ArrayDeque(listOf(401))
        store.save("ExponentPushToken[a]")
        registrar(queue()).unregisterOnLogout("token-1", serverUrl)
        eventually(message = "dropped") { requests.size == 1 && items().keys().isEmpty() }
        Thread.sleep(200)
        assertEquals(1, requests.size)
    }

    @Test
    fun whatAnEarlierRunLeftIsSentAtTheNextStart() {
        // A run whose server never answered (the process died with it queued).
        val dead = PushUnregisterQueue(items(), scope, unregister = { throw IOException("offline") }, wait = { kotlinx.coroutines.awaitCancellation() })
        dead.add(PendingPushRemoval(serverUrl, "token-1", "ExponentPushToken[a]"))
        assertEquals(1, items().keys().size)
        // The next start drains it.
        queue().drain()
        eventually(message = "sent at start") { requests.size == 1 && items().keys().isEmpty() }
        assertEquals(listOf("DELETE /v1/push-tokens/ExponentPushToken%5Ba%5D Bearer token-1"), deletes())
    }

    @Test
    fun theRemovalIsKeptEncrypted() {
        queue(wait = { kotlinx.coroutines.awaitCancellation() }).let {
            answers = ArrayDeque(List(50) { 500 })
            it.add(PendingPushRemoval(serverUrl, "token-secret", "ExponentPushToken[a]"))
        }
        val raw = context.getSharedPreferences(PushUnregisterQueue.PREFS_NAME, Context.MODE_PRIVATE).all.values.joinToString()
        assertTrue("token in the clear: $raw", "token-secret" !in raw)
    }

    @Test
    fun logoutRunsItsHooksFirstWithTheAccountsTokenAndServer() = runBlocking {
        val happy = FakeHappyServer().start()
        try {
            val graph = AppGraph(
                context = context,
                clientId = "android/test",
                defaultServerUrl = happy.url,
                secureStoreKeys = SoftwareKeys(),
                databaseName = null,
            )
            graph.auth.createAccount()
            val token = (graph.auth.state.value as AuthState.SignedIn).credentials.token
            val seen = mutableListOf<Triple<String, String, Boolean>>()
            graph.beforeLogout { authToken, serverUrl -> seen += Triple(authToken, serverUrl, graph.auth.state.value is AuthState.SignedIn) }
            graph.logout().join()
            assertEquals(listOf(Triple(token, happy.url, true)), seen)
            assertEquals(AuthState.SignedOut, graph.auth.state.value)
        } finally {
            happy.close()
        }
    }

    @Test
    fun signingOutDoesNotWaitForAPushServerThatNeverAnswers() = runBlocking {
        val happy = FakeHappyServer().start()
        // The push removal goes to a server that takes the connection and never answers.
        val blackHole = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val held = CopyOnWriteArrayList<Socket>()
        thread(isDaemon = true) { runCatching { while (true) held += blackHole.accept() } }
        try {
            val graph = AppGraph(context, "android/test", happy.url, SoftwareKeys(), databaseName = null)
            graph.auth.createAccount()
            store.save("ExponentPushToken[a]")
            val registrar = registrar(graph.pushUnregisters)
            val hole = "http://${blackHole.inetAddress.hostAddress}:${blackHole.localPort}"
            graph.beforeLogout { authToken, _ -> registrar.unregisterOnLogout(authToken, hole) }
            val started = System.nanoTime()
            graph.logout().join()
            val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            assertTrue("sign-out took $elapsedMs ms", elapsedMs < 1_000)
            assertEquals(AuthState.SignedOut, graph.auth.state.value)
            eventually(message = "the removal still went out") { held.isNotEmpty() }
        } finally {
            held.forEach { it.close() }
            blackHole.close()
            happy.close()
        }
    }
}
