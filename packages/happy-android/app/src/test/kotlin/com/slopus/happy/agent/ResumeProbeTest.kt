package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.AgentEndpoint
import com.slopus.happy.connection.AgentEndpointTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Back from the background, the tunnels a session kept through it look for
 * every way to the agent again before its stream asks them for anything
 * (iOS's ForegroundProbeTests); and a network that returns is told to them.
 */
@RunWith(AndroidJUnit4::class)
class ResumeProbeTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val first = FakeAgent()
    private val second = FakeAgent()
    private val open = MutableStateFlow<String?>(null)
    private val foreground = MutableStateFlow(true)
    private val network = MutableStateFlow(true)
    private lateinit var connections: AgentConnections
    private lateinit var firstId: String
    private lateinit var secondId: String

    @Before
    fun setUp(): Unit = runBlocking {
        val secrets = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { first })
        firstId = connections.add(AgentConnectionCredentials("addr1", 24781, "first", "token"), "First").id
        secondId = connections.add(AgentConnectionCredentials("addr2", 24781, "second", "token"), "Second").id
        first.calls.clear(); second.calls.clear()
    }

    @After
    fun tearDown() = scope.cancel()

    /** An agent that writes down when its transport was told the app or the network came back. */
    private fun probing(agent: FakeAgent): Transport = object : Transport by agent {
        override suspend fun resumed() { agent.calls += "resumed" }
        override suspend fun networkChanged() { agent.calls += "network changed" }
    }

    private fun sessions() = AgentSessions(connections, scope, null, open, foreground, network = network) {
        probing(if (it.deviceId == "first") first else second)
    }

    private suspend fun <T> eventually(read: () -> T, check: (T) -> Boolean) {
        withTimeout(10_000) { while (!check(read())) delay(20) }
    }

    /** What [agent] was asked after [mark]. */
    private fun after(mark: String, agent: FakeAgent) = agent.calls.dropWhile { it != mark }.drop(1)

    /**
     * Whether the session's transport was resumed, once, before its stream
     * asked anything. Discovery's own transports (every agent, every
     * foreground) are fresh, never resumed, and may ask first.
     */
    private fun resumedFirst(calls: List<String>) =
        calls.count { it == "resumed" } == 1 && calls.indexOf("resumed") < calls.indexOfFirst { it.startsWith("STREAM") }

    /** Up and live, its transport holding tunnels; then a fresh stream for the next connect. */
    private suspend fun live(session: AgentSession, agent: FakeAgent) {
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
    }

    /** The app goes behind, as AppGraph.setForeground tells it. */
    private suspend fun background(manager: AgentSessions, vararg agents: FakeAgent) {
        foreground.value = false
        manager.backgrounded()
        agents.forEach { it.frames.close(); it.frames = Channel(Channel.UNLIMITED) }
        delay(100)
    }

    @Test
    fun returningResumesTheOpenAgentBeforeItsStreamAsks() = runBlocking {
        open.value = firstId
        val manager = sessions()
        val session = manager.session(firstId)!!
        live(session, first)
        background(manager, first)
        first.calls += "background"
        foreground.value = true
        eventually({ after("background", first) }) { calls -> calls.any { it.startsWith("STREAM") } }
        val resumed = after("background", first)
        assertTrue("the stream asked before its tunnels were resumed: $resumed", resumedFirst(resumed))

        // The link starting again without a background between (another account open meanwhile): nothing kept went stale.
        first.frames.send(Wire.hello("c1"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        first.calls += "switch"
        open.value = null
        delay(100)
        open.value = firstId
        eventually({ after("switch", first) }) { calls -> calls.any { it.startsWith("STREAM") } }
        assertFalse(after("switch", first).toString(), after("switch", first).contains("resumed"))
    }

    @Test
    fun anAgentKeptThroughTheBackgroundIsResumedWhenOpenedLater() = runBlocking {
        val manager = sessions()
        open.value = secondId
        live(manager.session(secondId)!!, second)
        open.value = firstId
        val session = manager.session(firstId)!!
        live(session, first)
        background(manager, first, second)
        second.calls += "background"
        foreground.value = true
        eventually({ first.calls }) { calls -> calls.count { it.startsWith("STREAM") } >= 2 }
        delay(100)
        assertFalse("an agent not open woke its tunnels", after("background", second).contains("resumed"))

        open.value = secondId
        eventually({ after("background", second) }) { calls -> calls.any { it.startsWith("STREAM") } }
        assertTrue(after("background", second).toString(), resumedFirst(after("background", second)))

        // Once is enough until the next background.
        second.frames.send(Wire.hello("c1"))
        eventually({ manager.session(secondId)!!.status.value }) { it == AgentLinkStatus.Connected }
        second.calls += "again"
        open.value = firstId
        delay(100)
        open.value = secondId
        eventually({ after("again", second) }) { calls -> calls.any { it.startsWith("STREAM") } }
        assertFalse(after("again", second).contains("resumed"))
    }

    @Test
    fun aNetworkThatReturnsIsToldToTheTunnels() = runBlocking {
        open.value = firstId
        val session = sessions().session(firstId)!!
        live(session, first)
        network.value = false
        delay(100)
        network.value = true
        eventually({ first.calls }) { it.contains("network changed") }
    }

    @Test
    fun theEndpointPassesItOnOnceItHasPickedATransport() = runBlocking {
        val agent = FakeAgent()
        val endpoint = AgentEndpoint(AgentConnectionCredentials("addr", 24781, "dv", "token")) {}
        val transport = AgentEndpointTransport(endpoint) { probing(agent) }
        // Nothing picked yet: nothing to tell.
        transport.resumed()
        transport.networkChanged()
        transport.request("GET", "/v0/health", "token")
        transport.resumed()
        transport.networkChanged()
        assertEquals(listOf("GET /v0/health", "resumed", "network changed"), agent.calls.toList())
        transport.close()
    }
}
