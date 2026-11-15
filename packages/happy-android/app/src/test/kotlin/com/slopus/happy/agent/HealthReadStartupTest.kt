package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.*
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.monitor.MonitorModel
import com.slopus.happy.monitor.SystemMonitorFeed
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.ZoneId

/** Settings' real daily-usage caller must finish even when the automatic bootstrap cannot. */
@RunWith(AndroidJUnit4::class)
class HealthReadStartupTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val agent = FakeAgent()
    private val active = MutableStateFlow(true)
    private val bootstrapAsked = CompletableDeferred<Unit>()
    private val releaseBootstrap = CompletableDeferred<Unit>()
    private lateinit var connections: AgentConnections
    private lateinit var id: String

    @Before fun setUp(): Unit = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secrets = context.getSharedPreferences("health-read-secrets", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences("health-read-registry", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { agent })
        id = connections.add(AgentConnectionCredentials("addr", 24781, "dv1", "token"), "Mac").id
        agent.calls.clear()
    }

    @After fun tearDown() = scope.cancel()
    private fun json(text: String) = AgentClient.json.parseToJsonElement(text) as JsonObject
    private fun session(failure: Exception? = null) = AgentSession(id, connections, null, active, scope, initiallyActive = active.value, makeTransport = {
        object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path == "/v0/bootstrap/desktop") {
                    bootstrapAsked.complete(Unit)
                    releaseBootstrap.await()
                    if (failure != null) throw failure
                }
                return agent.request(method, path, credential, body, headers, category)
            }
        }
    })
    private suspend fun usage(session: AgentSession) = withTimeout(10_000) { LiveDailyUsageSource(session.client).read(7, ZoneId.of("UTC")) }
    private suspend fun eventually(check: () -> Boolean) = withTimeout(10_000) { while (!check()) delay(10) }
    private fun healthReads() = agent.calls.count { it == "GET /v0/health" }
    private suspend fun CoroutineScope.waitingUsage(session: AgentSession): Deferred<DailyUsage?> {
        val read = async { usage(session) }
        yield()
        assertFalse(read.isCompleted)
        assertEquals(0, healthReads())
        return read
    }
    private suspend fun cancelled(read: Deferred<*>) {
        try { withTimeout(10_000) { read.await() }; fail("stopped health read must cancel") }
        catch (e: TimeoutCancellationException) { throw e }
        catch (_: CancellationException) { }
    }

    @Test fun verifiedUsageSharesBootstrapHealthWithoutAHealthRequest(): Unit = runBlocking {
        agent.bootstrap = agent.bootstrap.with("health", (agent.bootstrap["health"] as JsonObject).with("capabilities", json("""{"dailyUsage":true}""")))
        agent.resources["/v0/usage/daily?days=7&tz=UTC"] = json("""{"since":"2026-01-01","days":[]}""")
        val session = session()
        bootstrapAsked.await()
        val read = waitingUsage(session)
        agent.frames.send(Wire.hello("c0"))
        releaseBootstrap.complete(Unit)
        assertNotNull(read.await())
        assertEquals(0, healthReads())
        assertTrue(agent.calls.contains("GET /v0/usage/daily?days=7&tz=UTC"))
    }

    @Test fun neverStartedUsageAsksHealthImmediately(): Unit = runBlocking {
        active.value = false
        assertNull(usage(session()))
        assertEquals(1, healthReads())
        assertTrue(agent.streamCursors.isEmpty())
    }

    @Test fun inactiveConfigurationUsageReferencesAndMonitorKeepTheirOrdinaryReads(): Unit = runBlocking {
        active.value = false
        val session = session()
        val config = withTimeout(10_000) { session.configuration() }
        assertTrue(config.text.contains("config"))
        val following = session.usage.follow()
        session.references.readArtifacts(listOf("a1"))
        val monitor = MonitorModel(session, "m1")
        val store = ViewModelStore().also { it.put("monitor", monitor) }
        try {
            monitor.resume()
            eventually {
                agent.calls.containsAll(listOf("GET /v0/usage", "GET /v0/artifacts/a1", "GET ${SystemMonitorFeed.path("m1")}"))
            }
            assertTrue(agent.streamCursors.isEmpty())
        } finally {
            following.close()
            store.clear()
        }
    }

    @Test fun backgroundPauseReleasesWaitingUsageToItsOwnHealthRequest(): Unit = runBlocking {
        val session = session()
        bootstrapAsked.await()
        val read = waitingUsage(session)
        active.value = false
        assertNull(read.await())
        assertEquals(1, healthReads())
    }

    @Test fun failedBootstrapReleasesWaitingUsageToItsOwnHealthRequest(): Unit = runBlocking {
        val session = session(java.io.IOException("computer away"))
        bootstrapAsked.await()
        val read = waitingUsage(session)
        releaseBootstrap.complete(Unit)
        assertNull(read.await())
        assertEquals(1, healthReads())
    }

    @Test fun closingSessionCancelsWaitingUsageAndLaterCallsWithoutSendingHealth(): Unit = runBlocking {
        val session = session()
        bootstrapAsked.await()
        val read = waitingUsage(session)
        session.close()
        cancelled(read)
        cancelled(async { usage(session) })
        assertEquals(0, healthReads())
    }

    @Test fun signingOutCancelsWaitingUsageWithoutSendingHealth(): Unit = runBlocking {
        val session = session()
        bootstrapAsked.await()
        val read = waitingUsage(session)
        connections.update(id) { it.copy(signInRequired = true) }
        cancelled(read)
        assertEquals(0, healthReads())
        active.value = false
        connections.update(id) { it.copy(signInRequired = false) }
        assertNull(usage(session))
        assertEquals(1, healthReads())
    }

    @Test fun terminalErrorCancelsWaitingUsageWithoutSendingHealth(): Unit = runBlocking {
        val session = session(AgentConnectionException(AgentConnectionException.Reason.UpdateRequired))
        bootstrapAsked.await()
        val read = waitingUsage(session)
        releaseBootstrap.complete(Unit)
        eventually { session.status.value == AgentLinkStatus.UpdateRequired }
        cancelled(read)
        cancelled(async { usage(session) })
        assertEquals(0, healthReads())
    }
}