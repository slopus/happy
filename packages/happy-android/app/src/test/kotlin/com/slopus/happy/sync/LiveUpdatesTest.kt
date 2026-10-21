package com.slopus.happy.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Waits for [condition], failing after [timeoutMs]. */
fun eventually(timeoutMs: Long = 5_000, message: String = "condition", condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        check(System.currentTimeMillis() < deadline) { "timed out waiting for $message" }
        Thread.sleep(10)
    }
}

/** A signed-in [AccountSync] against a [FakeHappyServer], with an in-memory store. */
class AccountHarness(val server: FakeHappyServer = FakeHappyServer().start(), var now: Long = 1_000_000L) {
    val database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
    val store = HappyStore(database)
    val foreground = MutableStateFlow(true)
    private val parent = Job()
    val account = AccountSync(
        http = HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test"),
        okHttp = OkHttpClient(),
        serverUrl = { server.url },
        clientId = "android/test",
        token = server.token,
        encryption = server.encryption,
        store = store,
        parent = parent,
        foreground = foreground,
        clock = { now },
        reconnectDelayMs = { 50 },
    )

    fun startAndSync(): AccountHarness {
        account.start()
        eventually(message = "socket connected") { account.connectionStatus.value == ConnectionStatus.CONNECTED }
        runBlocking { account.syncNow() }
        return this
    }

    fun close() {
        runBlocking { account.stop() }
        parent.cancel()
        database.close()
        server.close()
    }
}

