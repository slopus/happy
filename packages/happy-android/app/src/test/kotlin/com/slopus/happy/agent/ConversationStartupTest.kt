package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.*
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Problem
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.conversation.makeConversation
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

/** History ordering releases ordinary reads, or ends with the stopped session's error. */
@RunWith(AndroidJUnit4::class)
class ConversationStartupTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val foreground = MutableStateFlow(true)
    private val open = MutableStateFlow<String?>(null)
    private val agent = FakeAgent()
    private lateinit var connections: AgentConnections
    private lateinit var id: String
    private val held = mutableListOf<Conversation>()

    @Before fun setUp() = runBlocking {
        val secrets = context.getSharedPreferences("startup-secrets", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences("startup-registry", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { agent })
        id = connections.add(AgentConnectionCredentials("addr", 24781, "dv1", "token"), "Mac").id
        open.value = id
        fresh("Fresh")
        agent.calls.clear()
    }

    @After fun tearDown() {
        held.forEach { it.close() }
        scope.cancel()
    }

    private fun fresh(title: String, message: String? = null) {
        agent.resources["/v0/agents/at1/bootstrap"] = AgentClient.json.parseToJsonElement("""{"agent":{"id":"at1","status":"idle","title":"$title"},"pending":[]}""") as kotlinx.serialization.json.JsonObject
        val runs = if (message == null) "[]" else """[{"id":"r$message","status":"completed","messages":[{"id":"m$message","role":"user","createdAt":1,"content":[{"type":"text","text":"$message"}],"metadata":{},"status":"accepted","delivery":"queue","mode":{"providerId":"codex","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"auto"},"runId":null}]}]"""
        agent.resources["/v0/agents/at1/messages?limit=100&omitToolData=true"] = AgentClient.json.parseToJsonElement("""{"runs":$runs,"hasMore":false}""") as kotlinx.serialization.json.JsonObject
    }

    private fun manager(transport: (AgentConnectionCredentials) -> Transport = { agent }) =
        AgentSessions(connections, scope, null, open, foreground, makeTransport = transport)

    private suspend fun eventually(check: () -> Boolean) = withTimeout(10_000) { while (!check()) delay(10) }

    private fun conversation(session: AgentSession) = session.makeConversation("at1", null).also { held += it; it.start() }

    private suspend fun assertCurrent(session: AgentSession): Conversation {
        val before = agent.calls.count { "/messages?" in it }
        return conversation(session).also { chat ->
            eventually { chat.state.value.synced && chat.state.value.title == "Fresh" }
            assertTrue(agent.calls.toString(), agent.calls.count { "/messages?" in it } > before)
            assertTrue(agent.calls.contains("GET /v0/agents/at1/bootstrap"))
        }
    }

    private suspend fun assertStopped(session: AgentSession, reason: AgentConnectionException.Reason) {
        val before = agent.calls.count { it.startsWith("GET /v0/agents/") }
        val chat = conversation(session)
        eventually { chat.state.value.loaded && !chat.state.value.syncing }
        assertEquals(Problem.Link(reason), chat.state.value.error)
        assertFalse(chat.state.value.synced)
        assertEquals(before, agent.calls.count { it.startsWith("GET /v0/agents/") })
    }

    private suspend fun verified(manager: AgentSessions): AgentSession = manager.session(id)!!.also { session ->
        agent.frames.send(Wire.hello("c0"))
        eventually { session.phase.value == SyncPhase.Verified }
    }

    @Test fun neverStartedSessionReadsHistoryImmediately() = runBlocking {
        open.value = null
        val session = manager().session(id)!!
        assertCurrent(session)
        assertEquals(SyncPhase.Offline, session.phase.value)
        assertTrue(agent.streamCursors.isEmpty())
    }

    @Test fun secondInactiveAccountReadsHistoryImmediately() = runBlocking {
        val second = connections.add(AgentConnectionCredentials("other", 24782, "dv2", "token2"), "Other").id
        val manager = manager()
        verified(manager)
        val session = manager.session(second)!!
        assertCurrent(session)
        assertEquals(SyncPhase.Offline, session.phase.value)
        assertEquals(1, agent.streamCursors.size)
    }

    @Test fun backgroundPauseDoesNotHoldANewConversation(): Unit = runBlocking {
        val session = verified(manager())
        foreground.value = false
        eventually { session.phase.value == SyncPhase.Offline }
        assertCurrent(session)
    }

    @Test fun connectionErrorBeforeStreamAskReleasesHistory(): Unit = runBlocking {
        val attempts = AtomicInteger()
        val session = manager {
            if (attempts.incrementAndGet() == 1) throw IOException("connect failed before stream")
            agent
        }.session(id)!!
        eventually { attempts.get() > 0 }
        assertCurrent(session)
    }

    private suspend fun terminal(reason: AgentConnectionException.Reason, status: AgentLinkStatus) {
        val session = manager { object : Transport by agent {
            override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream = throw AgentConnectionException(reason)
        } }.session(id)!!
        eventually { session.status.value == status }
        assertStopped(session, reason)
    }

    @Test fun revokedStreamEndsHistoryWithRevokedErrorWithoutARequest() = runBlocking {
        terminal(AgentConnectionException.Reason.Revoked, AgentLinkStatus.Revoked)
    }

    @Test fun updateRequiredStreamEndsHistoryWithUpdateErrorWithoutARequest() = runBlocking {
        terminal(AgentConnectionException.Reason.UpdateRequired, AgentLinkStatus.UpdateRequired)
    }

    @Test fun signOutEndsASeparatelyObservedConversationWithoutARequest(): Unit = runBlocking {
        val session = verified(manager())
        connections.signedOut(id)
        eventually { session.status.value == AgentLinkStatus.SignInRequired && session.phase.value == SyncPhase.Offline }
        assertStopped(session, AgentConnectionException.Reason.SignInRequired)
    }

    @Test fun switchingAwayDoesNotHoldTheOldAccountsHistory(): Unit = runBlocking {
        val session = verified(manager())
        open.value = connections.add(AgentConnectionCredentials("other", 24782, "dv2", "token2"), "Other").id
        eventually { session.phase.value == SyncPhase.Offline }
        assertCurrent(session)
    }

    @Test fun closedSessionEndsASeparatelyObservedConversationWithoutARequest(): Unit = runBlocking {
        val session = verified(manager())
        session.close()
        assertStopped(session, AgentConnectionException.Reason.Unavailable)
    }

    @Test fun aPendingStreamHeadDoesNotHoldHistory(): Unit = runBlocking {
        val releaseHead = CompletableDeferred<Unit>()
        val manager = manager { object : Transport by agent {
            override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
                agent.calls += "STREAM $path"
                releaseHead.await()
                return agent.stream(path, credential, headers, silenceMillis)
            }
        } }
        manager.setOpenChat(id, "at1")
        val session = manager.session(id)!!
        val chat = conversation(session)
        eventually { chat.state.value.synced }
        assertEquals("Fresh", chat.state.value.title)
        assertTrue(agent.calls.contains("STREAM /v0/events/stream"))
        assertEquals(1, agent.calls.count { "/messages?" in it })
        assertFalse(agent.calls.contains("GET /v0/bootstrap/desktop"))
        releaseHead.complete(Unit)
    }

    @Test fun homeIsAskedAfterChatRequestsWithoutWaitingForTheirReplies(): Unit = runBlocking {
        open.value = null
        val release = CompletableDeferred<Unit>()
        val asked = java.util.concurrent.CopyOnWriteArrayList<String>()
        val manager = manager { object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path.startsWith("/v0/agents/at1/")) release.await()
                return agent.request(method, path, credential, body, headers, category)
            }
        } }
        manager.setOpenChat(id, "at1")
        val session = manager.session(id)!!
        session.client.observeAsk = { method, path -> asked += "$method $path" }
        open.value = id
        eventually { asked.contains("GET /v0/bootstrap/desktop") }
        assertEquals("WARM 2", asked.first())
        assertEquals("STREAM /v0/events/stream", asked[1])
        assertEquals(setOf("GET /v0/agents/at1/bootstrap", "GET /v0/agents/at1/messages?limit=100&omitToolData=true"), asked.drop(2).dropLast(1).toSet())
        assertEquals("GET /v0/bootstrap/desktop", asked.last())
        agent.frames.send(Wire.hello("c0"))
        eventually { session.phase.value == SyncPhase.Verified }
        assertTrue(agent.calls.none { it.startsWith("GET /v0/artifacts") || it == "POST /v0/git/watch" })
        release.complete(Unit)
    }

    @Test fun pauseOfPreparedReadsFallsBackInTheStillObservedConversation() = runBlocking {
        val started = AtomicInteger()
        val manager = manager { object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path.startsWith("/v0/agents/at1/") && started.incrementAndGet() <= 2) awaitCancellation()
                return agent.request(method, path, credential, body, headers, category)
            }
        } }
        manager.setOpenChat(id, "at1")
        val session = manager.session(id)!!
        val chat = conversation(session)
        eventually { started.get() == 2 }
        foreground.value = false
        eventually { chat.state.value.synced }
        assertEquals("Fresh", chat.state.value.title)
        assertTrue(agent.calls.any { "/messages?" in it })
        assertEquals(SyncPhase.Offline, session.phase.value)
    }

    @Test fun anEarlyReadBecomesCurrentAgainOnHelloAndOnALaterGap() = runBlocking {
        open.value = null
        fresh("Before stream")
        val manager = manager()
        val session = manager.session(id)!!
        val chat = conversation(session)
        eventually { chat.state.value.synced && chat.state.value.title == "Before stream" }
        fresh("After stream", "BetweenReadAndStream")
        manager.setOpenChat(id, "at1")
        open.value = id
        agent.frames.send(Wire.hello("c0"))
        eventually { chat.state.value.synced && chat.state.value.title == "After stream" }
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.User>().any { it.text == "BetweenReadAndStream" })
        assertTrue(agent.calls.count { "/messages?" in it } >= 2)
        fresh("After gap", "AfterGap")
        agent.resources["/v0/agents/at1/messages?limit=100&omitToolData=true&after=mBetweenReadAndStream"] = agent.resources.getValue("/v0/agents/at1/messages?limit=100&omitToolData=true")
        agent.frames.send(Wire.hello("c1", gap = true))
        eventually { chat.state.value.synced && chat.state.value.title == "After gap" }
        assertTrue(chat.state.value.rows.filterIsInstance<ConversationRow.User>().any { it.text == "AfterGap" })
        assertTrue(agent.calls.count { "/messages?" in it } >= 3)
    }

    @Test fun aPreparedReadSuppressesOnlyAnOpeningHelloCoveredByBothCursors() = runBlocking {
        fresh("Prepared")
        agent.resources["/v0/agents/at1/bootstrap"] = agent.resources.getValue("/v0/agents/at1/bootstrap").with("cursor", "c1")
        agent.resources["/v0/agents/at1/messages?limit=100&omitToolData=true"] = agent.resources.getValue("/v0/agents/at1/messages?limit=100&omitToolData=true").with("cursor", "c0")
        val manager = manager()
        manager.setOpenChat(id, "at1")
        val session = manager.session(id)!!
        val chat = conversation(session)
        eventually { chat.state.value.synced && chat.state.value.title == "Prepared" }
        fresh("Opening uncovered")
        agent.frames.send(Wire.hello("c1"))
        eventually { chat.state.value.synced && chat.state.value.title == "Opening uncovered" }
        assertEquals(2, agent.calls.count { "/messages?" in it })
        fresh("Later hello")
        agent.frames.send(Wire.hello("c0"))
        eventually { chat.state.value.synced && chat.state.value.title == "Later hello" }
        assertEquals(3, agent.calls.count { "/messages?" in it })
    }
}