package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.*
import com.slopus.happy.documents.DocumentOpening
import com.slopus.happy.feed.FeedFilter
import com.slopus.happy.feed.FeedItem
import com.slopus.happy.feed.FeedSubject
import com.slopus.happy.feed.FeedLatest
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Ordinary screen reads must remain usable while automatic secondary startup waits. */
@RunWith(AndroidJUnit4::class)
class ScreenReadStartupTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val agent = FakeAgent()
    private val open = MutableStateFlow<String?>(null)
    private lateinit var connections: AgentConnections
    private lateinit var id: String

    @Before fun setUp(): Unit = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secrets = context.getSharedPreferences("screen-read-secrets", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences("screen-read-registry", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { agent })
        id = connections.add(AgentConnectionCredentials("addr", 24781, "dv1", "token"), "Mac").id
        agent.calls.clear()
    }

    @After fun tearDown() = scope.cancel()

    private fun manager(transport: Transport = agent) = AgentSessions(connections, scope, null, open, MutableStateFlow(true), makeTransport = { transport })
    private suspend fun eventually(check: () -> Boolean) = withTimeout(10_000) { while (!check()) delay(10) }
    private fun json(value: String) = AgentClient.json.parseToJsonElement(value) as JsonObject

    @Test fun artifactCatalogAndDocumentInitialStateReadWithoutStartingTheSession(): Unit = runBlocking {
        agent.resources["/v0/artifacts?limit=100"] = json("""{"artifacts":[],"nextPageCursor":null}""")
        agent.resources["/v0/surfaces/document/d1/state"] = json("""{"seq":0,"update":"AAA=","stateVector":"AA=="}""")
        val session = manager().session(id)!!
        session.artifacts.refresh().join()
        assertTrue(session.artifacts.state.value.loaded)
        assertNull(session.artifacts.state.value.error)
        assertEquals(DocumentOpening.Ready, session.documents.document("d1").start())
        assertEquals(SyncPhase.Offline, session.phase.value)
        assertTrue(agent.streamCursors.isEmpty())
        assertTrue(agent.calls.toString(), agent.calls.contains("GET /v0/artifacts?limit=100"))
        assertTrue(agent.calls.contains("GET /v0/surfaces/document/d1/state"))
        assertTrue(agent.calls.none { it.endsWith("/subscribe") })
    }

    @Test fun firstFeedPageAndPagingAndHighlightsReadWhileChatHoldsSecondaryStartup(): Unit = runBlocking {
        agent.bootstrap = agent.bootstrap.with("health", json("""{"ready":true,"version":{"protocol":30},"capabilities":{"feed":true,"feedSubjectFilter":true}}""")).with("feedUnread", 0)
        val home = CompletableDeferred<Unit>()
        val releaseHome = CompletableDeferred<Unit>()
        val chat = CompletableDeferred<Unit>()
        val releaseChat = CompletableDeferred<Unit>()
        fun page(id: String, cursor: String, more: Boolean): TransportResponse {
            val item = FeedItem(id, "1", cursor, FeedSubject("artifact", id), firstAt = 1, lastAt = 2)
            return TransportResponse(200, body = buildJsonObject {
                put("items", JsonArray(listOf(item.json()))); put("unread", 0); put("hasMore", more)
            }.toString().toByteArray())
        }
        val transport = object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path == "/v0/bootstrap/desktop") { home.complete(Unit); releaseHome.await() }
                if (path.startsWith("/v0/agents/hold/")) { chat.complete(Unit); releaseChat.await() }
                if (path.startsWith("/v0/feed?")) {
                    agent.calls += "$method $path"
                    return if ("before=" in path) page("older", "c1", false) else page("newest", "c2", true)
                }
                return agent.request(method, path, credential, body, headers, category)
            }
        }
        open.value = id
        val manager = manager(transport)
        val session = manager.session(id)!!
        home.await()
        manager.setOpenChat(id, "hold")
        chat.await()
        agent.frames.send(Wire.hello("c0"))
        releaseHome.complete(Unit)
        try {
            eventually { session.phase.value == SyncPhase.Verified && session.feedLibrary.state.value.items.size == 1 }
        } catch (error: TimeoutCancellationException) {
            throw AssertionError("phase=${session.phase.value}, feed=${session.feedLibrary.state.value}, calls=${agent.calls}", error)
        }
        assertTrue(agent.calls.none { it.startsWith("GET /v0/artifacts") || it == "POST /v0/git/watch" })
        session.feedLibrary.loadMore()
        eventually { session.feedLibrary.state.value.items.size == 2 }
        assertTrue(agent.calls.any { "before=c2" in it })
        session.feedLibrary.show(FeedFilter.Highlights)
        eventually { agent.calls.any { "subjects=" in it } }
        assertTrue(agent.calls.none { it.startsWith("GET /v0/artifacts") || it == "POST /v0/git/watch" })
        releaseChat.complete(Unit)
    }

    @Test fun openDocumentLinksAtHelloWhileHomeBootstrapIsHeldAndP2DoesNotRelink(): Unit = runBlocking {
        val home = CompletableDeferred<Unit>()
        val releaseHome = CompletableDeferred<Unit>()
        val subscriptions = java.util.concurrent.atomic.AtomicInteger()
        val transport = object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path == "/v0/bootstrap/desktop") { home.complete(Unit); releaseHome.await() }
                if (path == "/v0/surfaces/document/d1/subscribe") {
                    subscriptions.incrementAndGet()
                    return TransportResponse(200, body = """{"seq":0}""".toByteArray())
                }
                return agent.request(method, path, credential, body, headers, category)
            }
        }
        agent.resources["/v0/surfaces/document/d1/state"] = json("""{"seq":0,"update":"AAA=","stateVector":"AA=="}""")
        open.value = id
        val session = manager(transport).session(id)!!
        home.await()
        assertEquals(DocumentOpening.Ready, session.documents.document("d1").start())
        agent.frames.send("event: hello\ndata: {\"cursor\":\"c0\",\"gap\":false,\"resumed\":true,\"streamId\":\"st1\"}\n\n")
        eventually { subscriptions.get() == 1 }
        assertEquals(SyncPhase.P0Live, session.phase.value)
        assertTrue(agent.calls.none { it.startsWith("GET /v0/artifacts?") || it == "POST /v0/git/watch" })
        releaseHome.complete(Unit)
        eventually { session.phase.value == SyncPhase.Verified && agent.calls.any { it == "POST /v0/git/watch" } }
        assertEquals(1, subscriptions.get())
    }

    @Test fun artifactTodoAndUserNamesResolveWhileHomeNeverVerifies(): Unit = runBlocking {
        val home = CompletableDeferred<Unit>()
        val transport = object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (path == "/v0/bootstrap/desktop") { home.complete(Unit); awaitCancellation() }
                return agent.request(method, path, credential, body, headers, category)
            }
        }
        agent.resources["/v0/artifacts/a1"] = json("""{"artifact":{"id":"a1","title":"A title","type":"markdown","latestVersion":1}}""")
        agent.resources["/v0/surfaces/todo/s1/td1"] = json("""{"todo":{"text":"A todo"}}""")
        open.value = id
        val session = manager(transport).session(id)!!
        home.await()
        agent.frames.send(Wire.hello("c0"))
        eventually { session.phase.value == SyncPhase.P0Live }
        session.team.bootstrap(JsonArray(listOf(json("""{"id":"u2","name":"A teammate"}"""))), null)
        session.references.read("<happy-artifact id=\"a1\"/> <happy-user id=\"u2\"/>")
        session.feedLookups.want(listOf(
            FeedItem("f1", "1", "c1", FeedSubject("artifact", "a1"), firstAt = 1, lastAt = 2),
            FeedItem("f2", "1", "c2", FeedSubject("surface", "s1"), firstAt = 1, lastAt = 2, latest = FeedLatest("todo.created", todoId = "td1")),
        ))
        eventually {
            session.references.references.value.artifacts.containsKey("a1") &&
                session.references.references.value.users["u2"] == "A teammate" &&
                session.feedLookups.found.value.artifacts["a1"]?.title == "A title" &&
                session.feedLookups.found.value.todos["s1/td1"] == "A todo"
        }
        assertEquals(SyncPhase.P0Live, session.phase.value)
        assertTrue(agent.calls.none { it.startsWith("GET /v0/artifacts?") || it == "POST /v0/git/watch" })
    }
}