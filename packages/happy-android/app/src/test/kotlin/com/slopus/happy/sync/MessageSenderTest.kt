package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.crypto.DataKeyCipher
import com.slopus.happy.crypto.RandomSource
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The user record against happy-app's own `sendMessage` output
 * (tools/testvectors/send.mjs): the plaintext JSON and the sealed bytes.
 */
class MessageSenderVectorsTest {
    private val vectors: JsonObject by lazy {
        val text = requireNotNull(javaClass.getResource("/happy-ts-send-vectors.json")) { "missing send vectors" }.readText()
        Json.parseToJsonElement(text).jsonObject
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content

    /** A field the vector names, null included, versus one it leaves out. */
    private fun JsonObject.present(key: String): Present<String>? = if (containsKey(key)) Present(str(key)) else null

    private fun hex(value: String) = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun theSystemPromptIsHappyAppsAfterTrimIdent() {
        assertEquals(vectors.str("systemPrompt"), MessageSender.SYSTEM_PROMPT)
    }

    @Test
    fun theUserRecordAndItsCiphertextMatchHappyAppByteForByte() {
        val cases = vectors["cases"]!!.jsonArray.map { it.jsonObject }
        assertEquals(5, cases.size)
        for (case in cases) {
            val options = case["options"] as? JsonObject
            val mode = case["modeMeta"]!!.jsonObject
            val delivery = case["deliveryMeta"]!!.jsonObject
            val sendOptions = SendOptions(
                displayText = options?.str("displayText"),
                modeMeta = MessageModeMeta(
                    permissionMode = mode.str("permissionMode"),
                    model = mode.present("model"),
                    modelProviderId = mode.str("modelProviderId"),
                    effort = mode.present("effort"),
                    serviceTier = mode.present("serviceTier"),
                ),
                deliveryMeta = MessageDeliveryMeta(
                    expectsAcceptance = delivery["expectsAcceptance"]?.jsonPrimitive?.boolean,
                    queuedWhileBusy = delivery["queuedWhileBusy"]?.jsonPrimitive?.boolean,
                ),
            )
            val record = MessageSender.userRecord(case.str("text")!!, MessageSender.SENT_FROM, sendOptions)
            val name = case.str("name")
            assertEquals(name, case.str("recordJson"), Json.encodeToString(JsonElement.serializer(), record))

            var iv: ByteArray? = hex(case.str("ivHex")!!)
            val random = RandomSource { size ->
                val bytes = checkNotNull(iv) { "unscripted random request" }
                check(bytes.size == size) { "scripted ${bytes.size} bytes, $size requested" }
                iv = null
                bytes
            }
            assertEquals(name, case.str("contentBase64"), DataKeyCipher(hex(case.str("keyHex")!!), random).encryptToBase64(record))
        }
    }
}

/** Sending and the outbox against the fake server: sync.send.test.ts and the transport half of sync.receipts.spec.ts. */
@RunWith(AndroidJUnit4::class)
class MessageSenderTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val store get() = h.store
    private val sender get() = h.account.sender

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("s1", updatedAt = 100, metadata = buildJsonObject { put("path", "/repo"); put("host", "mac"); put("flavor", "claude") })
    }

    @After
    fun tearDown() = h.close()

    private fun outbox(sessionId: String = "s1") = store.outbox(sessionId)

    @Test
    fun aMessageIsSentAsTheUserRecordAndRetiredByItsEcho() = runBlocking {
        h.startAndSync()
        val accepted = mutableListOf<String>()
        val result = sender.send("s1", "hello", SendOptions(
            displayText = "Hi",
            modeMeta = MessageModeMeta(permissionMode = "acceptEdits", model = Present(null)),
            awaitDelivery = true,
            onAccepted = { accepted += "yes" },
        ))
        val localId = (result as SendResult.Accepted).localId
        assertEquals(listOf("yes"), accepted)
        val (sentLocalId, record) = server.sentRecords("s1").single()
        assertEquals(localId, sentLocalId)
        assertEquals(MessageSender.userRecord("hello", "android", SendOptions(
            displayText = "Hi",
            modeMeta = MessageModeMeta(permissionMode = "acceptEdits", model = Present(null)),
        )), record)
        assertEquals(JsonPrimitive("android"), record["meta"]!!.jsonObject["sentFrom"])
        assertTrue(store.session("s1")!!.lastMessageSentAt != null)
        // The echo is stored once the chat's history catches up, and the row goes with it.
        eventually(message = "outbox emptied by the echo") { outbox().isEmpty() }
        assertEquals(localId, store.messages("s1").single().localId)
    }

    @Test
    fun aFailedPostIsRetriedWithBackoffAndSentOnce() = runBlocking {
        server.failSends += 500
        server.failSends += 503
        h.startAndSync()
        val result = sender.send("s1", "persist", SendOptions(awaitDelivery = true))
        assertTrue(result is SendResult.Accepted)
        assertEquals(3, server.requestsTo("/v3/sessions/s1/messages").count { it.method == "POST" })
        assertEquals(1, server.sentRecords("s1").size)
        eventually(message = "row retired") { outbox().isEmpty() }
    }

    @Test
    fun aRefusalTheServerWillRepeatFailsUntilTheUserRetries() = runBlocking {
        server.failSends += 400
        h.startAndSync()
        sender.send("s1", "refused", SendOptions(awaitDelivery = true))
        val failed = outbox().single()
        assertEquals(OutboxState.FAILED, failed.state)
        assertEquals("Server error: 400", failed.error)
        assertEquals(1, failed.attempts)

        sender.retry("s1", failed.localId)
        eventually(message = "sent after retry") { server.sentRecords("s1").size == 1 }
        eventually(message = "row retired") { outbox().isEmpty() }
    }

    @Test
    fun aFailedMessageCanBeDiscarded() = runBlocking {
        server.failSends += 422
        h.startAndSync()
        sender.send("s1", "drop me", SendOptions(awaitDelivery = true))
        val failed = outbox().single()
        sender.discard("s1", failed.localId)
        assertTrue(outbox().isEmpty())
    }

    @Test
    fun theOutboxSurvivesARestartAndAnInterruptedSendGoesOutOnce() {
        // A previous process accepted two messages and died mid-POST on one of them.
        store.upsertSessions(listOf(com.slopus.happy.data.SessionRecord(
            id = "s1", seq = 0, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            metadataJson = """{"path":"/repo","host":"mac"}""", metadataVersion = 1, agentStateJson = null, agentStateVersion = 0,
            wrappedDataKey = "unused", projectId = null,
        )))
        val cipher = server.encryption.dataKeyCipher(server.dataKey("s1"))
        fun row(localId: String, state: OutboxState) = OutboxRecord(
            localId = localId, sessionId = "s1", kind = OutboxKind.USER, recordJson = "{}",
            content = cipher.encryptToBase64(MessageSender.userRecord(localId, "android", SendOptions())),
            createdAt = 1, state = state, attempts = 0, error = null, serverId = null, serverSeq = null,
        )
        store.enqueueOutbox(listOf(row("interrupted", OutboxState.SENDING), row("queued", OutboxState.QUEUED)))

        h.startAndSync()
        eventually(message = "both sent") { server.sentRecords("s1").size == 2 }
        assertEquals(listOf("interrupted", "queued"), server.sentRecords("s1").map { it.first })
        eventually(message = "both retired") { outbox().isEmpty() }
    }

    /** The POST reached the server but its answer was lost with the process: the message is stored once. */
    @Test
    fun aSendWhoseAnswerWasLostIsNotStoredTwice() {
        store.upsertSessions(listOf(com.slopus.happy.data.SessionRecord(
            id = "s1", seq = 0, createdAt = 1, updatedAt = 1, active = true, activeAt = 1,
            metadataJson = """{"path":"/repo","host":"mac"}""", metadataVersion = 1, agentStateJson = null, agentStateVersion = 0,
            wrappedDataKey = "unused", projectId = null,
        )))
        val record = MessageSender.userRecord("once", "android", SendOptions())
        server.appendMessage("s1", record, localId = "dup")
        store.enqueueOutbox(listOf(OutboxRecord(
            localId = "dup", sessionId = "s1", kind = OutboxKind.USER, recordJson = record.toString(),
            content = server.encryption.dataKeyCipher(server.dataKey("s1")).encryptToBase64(record),
            createdAt = 1, state = OutboxState.SENDING, attempts = 1, error = null, serverId = null, serverSeq = null,
        )))
        h.startAndSync()
        eventually(message = "retired") { outbox().isEmpty() }
        assertEquals(listOf("dup"), server.sentRecords("s1").map { it.first })
        assertEquals(listOf("dup"), store.messages("s1").map { it.localId })
    }

    /** sync.receipts.spec.ts: an acknowledgement proves only that ours was stored; the cursor moves by reading. */
    @Test
    fun thePostAnswerAsksForACatchUpInsteadOfMovingTheCursor() = runBlocking {
        server.addMessage("s1", 10, buildJsonObject { put("role", "user"); put("content", buildJsonObject { put("type", "text"); put("text", "old") }) }, updatedAt = 150)
        h.startAndSync()
        h.account.messages.invalidateAndAwait("s1")
        assertEquals(10L, store.messageHistory("s1")!!.newestSeq)
        server.echoSentMessages = false
        // An agent receipt lands before ours, unseen by this device.
        server.addMessage("s1", 11, buildJsonObject { put("role", "agent"); put("content", buildJsonObject { put("type", "text"); put("text", "receipt") }) }, updatedAt = 160)
        val requestsBefore = server.requests.size

        sender.send("s1", "mine", SendOptions(awaitDelivery = true))
        val row = outbox().singleOrNull()
        if (row != null) {
            assertEquals(OutboxState.SENT, row.state)
            assertEquals(12L, row.serverSeq)
        }
        eventually(message = "caught up") { store.messageHistory("s1")!!.newestSeq == 12L }
        val catchUp = server.requests.drop(requestsBefore).first { it.method == "GET" && it.url.encodedPath == "/v3/sessions/s1/messages" }
        assertEquals("10", catchUp.url.queryParameter("after_seq"))
        assertEquals(listOf(10L, 11L, 12L), store.messages("s1").map { it.seq })
        eventually(message = "row retired") { outbox().isEmpty() }
    }

    /** sync.send.test.ts: a real failure is kept rather than sent under another key. */
    @Test
    fun aSessionThatHasNotSyncedIsNotSentTo() = runBlocking {
        h.startAndSync()
        val result = sender.send("missing", "do not lose me")
        assertEquals(SendResult.NotSent(MessageSender.NOT_SYNCED), result)
        assertTrue(server.requestsTo("/v3/sessions/missing/messages").isEmpty())
        assertTrue(store.outbox().isEmpty())
    }

    /** sync.send.test.ts: a cold new session is pulled in with its own key before its first send. */
    @Test
    fun aNewSessionIsPulledInBeforeItsFirstSend() = runBlocking {
        h.startAndSync()
        server.addSession("fresh", updatedAt = 500, metadata = buildJsonObject { put("path", "/new"); put("host", "mac") })
        val result = sender.send("fresh", "cold start", SendOptions(awaitDelivery = true))
        assertTrue(result is SendResult.Accepted)
        assertEquals(1, server.sentRecords("fresh").size)
    }

    /** sync.send.test.ts: no message is accepted if the user moved on or the session went while it was being built. */
    @Test
    fun nothingIsAcceptedWhenTheSendIsNoLongerCurrent() = runBlocking {
        h.startAndSync()
        val accepted = mutableListOf<String>()
        var checks = 0
        val moved = sender.send("s1", "original target", SendOptions(isCurrent = { ++checks < 3 }, onAccepted = { accepted += "x" }))
        assertEquals(SendResult.NotSent(null), moved)

        checks = 0
        val deleted = sender.send("s1", "gone", SendOptions(isCurrent = {
            if (++checks == 3) store.deleteSessions(listOf("s1"))
            true
        }, onAccepted = { accepted += "x" }))
        assertEquals(SendResult.NotSent(null), deleted)
        assertTrue(accepted.isEmpty())
        assertTrue(store.outbox().isEmpty())
        assertTrue(server.sentRecords("s1").isEmpty())
    }

    /** sync.ts background watchdog: still unsent 30 s into the background, a message fails so the user can retry it. */
    @Test
    fun aMessageStillUnsentThirtySecondsIntoTheBackgroundFails() = runBlocking {
        h.startAndSync()
        repeat(50) { server.failSends += 503 }
        h.foreground.value = false
        eventually(message = "background seen") { server.socketEvents.any { it.first == "app-state" && it.second.toString().contains("background") } }
        sender.send("s1", "late")
        h.now += MessageSender.BACKGROUND_SEND_TIMEOUT_MS
        h.foreground.value = true
        eventually(message = "failed") { outbox().singleOrNull()?.state == OutboxState.FAILED }
        assertEquals(MessageSender.BACKGROUND_FAILURE, outbox().single().error)
    }

    /** sync.send.test.ts: the synced Happy Agent draft is spent once its text is accepted. */
    @Test
    fun sendingSpendsTheHappyAgentDraftUnlessItMovedOn() = runBlocking {
        server.addSession("rig", updatedAt = 100, metadata = rigMetadataJson())
        h.startAndSync()
        val composer = h.account.composer
        composer.setText("rig", "ship it")
        assertTrue(sender.send("rig", "ship it", SendOptions(awaitDelivery = true)) is SendResult.Accepted)
        eventually(message = "draft spent") { composer.mirrors.value["rig"]?.draft == null }

        // Kept editing past what was sent: the draft stays. A voice message never used it.
        composer.setText("rig", "first, then more")
        sender.send("rig", "first", SendOptions(awaitDelivery = true))
        sender.send("rig", "spoken", SendOptions(source = "voice", awaitDelivery = true))
        assertEquals("first, then more", composer.mirrors.value["rig"]?.draft)
    }

    @Test
    fun chatsEntryResolvesTheMetaLikeHappyAppAndLaysItsOwnOver() = runBlocking {
        server.addSession("cx", updatedAt = 100, metadata = buildJsonObject {
            put("path", "/repo"); put("host", "mac"); put("flavor", "codex"); put("permissionMode", "read-only")
        })
        h.startAndSync()
        eventually(message = "mirror") { h.account.composer.mirrors.value["cx"]?.permissionMode == "read-only" }
        val localId = sender.send("cx", "hello", buildJsonObject { put("displayText", "Hi") })
        assertEquals(localId, outbox("cx").firstOrNull()?.localId ?: localId)
        eventually(message = "sent") { server.sentRecords("cx").isNotEmpty() }
        val meta = server.sentRecords("cx").single().second["meta"]!!.jsonObject
        assertEquals(
            listOf("sentFrom", "appendSystemPrompt", "permissionMode", "model", "effort", "displayText"),
            meta.keys.toList(),
        )
        assertEquals(JsonPrimitive("read-only"), meta["permissionMode"])
        assertEquals(JsonPrimitive("gpt-6.1-sol"), meta["model"])
        assertEquals(JsonPrimitive("medium"), meta["effort"])
        assertEquals(JsonPrimitive("Hi"), meta["displayText"])
    }

    @Test
    fun aModeTheSessionsCliCannotParseIsRefusedAndNothingQueued() = runBlocking {
        server.addSession("old", updatedAt = 100, metadata = buildJsonObject {
            put("path", "/repo"); put("host", "mac"); put("flavor", "claude"); put("version", "1.2.0"); put("permissionMode", "auto")
        })
        h.startAndSync()
        eventually(message = "mirror") { h.account.composer.mirrors.value["old"]?.permissionMode == "auto" }
        val refusal = kotlin.runCatching { sender.send("old", "hi", null) }.exceptionOrNull()
        assertTrue(refusal is SendException)
        assertTrue(refusal!!.message!!.contains("'auto'"))
        assertTrue(store.outbox("old").isEmpty())
    }

    @Test
    fun attachmentRecordsGoOutAheadOfTheTextInOrder() = runBlocking {
        server.echoSentMessages = false
        server.failSends += 503
        h.startAndSync()
        fun file(ref: String) = buildJsonObject {
            put("role", "session")
            put("content", buildJsonObject { put("type", "session"); put("ref", ref) })
        }
        val localId = sender.send("s1", "look", null, attachments = listOf(file("a"), file("b")))
        val rows = outbox()
        assertEquals(listOf(OutboxKind.ATTACHMENT, OutboxKind.ATTACHMENT, OutboxKind.USER), rows.map { it.kind })
        assertEquals(localId, rows.last().localId)
        // One failed POST, then all three go out together, in order, once.
        eventually(message = "sent") { server.sentRecords("s1").size == 3 }
        val sent = server.sentRecords("s1")
        assertEquals(rows.map { it.localId }, sent.map { it.first })
        assertEquals(listOf(file("a"), file("b")), sent.take(2).map { it.second })
        assertEquals("look", sent[2].second["content"]!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals(2, server.requestsTo("/v3/sessions/s1/messages").count { it.method == "POST" })
    }

    @Test
    fun theOutboxIsObservable() = runBlocking {
        server.failSends += 400
        h.startAndSync()
        sender.send("s1", "watch me", SendOptions(awaitDelivery = true))
        val rows = withTimeout(5_000) { sender.outbox("s1").first { it.isNotEmpty() } }
        assertEquals(OutboxState.FAILED, rows.single().state)
        assertEquals("watch me", HappyJson.parseToJsonElement(rows.single().recordJson).jsonObject["content"]!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertNull(rows.single().serverId)
        assertTrue(!sender.hasUnsentUserMessage("s1"))
    }
}
