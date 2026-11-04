package com.slopus.happy.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
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

    private fun sessions(chime: () -> Unit = {}, transport: (AgentConnectionCredentials) -> Transport = { agent }) =
        AgentSessions(connections, scope, cacheDir, open, foreground, makeTransport = transport, chime = chime)

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
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    seen += Triple(credentials.address, credential, path)
                    return TransportResponse(200, body = byteArrayOf(1, 2, 3))
                }
            }
        }
        ArtifactClient(sessions.session(other)!!.client).file("r1", 2, "images/plot #1.png")
        assertEquals(listOf(Triple("other-addr", "other-token", "/v0/artifacts/r1/versions/2/files/images/plot%20%231.png")), seen)
        seen.clear()
        ArtifactClient(sessions.session(id)!!.client).file("r1", 2, "report.md")
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
    fun aConversationThatFinishesLiveChimesOnceAndNeverSilencesIt() = runBlocking {
        val chimes = java.util.concurrent.atomic.AtomicInteger()
        val session = sessions(chime = { chimes.incrementAndGet() }).session(id)!!
        agent.frames.send(Wire.hello("c0"))
        session.feed.first { it.loaded }
        fun run(id: String, endedAt: Long? = null) = buildJsonObject { put("id", id); if (endedAt != null) put("endedAt", endedAt) }
        agent.frames.send(Wire.frame("c1", "run.started", buildJsonObject { put("agentId", "at1"); put("run", run("r1")) }))
        agent.frames.send(Wire.frame("c2", "run.finished", buildJsonObject { put("agentId", "at1"); put("run", run("r1", System.currentTimeMillis())) }))
        // A finish long past is the journal catching up: quiet.
        agent.frames.send(Wire.frame("c3", "run.finished", buildJsonObject { put("agentId", "ab1"); put("run", run("r0", 1L)) }))
        eventually({ session.catalog.value.cursor }) { it == "c3" }
        assertEquals(1, chimes.get())

        session.setCompletionSound(CompletionSound.Never)
        eventually({ session.completionSound.value }) { it == CompletionSound.Never }
        agent.frames.send(Wire.frame("c4", "run.finished", buildJsonObject { put("agentId", "at1"); put("run", run("r2", System.currentTimeMillis())) }))
        eventually({ session.catalog.value.cursor }) { it == "c4" }
        assertEquals(1, chimes.get())
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
    fun signInRequiredStopsAnOpenStreamAndSigningInResumesIt() = runBlocking {
        val session = sessions().session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        // A refused refresh elsewhere (git watch, a request) while the stream stays open.
        connections.update(id) { it.copy(signInRequired = true) }
        eventually({ session.status.value }) { it == AgentLinkStatus.SignInRequired }
        agent.frames = Channel(Channel.UNLIMITED)
        connections.update(id) { it.copy(signInRequired = false) }
        eventually({ agent.streamCursors.size }) { it == 2 }
        assertEquals("c0", agent.streamCursors[1])
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
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
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
        // Read off the main thread, so it comes a moment after the session is made.
        eventually({ offline.feed.value.conversations.map { it.agentId } }) { it == listOf("ab1", "at1") }
    }

    @Test
    fun comingBackResumesTheJournalFromTheKeptCursorWithoutTheSnapshot() = runBlocking {
        val first = sessions().session(id)!!
        agent.frames.send(Wire.hello("c0"))
        agent.frames.send(Wire.frame("c1", "agent.updated", Wire.updated("agentId", "at1", "01", "02", buildJsonObject { put("status", "thinking") })))
        eventually({ first.catalog.value.cursor }) { it == "c1" }
        eventually({ File(cacheDir, "$id.json").takeIf { it.exists() }?.readText().orEmpty() }) { "\"c1\"" in it }
        first.close()
        agent.calls.clear()
        agent.streamCursors.clear()
        agent.frames = Channel(Channel.UNLIMITED)

        // A cold start (or the app back in front): the kept catalog, then the journal from its cursor.
        val again = sessions().session(id)!!
        eventually({ agent.streamCursors.size }) { it == 1 }
        assertEquals("c1", agent.streamCursors.single())
        assertEquals(0, agent.calls.count { it == "GET /v0/bootstrap/desktop" })
        eventually({ again.feed.value.conversations.single { it.agentId == "at1" } }) { it.working }

        // A gap is the one thing that reads the snapshot again.
        agent.frames.send(Wire.hello("c9", gap = true))
        eventually({ agent.calls.count { it == "GET /v0/bootstrap/desktop" } }) { it == 1 }
    }

    @Test
    fun goingBehindAndComingBackDoesNotReadTheSnapshotAgain() = runBlocking {
        val session = sessions().session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        assertEquals(1, agent.calls.count { it == "GET /v0/bootstrap/desktop" })
        foreground.value = false
        agent.frames.close()
        agent.frames = Channel(Channel.UNLIMITED)
        kotlinx.coroutines.delay(100)
        foreground.value = true
        eventually({ agent.streamCursors.size }) { it == 2 }
        assertEquals("c0", agent.streamCursors[1])
        assertEquals(1, agent.calls.count { it == "GET /v0/bootstrap/desktop" })
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
    fun periodicIdentityRefreshStopsInBackgroundAndOnDisposal() = runBlocking {
        val discoveryScope = CoroutineScope(SupervisorJob(scope.coroutineContext[kotlinx.coroutines.Job]) + Dispatchers.Default)
        open.value = null
        val opened = java.util.concurrent.atomic.AtomicInteger()
        val closed = java.util.concurrent.atomic.AtomicInteger()
        AgentSessions(connections, discoveryScope, null, open, foreground, identityRefreshMillis = 25) {
            opened.incrementAndGet()
            object : Transport by agent { override suspend fun close() { closed.incrementAndGet() } }
        }
        eventually({ agent.calls.count { it == "GET /v0/config" } }) { it >= 2 }
        assertEquals(1, opened.get())
        assertEquals(0, closed.get())
        assertFalse(agent.calls.any { it.startsWith("STREAM") || it.contains("bootstrap") })
        foreground.value = false
        kotlinx.coroutines.delay(100)
        val background = agent.calls.count { it == "GET /v0/config" }
        kotlinx.coroutines.delay(100)
        assertEquals(background, agent.calls.count { it == "GET /v0/config" })
        assertEquals(1, closed.get())
        foreground.value = true
        eventually({ agent.calls.count { it == "GET /v0/config" } }) { it > background }
        discoveryScope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
        discoveryScope.coroutineContext[kotlinx.coroutines.Job]!!.join()
        val disposed = agent.calls.count { it == "GET /v0/config" }
        kotlinx.coroutines.delay(100)
        assertEquals(disposed, agent.calls.count { it == "GET /v0/config" })
        assertEquals(opened.get(), closed.get())
    }

    @Test
    fun discoveryDoesNotSendAvatarEtagForMissingPicture() = runBlocking {
        foreground.value = false
        val missing = File(cacheDir, "does-not-exist.png")
        connections.update(id) { it.copy(avatarFile = missing.path, avatarETag = "stale") }
        val headersSeen = CompletableDeferred<Map<String, String>>()
        AgentSessions(connections, scope, null, open, foreground, identityRefreshMillis = 25) {
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse = when (path) {
                    "/v0/config" -> TransportResponse(200, body = """{"config":{"node":{"name":"Mac","avatar":{"thumbhash":"hash"}}}}""".toByteArray())
                    "/v0/node/avatar" -> { headersSeen.complete(headers); TransportResponse(404) }
                    else -> agent.request(method, path, credential, body, headers)
                }
            }
        }
        foreground.value = true
        assertFalse(withTimeout(5_000) { headersSeen.await() }.containsKey("If-None-Match"))
    }

    @Test
    fun foregroundDiscoveryRefreshesUnselectedAccountsAndDoesNotCancelHealthyStream() = runBlocking {
        val other = connections.add(AgentConnectionCredentials("other", 24781, "other-device", "other-token"), "Other")
        val failRefresh = java.util.concurrent.atomic.AtomicBoolean(false)
        val otherConfigs = java.util.concurrent.atomic.AtomicInteger()
        val failures = java.util.concurrent.atomic.AtomicInteger()
        val manager = AgentSessions(connections, scope, null, open, foreground, identityRefreshMillis = 25) { credentials ->
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if (path == "/v0/config" && credentials.deviceId == "other-device") {
                        otherConfigs.incrementAndGet()
                        return TransportResponse(200, body = """{"config":{"api":{"publicUrl":"https://other.example"}}}""".toByteArray())
                    }
                    if (path == "/v0/config" && failRefresh.get()) {
                        failures.incrementAndGet()
                        throw com.slopus.happy.connection.AgentConnectionException(com.slopus.happy.connection.AgentConnectionException.Reason.Unavailable)
                    }
                    return agent.request(method, path, credential, body, headers)
                }
            }
        }
        val session = manager.session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        eventually({ otherConfigs.get() }) { it >= 2 }
        assertEquals("https://other.example", connections.credentials(other.id)!!.publicUrl)
        failRefresh.set(true)
        eventually({ failures.get() }) { it >= 3 }
        assertEquals(AgentLinkStatus.Connected, session.status.value)
        assertEquals(1, agent.calls.count { it == "STREAM /v0/events/stream" })
        failRefresh.set(false)
        val before = agent.calls.count { it == "GET /v0/config" }
        eventually({ agent.calls.count { it == "GET /v0/config" } }) { it > before }
    }

    @Test
    fun httpsRequestDeadlinesAllowSessionReconnectAndSettingsRetry() = runBlocking {
        val certificate = okhttp3.tls.HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val serverKeys = okhttp3.tls.HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientRoots = okhttp3.tls.HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        mockwebserver3.MockWebServer().apply {
            useHttps(serverKeys.sslSocketFactory())
            protocols = listOf(okhttp3.Protocol.HTTP_1_1)
            start()
        }.use { server ->
            val https = com.slopus.happy.connection.HttpsTransport(com.slopus.happy.connection.AgentOrigin.parse("https://localhost:${server.port}"), clientRoots.sslSocketFactory(), requestTimeoutMillis = 1_000)
            val health = java.util.concurrent.atomic.AtomicInteger()
            val settings = java.util.concurrent.atomic.AtomicInteger()
            val path = "/v0/user-settings/${DesktopSettings.PROJECTS_VISIBILITY}"
            server.enqueue(mockwebserver3.MockResponse.Builder().headersDelay(3, java.util.concurrent.TimeUnit.SECONDS).body("late").build())
            val session = AgentSession(id, connections, null, foreground, scope, { object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if ((path == "/v0/health" && health.incrementAndGet() == 1) ||
                        (method == "PUT" && path.startsWith("/v0/user-settings/") && settings.incrementAndGet() == 1)) {
                        return https.request(method, path, credential, body, headers)
                    }
                    return agent.request(method, path, credential, body, headers)
                }
            } })
            try {
                agent.frames.send(Wire.hello("c0"))
                eventually({ session.status.value }) { it == AgentLinkStatus.Offline }
                eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
                assertTrue(health.get() >= 2)
                agent.resources[path] = buildJsonObject { put("setting", Wire.projectsHidden(true, "v1")) }
                server.enqueue(mockwebserver3.MockResponse.Builder().headersDelay(3, java.util.concurrent.TimeUnit.SECONDS).body("late").build())
                session.setProjectsHidden(true)
                eventually({ settings.get() }) { it >= 2 }
                eventually({ session.catalog.value.pendingSettings }) { it.isEmpty() }
                // The collector remains alive for a later, distinct change.
                agent.resources[path] = buildJsonObject { put("setting", Wire.projectsHidden(false, "v2")) }
                session.setProjectsHidden(false)
                eventually({ settings.get() }) { it >= 3 }
                eventually({ session.catalog.value.pendingSettings }) { it.isEmpty() }
                assertEquals(AgentLinkStatus.Connected, session.status.value)
            } finally { session.close(); https.close() }
        }
    }

    @Test
    fun aComputerThatDoesNotAnswerStaysOfflineUntilItDoes() = runBlocking {
        val down = java.util.concurrent.atomic.AtomicBoolean(true)
        val asked = java.util.concurrent.atomic.AtomicInteger()
        val session = AgentSession(id, connections, null, foreground, scope, { object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (down.get()) {
                    asked.incrementAndGet()
                    throw java.io.IOException("no answer")
                }
                return agent.request(method, path, credential, body, headers)
            }
        } })
        val seen = java.util.Collections.synchronizedList(mutableListOf<AgentLinkStatus>())
        val watching = scope.launch { session.status.collect { seen += it } }
        try {
            // Asked again and again, it stays offline (iOS's Session.headerState): home's notice doesn't come and go.
            eventually({ asked.get() }) { it >= 3 }
            val since = seen.toList().dropWhile { it != AgentLinkStatus.Offline }
            assertEquals(listOf(AgentLinkStatus.Offline), since)
            down.set(false)
            agent.frames.send(Wire.hello("c0"))
            eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
            // An open stream that drops is on its way back first; offline only once asking again fails.
            seen.clear()
            down.set(true)
            val dropped = agent.frames
            agent.frames = Channel(Channel.UNLIMITED)
            dropped.close()
            eventually({ seen.toList() }) { it.lastOrNull() == AgentLinkStatus.Offline }
            assertEquals(listOf(AgentLinkStatus.Connecting, AgentLinkStatus.Offline), seen.toList())
        } finally {
            watching.cancel()
            session.close()
        }
    }

    @Test
    fun v2EndpointRemovalUsesNormalOfflineStateWithoutTailcat() = runBlocking {
        val credentials = AgentConnectionCredentials("https://agent.example", 443, "v2device", "token", "https://agent.example", false)
        val account = connections.add(credentials, "V2")
        val session = AgentSession(account.id, connections, null, foreground, scope, { value ->
            if (value.publicUrl == null) {
                com.slopus.happy.connection.agentTransport(value.address, value.port, null, value.tailcatAvailable != false).also {
                    assertFalse(it is com.slopus.happy.connection.TailcatTransport)
                }
            } else object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
                    if (path == "/v0/config") TransportResponse(200, body = """{"config":{"api":{"publicUrl":null}}}""".toByteArray())
                    else agent.request(method, path, credential, body, headers)
            }
        })
        eventually({ session.status.value }) { it == AgentLinkStatus.Offline }
        assertEquals(false, connections.credentials(account.id)?.tailcatAvailable)
        assertNull(connections.credentials(account.id)?.publicUrl)
        session.close()
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

    /** A session whose `POST /v0/surfaces/:id/leave` waits for [gate], then answers [status] with [error]. */
    private fun leavingSession(gate: CompletableDeferred<Unit>, status: Int, error: String? = null, bodies: MutableList<String> = mutableListOf()): AgentSession {
        agent.bootstrap = Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))),
            surfaces = listOf(Wire.surface("s1", "Groceries", "todo"), Wire.surface("s2", "Plan", "document", mapOf(Wire.USER to "2"))),
        )
        return sessions {
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if (!path.endsWith("/leave")) return agent.request(method, path, credential, body, headers)
                    agent.calls += "$method $path"
                    bodies += body?.decodeToString().orEmpty()
                    gate.await()
                    val text = if (status in 200..299) "{}" else "{\"error\":${error?.let { "\"$it\"" } ?: "null"},\"code\":\"refused\"}"
                    return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
                }
            }
        }.session(id)!!
    }

    private fun surfaces(session: AgentSession) = session.feed.value.rows.filterIsInstance<AgentFeedRow.Surface>().map { it.id }

    @Test
    fun leavingASurfaceTakesItsRowAtOnceAndAsksTheAgent(): Unit = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val bodies = mutableListOf<String>()
        val session = leavingSession(gate, 200, bodies = bodies)
        eventually({ surfaces(session) }) { it == listOf("s1", "s2") }

        val answer = async { session.leaveSurface("s1") }
        // Gone while the agent is still asked.
        eventually({ surfaces(session) }) { it == listOf("s2") }
        eventually({ agent.calls }) { "POST /v0/surfaces/s1/leave" in it }
        // A second press while the first is on its way sends nothing more and shares its answer.
        // Undispatched, so it is pressed before the gate opens and not after the first is answered.
        val again = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { session.leaveSurface("s1") }
        gate.complete(Unit)
        assertNull(answer.await())
        assertNull(again.await())
        assertEquals(1, agent.calls.count { it == "POST /v0/surfaces/s1/leave" })
        assertTrue("It names its mutation", bodies.single().contains("\"mutationId\":\""))
        // Out of the person's list too, so it stays gone once the leave is answered; still in the catalog.
        assertEquals(listOf("s2"), surfaces(session))
        val left = session.surfaces.value
        assertFalse(left.joined(left["s1"]!!))
    }

    @Test
    fun openingASurfaceNotJoinedJoinsItAtOnceAndTheAnswerPlacesIt(): Unit = runBlocking {
        agent.bootstrap = Wire.bootstrap(surfaces = listOf(Wire.surface("s1", "Groceries", "todo"), Wire.surface("s2", "Plan", "document", mapOf("u2" to "1"))))
        agent.resources["/v0/surfaces/s2/join"] = buildJsonObject {
            put("surface", Wire.surface("s2", "Plan", "document", mapOf("u2" to "1", Wire.USER to "5")).with("version", "02"))
        }
        val session = sessions().session(id)!!
        eventually({ session.surfaces.value.surfaces.size }) { it == 2 }
        eventually({ surfaces(session) }) { it == listOf("s1") }
        assertEquals(listOf("Groceries"), session.surfaces.value.of("todo").map { it.name })

        val answer = session.joinSurface("s2")
        assertNull(withTimeout(5_000) { answer.await() })
        assertEquals(1, agent.calls.count { it == "POST /v0/surfaces/s2/join" })
        // The computer's answer put it after Groceries ("5" > "1").
        eventually({ surfaces(session) }) { it == listOf("s1", "s2") }
        eventually({ session.surfaces.value["s2"]?.version }) { it == "02" }
        // A joined Surface is only opened.
        assertNull(session.joinSurface("s1").await())
        assertEquals(0, agent.calls.count { it == "POST /v0/surfaces/s1/join" })
    }

    @Test
    fun aJoinThatCannotGoYetSurvivesRelaunchAndRetriesTheSameMutation(): Unit = runBlocking {
        agent.bootstrap = Wire.bootstrap(surfaces = listOf(Wire.surface("s2", "Plan", "document", mapOf("u2" to "1"))))
        var accepting = false
        val mutations = java.util.concurrent.CopyOnWriteArrayList<String>()
        val transport = object : Transport by agent {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if (!path.endsWith("/join")) return agent.request(method, path, credential, body, headers, category)
                mutations += body!!.decodeToString()
                return if (!accepting) TransportResponse(503, body = "{}".toByteArray())
                else TransportResponse(200, body = buildJsonObject {
                    put("surface", Wire.surface("s2", "Plan", "document", mapOf("u2" to "1", Wire.USER to "5")).with("version", "02"))
                }.toString().toByteArray())
            }
        }
        val first = sessions(transport = { transport }).session(id)!!
        eventually({ first.surfaces.value.loaded }) { it }
        eventually({ File(cacheDir, "$id.json").exists() }) { it }
        assertNull(first.joinSurface("s2").await())
        eventually({ surfaces(first) }) { it == listOf("s2") }
        assertEquals(1, first.intents.pending.value.size)
        assertTrue(first.joinRefusals.value.isEmpty())
        first.close()
        foreground.value = false
        accepting = true
        val restored = sessions(transport = { transport }).session(id)!!
        eventually({ surfaces(restored) }) { it == listOf("s2") }
        assertEquals(1, mutations.size)
        agent.frames = Channel(Channel.UNLIMITED)
        agent.frames.send(Wire.hello("c0"))
        foreground.value = true
        eventually({ restored.intents.pending.value }) { it.isEmpty() }
        assertEquals(2, mutations.size)
        assertEquals(mutations[0], mutations[1])
        eventually({ restored.surfaces.value["s2"]?.version }) { it == "02" }
    }

    @Test
    fun aRefusedJoinTakesTheRowOutAgainAndKeepsTheReason(): Unit = runBlocking {
        agent.bootstrap = Wire.bootstrap(surfaces = listOf(Wire.surface("s1", "Groceries", "todo"), Wire.surface("s2", "Plan", "document", mapOf("u2" to "1"))))
        val gate = CompletableDeferred<Unit>()
        val session = sessions {
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if (!path.endsWith("/join")) return agent.request(method, path, credential, body, headers)
                    gate.await()
                    return TransportResponse(403, body = "{\"error\":\"Only members of the team may join.\",\"code\":\"forbidden\"}".toByteArray())
                }
            }
        }.session(id)!!
        eventually({ session.surfaces.value.surfaces.size }) { it == 2 }
        val answer = session.joinSurface("s2")
        // Shown in the list while the computer is asked.
        eventually({ surfaces(session) }) { it == listOf("s1", "s2") }
        gate.complete(Unit)
        assertEquals("Only members of the team may join.", withTimeout(5_000) { answer.await() })
        eventually({ surfaces(session) }) { it == listOf("s1") }
        assertEquals(mapOf("s2" to "Only members of the team may join."), session.joinRefusals.value)
        session.dismissJoinRefusal("s2")
        assertEquals(emptyMap<String, String>(), session.joinRefusals.value)
    }

    @Test
    fun aRefusedLeaveBringsTheRowBackWithTheAgentsWords(): Unit = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val session = leavingSession(gate, 409, "You own this Surface.")
        eventually({ surfaces(session) }) { it == listOf("s1", "s2") }
        val answer = async { session.leaveSurface("s1") }
        eventually({ surfaces(session) }) { it == listOf("s2") }
        gate.complete(Unit)
        assertEquals("You own this Surface.", answer.await())
        eventually({ surfaces(session) }) { it == listOf("s1", "s2") }
    }

    @Test
    fun aLeaveTheAgentCantTakeYetStaysAndGoneAlreadyCountsAsLeft(): Unit = runBlocking {
        val gate = CompletableDeferred<Unit>().apply { complete(Unit) }
        val failing = leavingSession(gate, 500)
        eventually({ surfaces(failing) }) { it == listOf("s1", "s2") }
        // Not a no: kept and tried again (iOS IntentOutbox), the row gone meanwhile.
        assertNull(failing.leaveSurface("s2"))
        eventually({ surfaces(failing) }) { it == listOf("s1") }
        assertEquals(listOf("s2"), failing.intents.pending.value.map { it.target })
        failing.close()
        agent.calls.clear()

        // Kept through the relaunch, it goes as the link is back; gone already (404) is left.
        agent.frames = Channel(Channel.UNLIMITED)
        val gone = leavingSession(gate, 404, "Not found.")
        agent.frames.send(Wire.hello("c0"))
        eventually({ agent.calls }) { "POST /v0/surfaces/s2/leave" in it }
        eventually({ gone.intents.pending.value }) { it.isEmpty() }
        eventually({ surfaces(gone) }) { it == listOf("s1") }
    }

    /**
     * iOS 36e59d9f6's intents: a chat read here has no dot at once, and the
     * read is kept through a relaunch until the computer has it.
     */
    @Test
    fun aReadIsKeptUntilTheComputerHasItAndItsDotGoesAtOnce(): Unit = runBlocking {
        agent.bootstrap = Wire.bootstrap(bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1", unread = true))))
        val reads = java.util.concurrent.atomic.AtomicInteger()
        val answering = java.util.concurrent.atomic.AtomicBoolean(false)
        val transport = { _: AgentConnectionCredentials ->
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if (path != "/v0/agents/ab1/read") return agent.request(method, path, credential, body, headers)
                    reads.incrementAndGet()
                    return if (answering.get()) TransportResponse(200, body = "{}".toByteArray()) else TransportResponse(503, body = "{\"code\":\"busy\"}".toByteArray())
                }
            }
        }
        val first = sessions(transport = transport).session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ first.feed.value.conversations.firstOrNull { it.agentId == "ab1" }?.unread }) { it == true }
        first.markRead("ab1")
        eventually({ first.feed.value.conversations.first { it.agentId == "ab1" }.unread }) { !it }
        eventually({ reads.get() }) { it >= 1 }
        first.close()

        // A relaunch: the computer still says unread, the kept read still clears it, and goes once it can.
        answering.set(true)
        agent.frames = Channel(Channel.UNLIMITED)
        val second = sessions(transport = transport).session(id)!!
        eventually({ second.intents.pending.value.map { it.kind } }) { it == listOf(Intent.READ) }
        assertEquals(false, second.feed.value.conversations.firstOrNull { it.agentId == "ab1" }?.unread ?: false)
        agent.frames.send(Wire.hello("c0"))
        eventually({ second.intents.pending.value }) { it.isEmpty() }
        assertTrue(reads.get() >= 2)
    }

    @Test
    fun aTakenLeaveAndRenameShowAtOnceAndTheLeftTaskStaysGone(): Unit = runBlocking {
        agent.bootstrap = Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))),
            tasks = listOf(Wire.task("t1", "Fix login", Wire.agent("at1")), Wire.task("t2", "Ship", Wire.agent("at2"))),
            memberships = listOf(Wire.membership("t1", "1"), Wire.membership("t2", "2")),
        )
        val bodies = java.util.concurrent.CopyOnWriteArrayList<String>()
        val transport = { _: AgentConnectionCredentials ->
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if (method == "GET" && path == "/v0/bots/b1") return TransportResponse(200, body = "{\"bot\":{\"id\":\"b1\",\"version\":\"v3\"}}".toByteArray())
                    if (method == "GET" || path == "/v0/health" || path == "/v0/config") return agent.request(method, path, credential, body, headers)
                    agent.calls += "$method $path ${headers["If-Match"].orEmpty()}".trim()
                    bodies += body?.decodeToString().orEmpty()
                    return TransportResponse(200, body = "{}".toByteArray())
                }
            }
        }
        val session = sessions(transport = transport).session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.feed.value.conversations.map { it.agentId } }) { "at1" in it && "at2" in it }
        val leave = session.leave("task", "t1")
        val rename = session.rename("bot", "b1", "Chief")
        eventually({ agent.calls }) { "POST /v0/tasks/t1/leave" in it && "PATCH /v0/bots/b1 v3" in it }
        eventually({ session.intents.pending.value }) { it.isEmpty() }
        assertTrue(bodies.any { "\"mutationId\":\"${leave.id}\"" in it })
        assertTrue(bodies.any { "\"name\":\"Chief\"" in it && "\"mutationId\":\"${rename.id}\"" in it })
        // Taken, the left task stays gone before the computer's event says so.
        eventually({ session.feed.value.conversations.map { it.agentId } }) { "at1" !in it && "at2" in it }
        assertEquals("Chief", session.feed.value.title("ab1"))
    }

    @Test
    fun aRefusedArchiveBringsTheTaskBackAndHomeSaysWhy(): Unit = runBlocking {
        val transport = { _: AgentConnectionCredentials ->
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    agent.calls += "$method $path"
                    return when {
                        method == "GET" && path == "/v0/tasks/t1" -> TransportResponse(200, body = "{\"task\":{\"id\":\"t1\",\"version\":\"v7\"}}".toByteArray())
                        path == "/v0/tasks/t1/archive" -> TransportResponse(403, body = "{\"error\":\"Only the owner can archive this task.\",\"code\":\"forbidden\"}".toByteArray())
                        else -> agent.request(method, path, credential, body, headers)
                    }
                }
            }
        }
        val session = sessions(transport = transport).session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.feed.value.conversations.map { it.agentId } }) { "at1" in it }
        session.archive("task", "t1")
        // Gone at once, back when the computer says no, with its words on home's notice.
        eventually({ session.feed.value.conversations.map { it.agentId } }) { "at1" !in it || session.notice.value != null }
        eventually({ session.notice.value }) { it == "Only the owner can archive this task." }
        eventually({ session.feed.value.conversations.map { it.agentId } }) { "at1" in it }
        assertTrue("POST /v0/tasks/t1/archive" in agent.calls)
    }

    @Test
    fun hidingProjectsOnTheDesktopHidesThemHereLiveAndAChangeHereIsSent(): Unit = runBlocking {
        agent.bootstrap = Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))),
            projects = listOf(Wire.project("p1", "rig", listOf(Wire.agent("ap1")))),
            userSettings = emptyList(),
        )
        val session = sessions().session(id)!!
        agent.frames.send(Wire.hello("c0"))
        eventually({ session.status.value }) { it == AgentLinkStatus.Connected }
        eventually({ session.feed.value.conversations.map { it.agentId } }) { it == listOf("ab1", "ap1") }
        assertFalse(session.projectsHidden.value)

        // The desktop hides them: home drops the projects as the event comes.
        agent.frames.send(Wire.frame("c1", "user_settings.updated", buildJsonObject { put("setting", Wire.projectsHidden(true, "v1")) }))
        eventually({ session.projectsHidden.value }) { it }
        eventually({ session.feed.value.conversations.map { it.agentId } }) { it == listOf("ab1") }

        // Shown again from this phone: at once here, then PUT to the agent with its mutation id and time.
        val path = "/v0/user-settings/${DesktopSettings.PROJECTS_VISIBILITY}"
        agent.resources[path] = buildJsonObject { put("setting", Wire.projectsHidden(false, "v2")) }
        session.setProjectsHidden(false)
        eventually({ session.feed.value.conversations.map { it.agentId } }) { it == listOf("ab1", "ap1") }
        eventually({ agent.calls }) { "PUT $path" in it }
        eventually({ session.catalog.value.pendingSettings }) { it.isEmpty() }
        assertFalse(session.projectsHidden.value)
        assertEquals("v2", session.catalog.value.settings.getValue(DesktopSettings.PROJECTS_VISIBILITY)["version"].toString().trim('"'))
    }
}