@RunWith(AndroidJUnit4::class)
class LiveUpdatesTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val store get() = h.store

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("s1", updatedAt = 100)
        server.addMachine("m1")
    }

    @After
    fun tearDown() = h.close()

    private fun text(n: Int) = buildJsonObject {
        put("role", "user")
        put("content", buildJsonObject { put("type", "text"); put("text", "m$n") })
    }

    @Test
    fun theHandshakeIsUserScopedWithTheAppState() {
        h.startAndSync()
        val auth = server.socketAuths.single()
        assertEquals(server.token, auth["token"]!!.jsonPrimitive.content)
        assertEquals("user-scoped", auth["clientType"]!!.jsonPrimitive.content)
        assertEquals("android/test", auth["happyClient"]!!.jsonPrimitive.content)
        assertEquals("active", auth["appState"]!!.jsonPrimitive.content)

        // Every connect repeats it (sync.ts onReconnected fires for the first connect too).
        assertEquals("active", server.awaitEvent("app-state")!!.jsonObject["state"]!!.jsonPrimitive.content)
        h.foreground.value = false
        assertEquals("background", server.awaitEvent("app-state")!!.jsonObject["state"]!!.jsonPrimitive.content)
    }

    @Test
    fun aNewMessageWithTheNextSeqIsAppendedWithoutAFetch() {
        server.appendMessage("s1", text(1))
        h.startAndSync()
        eventually { store.messages("s1").size == 1 }
        server.requests.clear()

        val message = server.appendMessage("s1", text(2))
        server.emitUpdate(server.newMessageBody("s1", message))

        eventually { store.messages("s1").map { it.seq } == listOf(1L, 2L) }
        assertEquals("""{"role":"user","content":{"type":"text","text":"m2"}}""", store.messages("s1").last().contentJson)
        assertEquals(2L, store.session("s1")!!.seq)
        assertTrue("no fetch for a contiguous message", server.requests.none { it.url.encodedPath.endsWith("/messages") })
    }

    @Test
    fun aGapInSeqsIsFilledFromTheServer() {
        server.appendMessage("s1", text(1))
        h.startAndSync()
        eventually { store.messages("s1").size == 1 }

        server.appendMessage("s1", text(2)) // missed while the socket was busy
        val third = server.appendMessage("s1", text(3))
        server.emitUpdate(server.newMessageBody("s1", third))

        eventually { store.messages("s1").map { it.seq } == listOf(1L, 2L, 3L) }
        assertEquals("1", server.requestsTo("/v3/sessions/s1/messages").last().url.queryParameter("after_seq"))
    }

    @Test
    fun aReplayedMessageChangesNothing() {
        val first = server.appendMessage("s1", text(1))
        h.startAndSync()
        eventually { store.messages("s1").size == 1 }
        val before = store.versions.value

        server.emitUpdate(server.newMessageBody("s1", first))
        server.emitEphemeral(buildJsonObject { put("type", "noop-marker") })
        Thread.sleep(200)

        assertEquals("a replay wakes no observer", before, store.versions.value)
    }

    @Test
    fun turnLifecycleMessagesDriveThinking() {
        h.startAndSync()
        server.emitEphemeral(buildJsonObject { put("type", "activity"); put("id", "s1"); put("active", true); put("activeAt", 200); put("thinking", false) })
        eventually { h.account.presence.sessions.value["s1"]?.active == true }

        val start = server.appendMessage("s1", buildJsonObject {
            put("role", "session")
            put("content", buildJsonObject { put("type", "session"); put("data", buildJsonObject { put("ev", buildJsonObject { put("t", "turn-start") }) }) })
        })
        server.emitUpdate(server.newMessageBody("s1", start))
        eventually { h.account.presence.sessions.value["s1"]?.thinking == true }

        val end = server.appendMessage("s1", buildJsonObject {
            put("role", "agent")
            put("content", buildJsonObject { put("type", "acp"); put("data", buildJsonObject { put("type", "task_complete") }) })
        })
        server.emitUpdate(server.newMessageBody("s1", end))
        eventually { h.account.presence.sessions.value["s1"]?.thinking == false }
    }

    @Test
    fun aNewSessionIsStoredFromTheUpdateItself() {
        h.startAndSync()
        server.addSession("s2", updatedAt = 500)
        val record = server.sessions.first { it.id == "s2" }
        server.requests.clear()
        server.emitUpdate(HappyJson.encodeToJsonElement(ApiSession.serializer(), record).jsonObject.let {
            JsonObject(it + ("t" to kotlinx.serialization.json.JsonPrimitive("new-session")))
        })

        eventually { store.session("s2") != null }
        assertEquals("""{"path":"/repo/s2"}""", store.session("s2")!!.metadataJson)
        assertTrue(server.requestsTo("/v2/sessions").isEmpty())
    }

    @Test
    fun updateSessionAppliesNewerMetadataAndStateWithTheirVersions() {
        h.startAndSync()
        server.emitUpdate(buildJsonObject {
            put("t", "update-session")
            put("id", "s1")
            put("metadata", buildJsonObject { put("version", 2); put("value", server.seal("s1", buildJsonObject { put("path", "/new") })) })
            put("agentState", buildJsonObject { put("version", 5); put("value", server.seal("s1", buildJsonObject { put("controlledByUser", true) })) })
            put("projectId", "p1")
        })
        eventually { store.session("s1")!!.metadataVersion == 2L }
        val session = store.session("s1")!!
        assertEquals("""{"path":"/new"}""", session.metadataJson)
        assertEquals("""{"controlledByUser":true}""", session.agentStateJson)
        assertEquals(5L, session.agentStateVersion)
        assertEquals("p1", session.projectId)

        // An older version arriving late does not win.
        server.emitUpdate(buildJsonObject {
            put("t", "update-session")
            put("id", "s1")
            put("metadata", buildJsonObject { put("version", 1); put("value", server.seal("s1", buildJsonObject { put("path", "/old") })) })
        })
        // projectId absent means unchanged; an explicit null clears it.
        server.emitUpdate(buildJsonObject { put("t", "update-session"); put("id", "s1"); put("projectId", kotlinx.serialization.json.JsonNull) })
        eventually { store.session("s1")!!.projectId == null }
        assertEquals("""{"path":"/new"}""", store.session("s1")!!.metadataJson)
    }

    @Test
    fun anAvatarUpdateNewerByRevisionWinsAndAStaleOneDoesNot() {
        h.startAndSync()
        fun avatar(ref: String, version: Int) = buildJsonObject { put("ref", ref); put("preview", "sealed"); put("version", version) }
        server.emitUpdate(buildJsonObject { put("t", "update-session"); put("id", "s1"); put("avatar", avatar("r3", 3)); put("avatarVersion", 3) })
        eventually { store.session("s1")!!.avatarRevision == 3L }
        assertTrue(store.session("s1")!!.avatarJson!!.contains("r3"))
        // Delivered out of order: revision 2 after 3.
        server.emitUpdate(buildJsonObject { put("t", "update-session"); put("id", "s1"); put("avatar", avatar("r2", 2)); put("avatarVersion", 2) })
        // A malformed descriptor is a removal, ordered by the descriptor-less revision.
        server.emitUpdate(buildJsonObject { put("t", "update-session"); put("id", "s1"); put("avatar", kotlinx.serialization.json.JsonNull); put("avatarVersion", 4) })
        eventually { store.session("s1")!!.avatarRevision == 4L }
        assertEquals(null, store.session("s1")!!.avatarJson)
    }

    @Test
    fun projectEventsReachTheCatalog() {
        h.startAndSync()
        val seen = java.util.concurrent.atomic.AtomicInteger()
        // UNDISPATCHED: subscribed before launch returns, so the event can't beat the collector.
        val job = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
            h.account.live.projectChanges.collect { seen.incrementAndGet() }
        }
        try {
            server.emitUpdate(buildJsonObject { put("t", "update-project"); put("id", "p1") })
            eventually { seen.get() >= 1 }
        } finally {
            job.cancel()
        }
    }

    @Test
    fun messagesAndAgentStateReachTheGitStatusRefresh() {
        server.appendMessage("s1", text(1))
        h.startAndSync()
        eventually { store.messages("s1").size == 1 }
        val data = java.util.concurrent.CopyOnWriteArrayList<String>()
        val state = java.util.concurrent.CopyOnWriteArrayList<String>()
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO)
        val jobs = listOf(
            scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { h.account.live.sessionDataUpdates.collect { data.add(it) } },
            scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { h.account.live.agentStateUpdates.collect { state.add(it) } },
        )
        try {
            server.emitUpdate(server.newMessageBody("s1", server.appendMessage("s1", text(2))))
            eventually { data == listOf("s1") }
            server.emitUpdate(buildJsonObject {
                put("t", "update-session")
                put("id", "s1")
                put("agentState", buildJsonObject { put("version", 5); put("value", server.seal("s1", buildJsonObject { put("requests", buildJsonObject {}) })) })
            })
            eventually { state == listOf("s1") }
            assertEquals("no handoff, so no second refresh", listOf("s1"), data.toList())
        } finally {
            jobs.forEach { it.cancel() }
        }
    }

    @Test
    fun deleteSessionRemovesItsRowsAndPresence() {
        server.appendMessage("s1", text(1))
        h.startAndSync()
        eventually { store.messages("s1").isNotEmpty() && h.account.presence.sessions.value.containsKey("s1") }

        server.emitUpdate(buildJsonObject { put("t", "delete-session"); put("sid", "s1") })
        eventually { store.session("s1") == null }
        assertTrue(store.messages("s1").isEmpty())
        eventually { "s1" !in h.account.presence.sessions.value }
    }

    @Test
    fun machinesAreCreatedUpdatedAndDeletedLive() {
        h.startAndSync()
        server.addMachine("m2")
        val m2 = server.machines.first { it.id == "m2" }
        server.emitUpdate(buildJsonObject {
            put("t", "new-machine")
            put("machineId", "m2")
            put("seq", 1)
            put("metadata", m2.metadata)
            put("metadataVersion", 1)
            put("daemonStateVersion", 0)
            put("dataEncryptionKey", m2.dataEncryptionKey)
            put("active", true)
            put("activeAt", 10)
            put("createdAt", 1)
            put("updatedAt", 1)
        })
        eventually { store.machine("m2") != null }

        server.emitUpdate(buildJsonObject {
            put("t", "update-machine")
            put("machineId", "m2")
            put("daemonState", buildJsonObject { put("version", 1); put("value", server.seal("m2", buildJsonObject { put("status", "running") })) })
        })
        eventually { store.machine("m2")!!.daemonStateJson == """{"status":"running"}""" }

        server.emitUpdate(buildJsonObject { put("t", "delete-machine"); put("machineId", "m2") })
        eventually { store.machine("m2") == null }
    }

    @Test
    fun updateAccountMergesProfileAndSettings() {
        h.startAndSync()
        server.emitUpdate(buildJsonObject {
            put("t", "update-account")
            put("id", "account-1")
            put("firstName", "Ada")
            put("settings", buildJsonObject {
                put("version", 7)
                put("value", server.encryption.settingsCipher().encryptToBase64(buildJsonObject { put("viewInline", true) }))
            })
        })
        eventually { store.settings()?.version == 7L }
        assertEquals("Ada", store.profile()!!["firstName"]!!.jsonPrimitive.content)
        assertEquals("account-1", store.profile()!!["id"]!!.jsonPrimitive.content)
        assertEquals(buildJsonObject { put("viewInline", true) }, store.settings()!!.value)
    }

    @Test
    fun heartbeatsStayInMemoryAndOnlyFlipsAreShown() {
        h.startAndSync()
        // Appended on the collector's thread while this one reads it.
        val shown = java.util.concurrent.CopyOnWriteArrayList<Map<String, SessionPresence>>()
        val collector = Thread {
            // Interrupted at the end; that is how it stops, not a failure to print.
            try {
                runBlocking { kotlinx.coroutines.withTimeoutOrNull(3_000) { h.account.presence.sessions.collect { shown += it } } }
            } catch (_: InterruptedException) {
            }
        }.apply { start() }
        eventually { shown.isNotEmpty() }
        val before = store.versions.value

        server.emitEphemeral(buildJsonObject { put("type", "activity"); put("id", "s1"); put("active", true); put("activeAt", 1_000); put("thinking", true) })
        for (i in 1..30) {
            server.emitEphemeral(buildJsonObject { put("type", "activity"); put("id", "s1"); put("active", true); put("activeAt", 1_000 + i * 2_000); put("thinking", true) })
        }
        server.emitEphemeral(buildJsonObject { put("type", "machine-activity"); put("id", "m1"); put("active", false); put("activeAt", 9_000) })
        eventually { h.account.presence.machines.value["m1"]?.active == false }
        Thread.sleep(200)

        assertEquals("presence never touches SQLite", before, store.versions.value)
        val s1 = shown.mapNotNull { it["s1"] }.distinct()
        assertEquals("one flip, no heartbeat values: $s1", 1, s1.count { it.thinking })
        collector.interrupt()
    }

    @Test
    fun aReconnectRunsTheDeltaSync() {
        h.startAndSync()
        server.addSession("s2", updatedAt = 900)
        server.dropSockets()
        eventually(message = "s2 synced after reconnect") { store.session("s2") != null }
        assertEquals(2, server.socketAuths.size)
    }

    @Test
    fun anUpdateForAnUnknownSessionAsksForTheListing() {
        h.startAndSync()
        server.addSession("s9", updatedAt = 900)
        val message = server.appendMessage("s9", text(1))
        server.emitUpdate(server.newMessageBody("s9", message))
        eventually { store.session("s9") != null }
        eventually { store.messages("s9").size == 1 }
    }

    @Test
    fun aMalformedUpdateIsIgnored() {
        h.startAndSync()
        server.emit("update", buildJsonObject { put("nonsense", true) })
        server.emitUpdate(buildJsonObject { put("t", "update-session") })
        server.emitUpdate(buildJsonObject { put("t", "kv-batch-update"); put("changes", kotlinx.serialization.json.JsonArray(emptyList())) })
        server.emitEphemeral(buildJsonObject { put("type", "activity"); put("id", "s1") })
        val later = server.appendMessage("s1", text(1))
        server.emitUpdate(server.newMessageBody("s1", later))
        eventually { store.messages("s1").size == 1 }
        assertNull(store.session("nonsense"))
    }
}
