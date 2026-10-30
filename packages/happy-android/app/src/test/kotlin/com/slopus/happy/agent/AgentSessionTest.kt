package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.conversation.conversationRequest
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** An agent connection's live link: snapshot, journal, reconnect, cache and revocation. */
@RunWith(AndroidJUnit4::class)
class AgentSessionTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val agent = FakeAgent(
        Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))),
            tasks = listOf(Wire.task("t1", "Fix login", Wire.agent("at1"))),
            memberships = listOf(Wire.membership("t1", "1")),
        ),
    )
    private val cacheDir = File(context.cacheDir, "agent-session-test")
    private val open = MutableStateFlow<String?>(null)
    private val foreground = MutableStateFlow(true)
    private lateinit var connections: AgentConnections
    private lateinit var id: String

    @Before
    fun setUp(): Unit = runBlocking {
        cacheDir.deleteRecursively()
        val secrets = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { agent })
        id = connections.add(AgentConnectionCredentials("addr", 24781, "dv1", "token"), "Mac").id
        agent.calls.clear()
        open.value = id
    }

    @After
    fun tearDown() = scope.cancel()

    private fun sessions(transport: (AgentConnectionCredentials) -> Transport = { agent }) =
        AgentSessions(connections, scope, cacheDir, open, foreground, transport)

    private suspend fun <T> eventually(read: () -> T, check: (T) -> Boolean) {
        withTimeout(10_000) { while (!check(read())) kotlinx.coroutines.delay(20) }
    }

    @Test
    fun artifactFilesUseOnlyTheSelectedConnectionsCredential() = runBlocking {
        foreground.value = false
        open.value = null
        val other = connections.add(AgentConnectionCredentials("other-addr", 24781, "dv2", "other-token"), "Other").id
        val seen = mutableListOf<Triple<String, String, String>>()
        val sessions = sessions { credentials ->
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse {
                    seen += Triple(credentials.address, credential, path)
                    return TransportResponse(200, body = byteArrayOf(1, 2, 3))
                }
            }
        }
        ConversationApi(sessions.session(other)!!.conversationRequest()).artifactFile("r1", "2", "images/plot #1.png")
        assertEquals(listOf(Triple("other-addr", "other-token", "/v0/artifacts/r1/versions/2/files/images/plot%20%231.png")), seen)
        seen.clear()
        ConversationApi(sessions.session(id)!!.conversationRequest()).artifactFile("r1", "2", "report.md")
        assertEquals(listOf(Triple("addr", "token", "/v0/artifacts/r1/versions/2/files/report.md")), seen)
    }

    @Test
    fun theSnapshotThenTheJournalKeepHomeCurrent() = runBlocking {
        val session = sessions().session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        assertEquals(listOf("ab1", "at1"), session.feed.first { it.loaded }.conversations.map { it.agentId })
        assertEquals("c0", agent.streamCursors.single())

        agent.frames.send(Wire.frame("c1", "agent.updated", Wire.updated("agentId", "at1", "01", "02", buildJsonObject { put("status", "thinking") })))
        eventually({ session.feed.value.conversations.single { it.agentId == "at1" } }) { it.working }
        assertEquals("c1", session.catalog.value.cursor)
        assertTrue(session.agent("at1").first()!!.working)
    }

    @Test
    fun aDroppedStreamResumesFromTheLastCursor() = runBlocking {
        val session = sessions().session(id)!!
        agent.frames.send(Wire.hello("c0"))
        agent.frames.send(Wire.frame("c1", "agent.updated", Wire.updated("agentId", "at1", "01", "02", buildJsonObject { put("status", "thinking") })))
        eventually({ session.catalog.value.cursor }) { it == "c1" }
        val dropped = agent.frames
        agent.frames = Channel(Channel.UNLIMITED)
        dropped.close()
        eventually({ agent.streamCursors.size }) { it == 2 }
        assertEquals("c1", agent.streamCursors[1])
        // One snapshot read only: a resumed stream needs none.
        assertEquals(1, agent.calls.count { it == "GET /v0/bootstrap/desktop" })
    }

    @Test
    fun aGapReadsTheSnapshotAgain(): Unit = runBlocking {
        val session = sessions().session(id)!!
        eventually({ session.feed.value.loaded }) { it }
        agent.bootstrap = Wire.bootstrap(bots = listOf(Wire.bot("b2", "Other", Wire.agent("ab2"))), cursor = "c7")
        agent.frames.send(Wire.hello("c7", gap = true))
        eventually({ session.feed.value.conversations.map { it.agentId } }) { it == listOf("ab2") }
    }

    @Test
    fun bootstrapAndGapReadsStaySyncingUntilTheirResponsesArrive() = runBlocking {
        var gate = CompletableDeferred<Unit>()
        val session = sessions {
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse {
                    if (path == "/v0/bootstrap/desktop") gate.await()
                    return agent.request(method, path, credential, body, headers)
                }
            }
        }.session(id)!!
        eventually({ session.isSyncing.value }) { it }
        assertFalse(session.feed.value.loaded)
        gate.complete(Unit)
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        eventually({ session.isSyncing.value }) { !it }

        gate = CompletableDeferred()
        agent.frames.send(Wire.hello("c7", gap = true))
        eventually({ session.isSyncing.value }) { it }
        assertEquals(AgentLinkStatus.Connected, session.status.value)
        gate.complete(Unit)
        eventually({ session.isSyncing.value }) { !it }
    }

    @Test
    fun theCatalogIsCachedForOfflineHome() = runBlocking {
        val first = sessions().session(id)!!
        eventually({ first.feed.value.loaded }) { it }
        eventually({ File(cacheDir, "$id.json").exists() }) { it }
        first.close()
        open.value = null
        val offline = sessions { error("no network") }.session(id)!!
        assertEquals(listOf("ab1", "at1"), offline.feed.value.conversations.map { it.agentId })
    }

    @Test
    fun aClosedConnectionOrBackgroundAppHoldsNoLink() = runBlocking {
        foreground.value = false
        val session = sessions().session(id)!!
        kotlinx.coroutines.delay(300)
        assertTrue(agent.calls.isEmpty())
        foreground.value = true
        eventually({ agent.calls.contains("STREAM /v0/events/stream") }) { it }
        eventually({ session.feed.value.conversations }) { it.isNotEmpty() }
    }

    @Test
    fun aRevokedPhoneStopsAndIsMarked(): Unit = runBlocking {
        agent.revoked = true
        val session = sessions().session(id)!!
        eventually({ session.status.value }) { it == AgentLinkStatus.Revoked }
        eventually({ connections.accounts.value.single().revoked }) { it }
    }

    @Test
    fun aRemovedConnectionHasNoSession() = runBlocking {
        val sessions = sessions()
        assertTrue(sessions.session(id) != null)
        connections.remove(id)
        assertNull(sessions.session(id))
    }

    @Test
    fun aTaskMadeInAChatIsListedAtOnce(): Unit = runBlocking {
        val session = sessions().session(id)!!
        eventually({ session.feed.value.loaded }) { it }
        session.upsertTask(Wire.task("t9", "New Task", Wire.agent("at9")))
        eventually({ session.feed.value.conversations.map { it.agentId } }) { "at9" in it }
    }
}
