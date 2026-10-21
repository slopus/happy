package com.slopus.happy.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Settings
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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

@RunWith(AndroidJUnit4::class)
class SyncEngineTest {
    private lateinit var server: FakeHappyServer
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private var now = 1_000_000L

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
    }

    @After
    fun tearDown() {
        database.close()
        server.close()
    }

    private fun engine(): SyncEngine {
        val http = HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test")
        return SyncEngine(SyncApi(http, server.token), store, server.encryption, clock = { now }, io = Dispatchers.Unconfined)
    }

    @Test
    fun firstSyncStoresEverythingTheDeviceCanRead() = runTest {
        server.addSession("s1", updatedAt = 100)
        server.addSession("s2", updatedAt = 200)
        server.addSession("legacy", updatedAt = 300, legacy = true)
        server.addMessage("s1", seq = 1, content = buildJsonObject { put("role", "user") }, updatedAt = 110)
        server.addMessage("s1", seq = 2, content = buildJsonObject { put("role", "agent") }, updatedAt = 120)
        server.addMachine("m1")
        server.setSettings(buildJsonObject { put("analyticsOptOut", true) }, version = 3)

        assertEquals(emptyList<Exception>(), engine().syncAll())

        assertEquals(listOf("s1", "s2"), store.sessions().map { it.id }.sorted())
        assertEquals("""{"path":"/repo/s1"}""", store.session("s1")!!.metadataJson)
        assertEquals(listOf("""{"role":"user"}""", """{"role":"agent"}"""), store.messages("s1").map { it.contentJson })
        assertEquals(2L, store.messagesSeq("s1"))
        assertEquals(listOf("m1"), store.machines().map { it.id })
        assertEquals("""{"host":"m1"}""", store.machines().single().metadataJson)
        assertEquals(JsonPrimitive(true), store.settings()!!.value["analyticsOptOut"])
        assertEquals(3L, store.settings()!!.version)
        assertEquals("account-1", store.profile()!!["id"]!!.jsonPrimitive.content)
        // The watermark is the newest updatedAt listed, legacy sessions included.
        assertEquals(300L, store.cursor(SyncEngine.CURSOR_SESSIONS_CHANGED))
    }

    @Test
    fun laterSyncsFetchOnlyWhatChanged() = runTest {
        server.addSession("s1", updatedAt = 100)
        server.addMessage("s1", seq = 1, content = buildJsonObject { put("n", 1) }, updatedAt = 110)
        engine().syncAll()
        server.requests.clear()

        server.addMessage("s1", seq = 2, content = buildJsonObject { put("n", 2) }, updatedAt = 150)
        server.addSession("s3", updatedAt = 160)
        now += 60_000
        engine().syncAll()

        val listing = server.requestsTo("/v2/sessions").single()
        assertEquals("one millisecond before the watermark", "109", listing.url.queryParameter("changedSince"))
        val messages = server.requestsTo("/v3/sessions/s1/messages").single()
        assertEquals("1", messages.url.queryParameter("after_seq"))
        assertEquals(listOf(1L, 2L), store.messages("s1").map { it.seq })
        assertEquals(setOf("s1", "s3"), store.sessionIds())
        // s3 has no messages: nothing to fetch for it.
        assertTrue(server.requestsTo("/v3/sessions/s3/messages").isEmpty())
    }

    @Test
    fun sessionPagesAreFollowedByCursor() = runTest {
        repeat(SyncEngine.SESSION_PAGE_SIZE + 5) { server.addSession("s%04d".format(it), updatedAt = 100L + it) }
        engine().syncAll()
        assertEquals(SyncEngine.SESSION_PAGE_SIZE + 5, store.sessionIds().size)
        val cursors = server.requestsTo("/v2/sessions").map { it.url.queryParameter("cursor") }
        assertEquals(listOf(null, "cursor_v1_s0005"), cursors)
    }

    @Test
    fun aDailyFullListingDropsSessionsDeletedElsewhere() = runTest {
        server.addSession("keep", updatedAt = 100)
        server.addSession("gone", updatedAt = 100)
        engine().syncAll()
        server.sessions.removeAll { it.id == "gone" }

        now += 60_000
        engine().syncAll()
        assertEquals("a delta cannot see deletions", setOf("keep", "gone"), store.sessionIds())

        now += SyncEngine.FULL_LISTING_INTERVAL_MS
        engine().syncAll()
        assertNull(server.requestsTo("/v2/sessions").last().url.queryParameter("changedSince"))
        assertEquals(setOf("keep"), store.sessionIds())
    }

    @Test
    fun messagesOfASessionDeletedOnTheServerRemoveIt() = runTest {
        server.addSession("s1", updatedAt = 100)
        server.addMessage("s1", seq = 1, content = buildJsonObject { put("n", 1) }, updatedAt = 110)
        engine().syncSessions()
        server.sessions.clear()
        engine().syncMessages()
        assertEquals(emptySet<String>(), store.sessionIds())
    }

    @Test
    fun pendingSettingsAreUploadedAndCleared() = runTest {
        server.setSettings(buildJsonObject { put("viewInline", true) }, version = 1)
        engine().syncSettings()
        store.changeSettings(JsonObject(mapOf("analyticsOptOut" to JsonPrimitive(true))))

        engine().syncSettings()

        // Uploaded as happy-app does: every known key, defaults for the unset ones.
        assertEquals(JsonPrimitive(true), server.settingsJson()!!["viewInline"])
        assertEquals(JsonPrimitive(true), server.settingsJson()!!["analyticsOptOut"])
        assertEquals(Settings.Defaults.toJson().keys - "agentDefaultOverrides" + "viewInline", server.settingsJson()!!.keys)
        assertEquals(2L, server.settingsVersion)
        assertEquals(JsonObject(emptyMap()), store.pendingSettings())
        assertEquals(2L, store.settings()!!.version)
        assertEquals(server.settingsJson(), store.settings()!!.value)
    }

    @Test
    fun aSettingsConflictMergesTheServerCopyAndRetries() = runTest {
        server.setSettings(buildJsonObject { put("a", 1) }, version = 1)
        engine().syncSettings()
        store.changeSettings(JsonObject(mapOf("analyticsOptOut" to JsonPrimitive(true))))
        // Another device writes first.
        server.settingsRaces += buildJsonObject { put("a", 2); put("b", 3) }

        engine().syncSettings()

        val posts = server.requestsTo("/v1/account/settings").filter { it.method == "POST" }
        assertEquals(2, posts.size)
        val uploaded = server.settingsJson()!!
        assertEquals(JsonPrimitive(2), uploaded["a"])
        assertEquals(JsonPrimitive(3), uploaded["b"])
        assertEquals(JsonPrimitive(true), uploaded["analyticsOptOut"])
        assertEquals(JsonObject(emptyMap()), store.pendingSettings())
        assertEquals(server.settingsJson(), store.effectiveSettings())
    }

    @Test
    fun theUploadIsSettingsToSyncPayloadOfTheMergedSettings() = runTest {
        server.setSettings(buildJsonObject {
            put("agentDefaultOverrides", buildJsonObject {
                put("claude", buildJsonObject { put("permissionMode", "plan") })
                put("codex", buildJsonObject { })
            })
        }, version = 1)
        engine().syncSettings()
        store.changeSettings(buildJsonObject { put("analyticsOptOut", true) })

        engine().syncSettings()

        val uploaded = server.settingsJson()!!
        assertEquals(
            "empty agent overrides are dropped",
            buildJsonObject { put("claude", buildJsonObject { put("permissionMode", "plan") }) },
            uploaded["agentDefaultOverrides"],
        )
        assertEquals(Settings.syncPayload(Settings.apply(buildJsonObject { }, buildJsonObject { put("analyticsOptOut", true) })).keys, uploaded.keys - "agentDefaultOverrides")

        // With no overrides left at all, the key goes.
        store.changeSettings(buildJsonObject { put("agentDefaultOverrides", buildJsonObject { put("codex", buildJsonObject { }) }) })
        engine().syncSettings()
        assertNull(server.settingsJson()!!["agentDefaultOverrides"])
    }

    @Test
    fun aFailingStreamDoesNotStopTheOthers() = runTest {
        server.addSession("s1", updatedAt = 100)
        server.failProfile = true

        val failures = engine().syncAll()

        assertEquals(1, failures.size)
        assertEquals(setOf("s1"), store.sessionIds())
        assertNull(store.profile())
    }
}
