package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportStream
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.testing.cancelAndAwait
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * The open agent connection connects as the process starts, before the app
 * graph or a window exist, and its session takes that tunnel rather than
 * making a second (StartupLink).
 */
@RunWith(AndroidJUnit4::class)
class StartupLinkTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val agent = "agent-connection-early"
    private val credentials = AgentConnectionCredentials("127.0.0.1", 9, "dv1", "token")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val made = CopyOnWriteArrayList<Tunnel>()
    private val link = StartupLink(scope) { Tunnel().also { made += it } }
    private var graph: AppGraph? = null

    /** A tunnel that connects until closed, and answers nothing. */
    private class Tunnel : Transport {
        val warmed = CopyOnWriteArrayList<Int>()
        val streams = AtomicInteger()
        val closed = CompletableDeferred<Unit>()

        override suspend fun warm(count: Int) {
            warmed += count
            if (count == 0) closed.await()
        }

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

        override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
            streams.incrementAndGet()
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        }

        override suspend fun close() {
            closed.complete(Unit)
        }
    }

    @Before
    fun setUp() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, AgentConnections.REGISTRY_PREFS, AgentConnections.SECRETS_PREFS)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }

    @After
    fun tearDown() {
        graph?.close()
        scope.cancelAndAwait()
    }

    /** One agent connection, paired before and open: what a cold start finds. */
    private fun paired(activeId: String? = agent) {
        ExpoSecureStore(context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE), keys, keychainService = AgentConnections.KEYCHAIN_SERVICE)
            .setItem(agent, Json.encodeToString(AgentConnectionCredentials.serializer(), credentials))
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"$agent","name":"Studio","addedAt":1}]""").commit()
        val active = activeId?.let { "\"$it\"" } ?: "null"
        context.getSharedPreferences(AccountStore.PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString("registry", """{"entries":[],"activeId":$active}""").commit()
    }

    private fun graph() = AppGraph(context, "android/test", "http://127.0.0.1:9", keys, databaseName = null, startup = link).also { graph = it }

    @Test
    fun connectsBeforeTheGraphAndTheWindow() {
        paired()
        link.start(context, keys)
        // No graph, no activity, no foreground: the tunnel is already connecting.
        eventually(message = "the early connect") { made.singleOrNull()?.warmed == listOf(0) }
        assertNull(graph)
    }

    @Test
    fun theSessionTakesTheSameTunnel() {
        paired()
        link.start(context, keys)
        eventually(message = "the early connect") { made.singleOrNull()?.warmed == listOf(0) }
        val tunnel = made.single()
        val graph = graph()
        assertEquals(com.slopus.happy.OpenAccount.Agent(agent), graph.openAccount.value)
        graph.warmHome()
        graph.setForeground(true)
        // The session's warm and its event stream go over the tunnel made at the start.
        eventually(message = "the session on the early tunnel") { tunnel.warmed == listOf(0, 2) && tunnel.streams.get() > 0 }
        assertEquals("no second tunnel", 1, made.size)
        assertTrue("still open", !tunnel.closed.isCompleted)
        // Taken once: nothing else gets it.
        assertNull(link.take(credentials))
    }

    @Test
    fun noOpenAgentConnectionStartsNothing() {
        paired(activeId = null)
        link.start(context, keys).let { runBlocking { it.join() } }
        assertEquals(0, made.size)
        assertNull(link.take(credentials))

        // A Happy account open: nothing either (its id is the 16 hex of an account).
        paired(activeId = "0123456789abcdef")
        val other = StartupLink(scope) { Tunnel().also { made += it } }
        other.start(context, keys).let { runBlocking { it.join() } }
        assertEquals(0, made.size)
    }

    @Test
    fun aSignedOutConnectionStartsNothing() {
        paired()
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"$agent","name":"Studio","addedAt":1,"server":"https://team.example","signInRequired":true}]""").commit()
        link.start(context, keys).let { runBlocking { it.join() } }
        assertEquals(0, made.size)
    }

    @Test
    fun removedDuringTheEarlyConnectItStops() {
        paired()
        link.start(context, keys)
        eventually(message = "the early connect") { made.singleOrNull()?.warmed == listOf(0) }
        val tunnel = made.single()
        val graph = graph()
        // Forgotten before any session took it: the connect is stopped.
        runBlocking { graph.agentConnections.remove(agent) }
        eventually(message = "the early tunnel closed") { tunnel.closed.isCompleted }
        assertNull(link.take(credentials))
    }

    @Test
    fun signedOutOrAnotherAccountOpenedItStops() {
        val accounts = MutableStateFlow(listOf(AgentConnection(id = agent, name = "Studio", addedAt = 1)))
        val open = MutableStateFlow<String?>(agent)
        link.start(openId = { agent }, accounts = { accounts.value }, credentials = { credentials })
        eventually(message = "the early connect") { made.singleOrNull()?.warmed == listOf(0) }
        link.follow(open, accounts)
        Thread.sleep(50)
        assertTrue("kept while its account is open", !made.single().closed.isCompleted)
        accounts.value = listOf(AgentConnection(id = agent, name = "Studio", addedAt = 1, server = "https://team.example", signInRequired = true))
        eventually(message = "closed on sign-out") { made.single().closed.isCompleted }
        assertNull(link.take(credentials))

        val second = StartupLink(scope) { Tunnel().also { made += it } }
        val back = MutableStateFlow(listOf(AgentConnection(id = agent, name = "Studio", addedAt = 1)))
        second.start(openId = { agent }, accounts = { back.value }, credentials = { credentials })
        eventually(message = "the second early connect") { made.size == 2 && made[1].warmed == listOf(0) }
        second.follow(open, back)
        open.value = "agent-connection-other"
        eventually(message = "closed when another account opens") { made[1].closed.isCompleted }
    }

    @Test
    fun aTakenTunnelIsTheSessionsToClose() {
        val accounts = MutableStateFlow(listOf(AgentConnection(id = agent, name = "Studio", addedAt = 1)))
        link.start(openId = { agent }, accounts = { accounts.value }, credentials = { credentials })
        eventually(message = "the early connect") { made.singleOrNull()?.warmed == listOf(0) }
        link.follow(MutableStateFlow(agent), accounts)
        assertNull("other credentials are not this tunnel's", link.take(credentials.copy(deviceToken = "other")))
        assertSame(made.single(), link.take(credentials))
        accounts.value = emptyList()
        Thread.sleep(50)
        assertTrue("the follower let go once taken", !made.single().closed.isCompleted)
    }
}
