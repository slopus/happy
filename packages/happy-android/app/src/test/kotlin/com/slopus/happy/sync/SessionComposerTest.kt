package com.slopus.happy.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.net.HappyJson
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/**
 * The composer mirror and its writes: ports of rigComposer.test.ts,
 * ops.rig.test.ts's picker case, and ops.ts sessionSetAgentModes. Time is
 * virtual; the socket is a script of `update-metadata` answers.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class SessionComposerTest {
    private val server = FakeHappyServer()
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private val scheduler = TestCoroutineScheduler()
    private val dispatcher = StandardTestDispatcher(scheduler)
    private var parent = Job()
    private var baseTime = 10_000L
    private var connected = false

    private data class Write(val sid: String, val expectedVersion: Long, val metadata: JsonObject) {
        val draft get() = metadata["draft"]
        val draftUpdatedAt get() = (metadata["draftUpdatedAt"] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.long
    }

    private val writes = mutableListOf<Write>()

    /** Scripted answers, in order; when none is left the write succeeds. */
    private val answers = ArrayDeque<suspend (Write) -> JsonElement>()

    private lateinit var composer: SessionComposer

    private val lastMode = buildJsonObject {
        put("providerId", "codex"); put("modelId", "shared-model"); put("effort", "high")
        put("serviceTier", "fast"); put("permissionMode", "auto")
    }

    @Before
    fun setUp() {
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        composer = newComposer()
    }

    @After
    fun tearDown() {
        parent.cancel()
        database.close()
    }

    private fun newComposer(): SessionComposer {
        parent.cancel()
        parent = Job()
        return SessionComposer(
            store = store,
            decoder = RecordDecoder(server.encryption),
            emitWithAck = { _, payload -> emit(payload.jsonObject) },
            isConnected = { connected },
            parent = parent,
            dispatcher = dispatcher,
            clock = { baseTime + scheduler.currentTime },
        ).also { it.start() }
    }

    private suspend fun emit(payload: JsonObject): JsonElement {
        val sid = payload["sid"]!!.jsonPrimitive.content
        val metadata = server.encryption.dataKeyCipher(server.dataKey(sid))
            .decryptFromBase64(payload["metadata"]!!.jsonPrimitive.content)!!.jsonObject
        val write = Write(sid, payload["expectedVersion"]!!.jsonPrimitive.long, metadata)
        writes += write
        val answer = answers.removeFirstOrNull() ?: return success(write.expectedVersion + 1)
        return answer(write)
    }

    private fun success(version: Long) = buildJsonObject { put("result", "success"); put("version", version) }

    private fun mismatch(version: Long, sid: String, metadata: JsonObject): suspend (Write) -> JsonElement = {
        buildJsonObject {
            put("result", "version-mismatch")
            put("version", version)
            put("metadata", server.seal(sid, metadata))
        }
    }

    private val rejected: suspend (Write) -> JsonElement = { buildJsonObject { put("result", "error") } }
    private val offline: suspend (Write) -> JsonElement = { throw IOException("offline") }

    private fun metadata(vararg extra: Pair<String, JsonElement>): JsonObject {
        val base = HappyJson.parseToJsonElement(RIG_METADATA_FIXTURE).jsonObject
        return JsonObject(base + mapOf("draft" to JsonNull, "draftUpdatedAt" to JsonNull, "lastMode" to lastMode) + extra)
    }

    private fun draft(text: String, vararg overrides: Pair<String, String?>) =
        JsonObject(lastMode + overrides.associate { (k, v) -> k to JsonPrimitive(v) } + ("text" to JsonPrimitive(text)))

    private fun stamp(value: Long) = "draftUpdatedAt" to JsonPrimitive(value)

    /** storage.ts applySessions: the session as the server now has it. */
    private fun apply(id: String, metadata: JsonObject, version: Long = 1) {
        store.upsertSessions(listOf(SessionRecord(
            id = id, seq = 1, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            metadataJson = metadata.toString(), metadataVersion = version, agentStateJson = null, agentStateVersion = 0,
            wrappedDataKey = encodeBase64(server.encryption.encryptDataEncryptionKey(server.dataKey(id))), projectId = null,
        )))
        scheduler.runCurrent()
    }

    private fun mirror(id: String) = composer.mirrors.value[id] ?: ComposerMirror()

    private fun advance(ms: Long) {
        scheduler.advanceTimeBy(ms)
        scheduler.runCurrent()
    }

    private fun settle() = scheduler.runCurrent()

    private fun test(body: suspend TestScope.() -> Unit) = runTest(dispatcher) {
        try {
            body()
        } finally {
            parent.cancel()
        }
    }

    @Test
    fun theFixtureParses() {
        assertNotNull(SessionMetadata.parse(metadata("draft" to draft("x"), stamp(1))))
    }

    // rigComposer.test.ts

    @Test
    fun opensFromTheDraftKeepsTypingLocalUntilAPauseAndStampsAtTheEdit() = test {
        apply("s", metadata("draft" to draft("hi", "permissionMode" to "read_only"), stamp(20_000)))
        assertEquals(ComposerMirror(
            draft = "hi", draftUpdatedAt = 20_000, permissionMode = "read_only", modelMode = "codex:shared-model",
            effortLevel = "high", serviceTier = "fast", hasServiceTier = true,
        ), mirror("s"))

        composer.setText("s", "hi t")
        // Later than anything seen, even when this device's clock lags the remote stamp.
        assertEquals("hi t", mirror("s").draft)
        assertEquals(20_001L, mirror("s").draftUpdatedAt)
        advance(100)
        composer.setText("s", "hi there")
        assertEquals(20_002L, mirror("s").draftUpdatedAt)
        advance(SessionComposer.DRAFT_DEBOUNCE_MS - 1)
        assertTrue(writes.isEmpty())
        advance(1)

        val write = writes.single()
        assertEquals("s", write.sid)
        assertEquals(1L, write.expectedVersion)
        assertEquals(draft("hi there", "permissionMode" to "read_only"), write.draft)
        assertEquals(20_002L, write.draftUpdatedAt)
        assertEquals(lastMode, write.metadata["lastMode"])
    }

    @Test
    fun aPickerChangeIsWrittenAtOnceWithTheWholeDraft() = test {
        // Never edited, last ran on Codex at an effort the Claude model does not offer.
        apply("s", metadata("lastMode" to JsonObject(lastMode + ("effort" to JsonPrimitive("medium")))))
        assertEquals("auto", mirror("s").permissionMode)
        assertEquals("codex:shared-model", mirror("s").modelMode)
        assertEquals("medium", mirror("s").effortLevel)
        assertNull(mirror("s").draft)

        composer.setAgentModes("s", mapOf(AgentModeField.MODEL_MODE to "claude:shared-model", AgentModeField.EFFORT_LEVEL to null))
        val picked = mirror("s")
        assertEquals("", picked.draft)
        assertEquals("claude:shared-model", picked.modelMode)
        assertEquals("max", picked.effortLevel)
        assertTrue(picked.hasServiceTier)
        assertNull(picked.serviceTier)
        assertEquals(10_000L, picked.draftUpdatedAt)
        settle()
        assertEquals(buildJsonObject {
            put("text", ""); put("providerId", "claude"); put("modelId", "shared-model"); put("effort", "max")
            put("serviceTier", JsonNull); put("permissionMode", "auto")
        }, writes[0].draft)
        assertEquals(10_000L, writes[0].draftUpdatedAt)
        // lastMode is the daemon's; it is never written.
        assertEquals("medium", writes[0].metadata["lastMode"]!!.jsonObject["effort"]!!.jsonPrimitive.content)

        // An empty-text edit also goes out at once and keeps the pickers.
        baseTime = 10_500
        composer.setText("s", "x")
        composer.setText("s", "")
        settle()
        assertEquals(2, writes.size)
        assertEquals("", writes[1].draft!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("claude", writes[1].draft!!.jsonObject["providerId"]!!.jsonPrimitive.content)
        assertEquals(10_501L, writes[1].draftUpdatedAt)
    }

    /** ops.rig.test.ts: a Happy Agent picker change goes through the synced draft, never as a loose metadata field. */
    @Test
    fun aHappyAgentPickIsNeverALooseMetadataField() = test {
        apply("s", metadata())
        composer.setAgentModes("s", mapOf(AgentModeField.PERMISSION_MODE to "read_only"))
        settle()
        val write = writes.single()
        assertEquals("read_only", write.draft!!.jsonObject["permissionMode"]!!.jsonPrimitive.content)
        assertEquals(JsonPrimitive("auto"), write.metadata["permissionMode"])
    }

    @Test
    fun aConflictMergesOntoTheNewestMetadataAndANewerRemoteDraftIsAdopted() = test {
        apply("s", metadata())
        composer.setAgentModes("s", mapOf(AgentModeField.PERMISSION_MODE to "read_only"))
        val stamp = mirror("s").draftUpdatedAt!!

        // Somebody renamed the session first: keep their metadata, re-apply our draft.
        val renamed = JsonObject(metadata(stamp(9_000), "draft" to draft("old")) + ("name" to JsonPrimitive("Renamed")))
        answers += mismatch(5, "s", renamed)
        answers += { success(6) }
        settle()
        assertEquals(2, writes.size)
        assertEquals(5L, writes[1].expectedVersion)
        assertEquals(JsonPrimitive("Renamed"), writes[1].metadata["name"])
        assertEquals(stamp, writes[1].draftUpdatedAt)
        assertEquals("read_only", writes[1].draft!!.jsonObject["permissionMode"]!!.jsonPrimitive.content)
        assertEquals("", writes[1].draft!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("read_only", mirror("s").permissionMode)
        assertEquals("", mirror("s").draft)

        // The desktop typed after us: their draft wins and our stale text is not resent.
        writes.clear()
        baseTime = 30_000 - scheduler.currentTime
        composer.setText("s", "phone text")
        val newer = metadata(stamp(30_500), "draft" to draft("desktop text", "permissionMode" to "full_access"))
        answers += mismatch(7, "s", newer)
        advance(SessionComposer.DRAFT_DEBOUNCE_MS)
        assertEquals(1, writes.size)
        assertEquals("desktop text", mirror("s").draft)
        assertEquals("full_access", mirror("s").permissionMode)
        assertEquals(30_500L, mirror("s").draftUpdatedAt)
        assertEquals(7L, store.session("s")!!.metadataVersion)
    }

    @Test
    fun neitherAnEchoNorAnOlderUpdateResetsTextBeingTyped() = test {
        apply("s", metadata(stamp(100), "draft" to draft("a")))
        composer.setText("s", "ab")
        composer.setText("s", "abc")
        val local = mirror("s").draftUpdatedAt!!

        // An unrelated metadata change still carrying the old stamp.
        apply("s", JsonObject(metadata(stamp(100), "draft" to draft("a")) + ("name" to JsonPrimitive("busy"))), 3)
        assertEquals("abc", mirror("s").draft)
        assertEquals(local, mirror("s").draftUpdatedAt)
        // Echo of our own earlier write.
        apply("s", metadata(stamp(local - 1), "draft" to draft("ab")), 4)
        assertEquals("abc", mirror("s").draft)
        // Echo of the latest write changes nothing; a genuinely newer draft is adopted.
        apply("s", metadata(stamp(local), "draft" to draft("abc")), 5)
        assertEquals("abc", mirror("s").draft)
        apply("s", metadata(stamp(local + 1), "draft" to draft("remote")), 6)
        assertEquals("remote", mirror("s").draft)
        assertEquals(local + 1, mirror("s").draftUpdatedAt)
    }

    @Test
    fun aSendClearsWithAFreshStampAndKeepsTheModeUntilLastModeConfirmsIt() = test {
        apply("s", metadata(stamp(100), "draft" to draft("a", "permissionMode" to "read_only")))
        composer.setText("s", "about to send")
        assertEquals(10_000L, mirror("s").draftUpdatedAt)
        composer.clearDraft("s")
        assertNull(mirror("s").draft)
        assertEquals(10_001L, mirror("s").draftUpdatedAt)
        assertEquals("read_only", mirror("s").permissionMode)
        advance(SessionComposer.DRAFT_DEBOUNCE_MS * 2)
        assertEquals(1, writes.size)
        assertEquals(JsonNull, writes[0].draft)
        assertEquals(10_001L, writes[0].draftUpdatedAt)
        assertEquals(lastMode, writes[0].metadata["lastMode"])

        // Echo of the clear with the daemon's previous lastMode: the captured mode stays.
        apply("s", metadata(stamp(10_001)), 3)
        assertEquals("read_only", mirror("s").permissionMode)
        // Nothing left to clear: no second write.
        composer.clearDraft("s")
        settle()
        assertEquals(1, writes.size)
        // The daemon ran the message: lastMode moves on and the pickers follow it.
        apply("s", metadata(stamp(10_001), "lastMode" to JsonObject(lastMode + ("permissionMode" to JsonPrimitive("read_only")))), 4)
        assertEquals("read_only", mirror("s").permissionMode)
        apply("s", metadata(stamp(10_001), "lastMode" to JsonObject(lastMode + ("permissionMode" to JsonPrimitive("full_access")))), 5)
        assertEquals("full_access", mirror("s").permissionMode)
    }

    @Test
    fun opensWithTheLatestLastModeAfterAClearedDraftIncludingAfterARestart() = test {
        apply("s", metadata(stamp(100)))
        val latest = metadata(stamp(100), "lastMode" to JsonObject(
            lastMode + mapOf("providerId" to JsonPrimitive("claude"), "effort" to JsonPrimitive("max"), "serviceTier" to JsonNull),
        ))
        apply("s", latest, 2)
        assertEquals("claude:shared-model", mirror("s").modelMode)
        composer = newComposer()
        settle()
        assertEquals("claude:shared-model", mirror("s").modelMode)
    }

    @Test
    fun aRestartRestoresEachSessionAndSendsOnlyTheDraftStillAhead() = test {
        apply("keep", metadata(stamp(5), "draft" to draft("server keep")))
        apply("drop", metadata(stamp(5), "draft" to draft("server drop")))
        repeat(6) { answers += offline }
        composer.setText("keep", "offline keep")
        composer.setText("drop", "offline drop")
        advance(SessionComposer.DRAFT_DEBOUNCE_MS)
        val keepStamp = mirror("keep").draftUpdatedAt!!
        val remoteStamp = mirror("drop").draftUpdatedAt!! + 10
        answers.clear()
        writes.clear()

        // Meanwhile the desktop wrote "drop"; the server has not moved on "keep".
        composer = newComposer()
        apply("drop", metadata(stamp(remoteStamp), "draft" to draft("from desktop", "permissionMode" to "full_access")), 2)
        settle()
        assertEquals("from desktop", mirror("drop").draft)
        assertEquals("full_access", mirror("drop").permissionMode)
        assertEquals("offline keep", mirror("keep").draft)
        assertEquals(keepStamp, mirror("keep").draftUpdatedAt)
        val sent = writes.single()
        assertEquals("keep", sent.sid)
        assertEquals("offline keep", sent.draft!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals(keepStamp, sent.draftUpdatedAt)
    }

    @Test
    fun aWriteRetriesAfterExhaustingConflictsWithoutAnotherEdit() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        for (version in 2L..4L) answers += mismatch(version, "s", metadata(stamp(100), "draft" to draft("old")))
        composer.setText("s", "latest phone text")
        val stamp = mirror("s").draftUpdatedAt
        advance(SessionComposer.DRAFT_DEBOUNCE_MS)
        assertEquals(3, writes.size)
        advance(1_000)
        assertEquals(4, writes.size)
        assertEquals(4L, writes[3].expectedVersion)
        assertEquals("latest phone text", writes[3].draft!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals(stamp, writes[3].draftUpdatedAt)
        advance(60_000)
        assertEquals(4, writes.size)
    }

    @Test
    fun aRejectedClearRetriesWithItsStampAndCappedBackoff() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        answers += rejected
        repeat(7) { answers += offline }
        composer.clearDraft("s")
        val stamp = mirror("s").draftUpdatedAt
        settle()
        var count = 1
        for (delay in listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000)) {
            advance(delay - 1)
            assertEquals(count, writes.size)
            advance(1)
            assertEquals(++count, writes.size)
            assertEquals(JsonNull, writes.last().draft)
            assertEquals(stamp, writes.last().draftUpdatedAt)
        }
        advance(30_000)
        assertEquals(count + 1, writes.size)
        advance(120_000)
        assertEquals(count + 1, writes.size)
        // The stored mirror survives a restart with the stamp it was written with.
        val stored = store.composers()["s"]!!
        assertTrue(stored.contains("\"draftUpdatedAt\":$stamp"))
    }

    @Test
    fun aNewerEditGoesOutPromptlyInsteadOfWaitingForTheRetry() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        answers += rejected
        composer.clearDraft("s")
        settle()
        composer.setText("s", "new edit")
        advance(SessionComposer.DRAFT_DEBOUNCE_MS)
        assertEquals(2, writes.size)
        assertEquals("new edit", writes[1].draft!!.jsonObject["text"]!!.jsonPrimitive.content)
        advance(60_000)
        assertEquals(2, writes.size)
    }

    @Test
    fun retriesStaySerializedWithEditsMadeWhileOneIsInFlight() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        val finishRetry = CompletableDeferred<JsonElement>()
        answers += rejected
        answers += { finishRetry.await() }
        composer.clearDraft("s")
        settle()
        advance(1_000)
        assertEquals(2, writes.size)
        composer.setText("s", "edited during retry")
        advance(SessionComposer.DRAFT_DEBOUNCE_MS)
        assertEquals(2, writes.size)
        finishRetry.complete(buildJsonObject { put("result", "error") })
        settle()
        assertEquals(3, writes.size)
        assertEquals("edited during retry", writes[2].draft!!.jsonObject["text"]!!.jsonPrimitive.content)
        advance(60_000)
        assertEquals(3, writes.size)
    }

    @Test
    fun aWriteWhoseSuccessArrivedAsAnEchoIsNotRetried() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        answers += offline
        composer.clearDraft("s")
        settle()
        apply("s", metadata(stamp(mirror("s").draftUpdatedAt!!)), 2)
        advance(60_000)
        assertEquals(1, writes.size)
    }

    @Test
    fun aPendingRetryStopsWhenARemoteDraftWins() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        answers += rejected
        composer.clearDraft("s")
        settle()
        apply("s", metadata(stamp(20_000), "draft" to draft("remote winner")), 3)
        advance(60_000)
        assertEquals(1, writes.size)
    }

    @Test
    fun aPendingRetryStopsWhenTheSessionIsRemoved() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        answers += rejected
        composer.clearDraft("s")
        settle()
        store.deleteSessions(listOf("s"))
        settle()
        advance(60_000)
        assertEquals(1, writes.size)
        assertTrue(composer.mirrors.value.isEmpty())
    }

    @Test
    fun aPendingRetryWaitsForTheReconnectWhenDisconnected() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old")))
        connected = true
        answers += rejected
        composer.clearDraft("s")
        settle()
        connected = false
        advance(60_000)
        assertEquals(1, writes.size)
        connected = true
        composer.flushAhead()
        settle()
        assertEquals(2, writes.size)
        assertEquals(JsonNull, writes[1].draft)
    }

    @Test
    fun aRemoteClearIsAdoptedWithoutAWrite() = test {
        apply("s", metadata(stamp(100), "draft" to draft("old text")))
        apply("s", metadata(stamp(200)), 2)
        advance(500)
        assertNull(mirror("s").draft)
        assertEquals(200L, mirror("s").draftUpdatedAt)
        assertTrue(writes.isEmpty())
    }

    @Test
    fun theServerWinnerIsAdoptedWhenAnotherEditHasTheSameStamp() = test {
        apply("s", metadata(stamp(100), "draft" to draft("base")))
        composer.setText("s", "phone edit")
        val stamp = mirror("s").draftUpdatedAt!!
        advance(500)
        apply("s", metadata(stamp(stamp), "draft" to draft("phone edit")), 2)
        apply("s", metadata(stamp(stamp), "draft" to draft("desktop edit")), 3)
        assertEquals("desktop edit", mirror("s").draft)
        // A delayed metadata packet cannot rewind that winner.
        apply("s", metadata(stamp(stamp), "draft" to draft("phone edit")), 2)
        assertEquals("desktop edit", mirror("s").draft)
    }

    @Test
    fun anEqualStampedConflictIsAdoptedInsteadOfRetried() = test {
        apply("s", metadata(stamp(100), "draft" to draft("base")))
        composer.setText("s", "phone edit")
        val stamp = mirror("s").draftUpdatedAt!!
        answers += mismatch(2, "s", metadata(stamp(stamp), "draft" to draft("desktop edit")))
        advance(500)
        assertEquals("desktop edit", mirror("s").draft)
        assertEquals(1, writes.size)
    }

    // ops.ts sessionSetAgentModes on a Happy CLI session.

    private val cliMetadata = buildJsonObject { put("path", "/repo"); put("host", "mac"); put("flavor", "claude") }

    @Test
    fun aPickIsAppliedAtOnceAndPushedIntoSessionMetadata() = test {
        apply("c", JsonObject(cliMetadata + ("future" to JsonPrimitive("kept"))))
        composer.setAgentModes("c", mapOf(AgentModeField.MODEL_MODE to "opus", AgentModeField.EFFORT_LEVEL to null))
        // effortLevel null equals both the mirror and the metadata: nothing to push for it.
        assertEquals("opus", mirror("c").modelMode)
        settle()
        val write = writes.single()
        assertEquals(JsonObject(cliMetadata + ("future" to JsonPrimitive("kept")) + ("modelMode" to JsonPrimitive("opus"))), write.metadata)
        assertEquals(2L, store.session("c")!!.metadataVersion)
        assertEquals("opus", mirror("c").modelMode)

        // A pick that changes nothing costs no round trip.
        composer.setAgentModes("c", mapOf(AgentModeField.MODEL_MODE to "opus"))
        settle()
        assertEquals(1, writes.size)
    }

    @Test
    fun aLocalOnlyValueIsStillPushedWhenThePickIsExplicit() = test {
        apply("c", JsonObject(cliMetadata + ("permissionMode" to JsonPrimitive("default"))))
        composer.setLocalModes("c", mapOf(AgentModeField.PERMISSION_MODE to "plan"))
        settle()
        assertTrue(writes.isEmpty())
        assertEquals("plan", mirror("c").permissionMode)
        composer.setAgentModes("c", mapOf(AgentModeField.PERMISSION_MODE to "plan"))
        settle()
        assertEquals(JsonPrimitive("plan"), writes.single().metadata["permissionMode"])
    }

    @Test
    fun inboundMetadataWinsUnlessAPushForTheFieldIsInFlight() = test {
        apply("c", cliMetadata)
        val held = CompletableDeferred<JsonElement>()
        answers += { held.await() }
        composer.setAgentModes("c", mapOf(AgentModeField.PERMISSION_MODE to "acceptEdits"))
        settle()
        // Another device's update still carries the old pick while ours is in flight.
        apply("c", JsonObject(cliMetadata + mapOf("permissionMode" to JsonNull, "modelMode" to JsonPrimitive("sonnet"))), 2)
        assertEquals("acceptEdits", mirror("c").permissionMode)
        assertEquals("sonnet", mirror("c").modelMode)
        held.complete(buildJsonObject { put("result", "error") })
        settle()
        // Once settled, newer metadata decides; metadata without a field keeps the local value.
        apply("c", JsonObject(cliMetadata + ("permissionMode" to JsonPrimitive("plan"))), 3)
        assertEquals("plan", mirror("c").permissionMode)
        assertEquals("sonnet", mirror("c").modelMode)
    }

    @Test
    fun aConflictKeepsTheServersMetadataAndDropsAFieldChangedSince() = test {
        apply("c", cliMetadata)
        val latest = JsonObject(cliMetadata + ("name" to JsonPrimitive("Renamed")))
        answers += { write ->
            // A newer local pick lands while this push is on the wire.
            composer.setLocalModes("c", mapOf(AgentModeField.EFFORT_LEVEL to "low"))
            mismatch(4, "c", latest)(write)
        }
        composer.setAgentModes("c", mapOf(AgentModeField.MODEL_MODE to "opus", AgentModeField.EFFORT_LEVEL to "high"))
        settle()
        assertEquals(2, writes.size)
        assertEquals(4L, writes[1].expectedVersion)
        assertEquals(JsonObject(latest + ("modelMode" to JsonPrimitive("opus"))), writes[1].metadata)
    }

    @Test
    fun aHappyCliDraftStaysOnTheDeviceAndSurvivesARestart() = test {
        apply("c", cliMetadata)
        composer.setText("c", "unsent thought")
        settle()
        assertTrue(writes.isEmpty())
        composer = newComposer()
        settle()
        assertEquals("unsent thought", mirror("c").draft)
        composer.clearDraft("c")
        assertNull(mirror("c").draft)
    }

    @Test
    fun composeRigDraftFallsBackToTheSessionsSelection() {
        val metadata = SessionMetadata.parse(metadata())
        // A tier the model does not offer is dropped; an effort it does not offer falls back to the session's.
        val draft = SessionComposer.composeRigDraft(
            metadata,
            ComposerMirror(draft = "t", effortLevel = "ultra", serviceTier = "slow", hasServiceTier = true),
        )
        assertEquals(buildJsonObject {
            put("text", "t"); put("providerId", "codex"); put("modelId", "shared-model"); put("effort", "high")
            put("serviceTier", JsonNull); put("permissionMode", "auto")
        }, draft)
    }

    companion object {
        /** happy-app's `rigMetadataFixture` (sources/sync/__testdata__/rigMetadata.ts). */
        val RIG_METADATA_FIXTURE = """
            {
              "rigMetadataVersion": 1,
              "client": {"id": "rig", "name": "Rig", "version": "0.0.30"},
              "provider": {"id": "codex", "kind": "codex", "name": "OpenAI Codex"},
              "providers": [
                {"id": "codex", "kind": "codex", "name": "OpenAI Codex"},
                {"id": "claude", "kind": "claude", "name": "Anthropic Claude"}
              ],
              "model": {"providerId": "codex", "id": "shared-model"},
              "models": [
                {"providerId": "codex", "providerKind": "codex", "providerName": "OpenAI Codex",
                 "provider": {"id": "codex", "kind": "codex", "name": "OpenAI Codex"},
                 "id": "shared-model", "code": "shared-model", "name": "GPT Shared", "value": "GPT Shared",
                 "contextWindow": 200000, "serviceTiers": ["fast"], "thinkingLevels": ["low", "medium", "high"],
                 "defaultThinkingLevel": "high"},
                {"providerId": "claude", "providerKind": "claude", "providerName": "Anthropic Claude",
                 "provider": {"id": "claude", "kind": "claude", "name": "Anthropic Claude"},
                 "id": "shared-model", "code": "shared-model", "name": "Claude Shared", "value": "Claude Shared",
                 "contextWindow": 180000, "serviceTiers": [], "thinkingLevels": ["low", "high", "max"],
                 "defaultThinkingLevel": "max"}
              ],
              "currentModelProviderId": "codex",
              "currentModelCode": "shared-model",
              "permissionMode": "auto",
              "currentOperatingModeCode": "auto",
              "operatingModes": [
                {"code": "auto", "value": "Auto", "description": "Uses the workspace sandbox.", "kind": "safe-yolo"},
                {"code": "workspace_write", "value": "Workspace write", "description": "Workspace changes.", "kind": "default"},
                {"code": "read_only", "value": "Read only", "description": "Inspection only.", "kind": "read-only"},
                {"code": "full_access", "value": "Full access", "description": "No restrictions.", "kind": "yolo"}
              ],
              "reasoning": {"current": "high", "levels": ["low", "medium", "high"]},
              "currentThoughtLevelCode": "high",
              "thoughtLevels": [{"code": "low", "value": "low"}, {"code": "medium", "value": "medium"}, {"code": "high", "value": "high"}],
              "session": {"status": "running", "permissionMode": "auto", "modelLocked": false, "serviceTier": "fast"},
              "capabilities": {
                "abort": true,
                "attachments": {"enabled": true, "maxBytes": 10485760, "mediaTypes": ["image/*"]},
                "files": {"browse": true, "read": true, "search": true, "write": true},
                "modelSelection": true, "reasoningSelection": true, "permissionModeSelection": true, "resume": false,
                "rpcMethods": ["abort", "bash", "readFile", "writeFile", "ripgrep"],
                "shell": true, "steering": true
              },
              "name": "Rig session",
              "summary": {"text": "Rig integration", "updatedAt": 1},
              "path": "/tmp/rig-project",
              "host": "rig-host",
              "os": "darwin",
              "flavor": "codex",
              "startedBy": "daemon",
              "startedFromDaemon": true
            }
        """.trimIndent()
    }
}
