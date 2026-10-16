package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * sync.ts `hasPendingUserMessage` on a receipts session: a send already
 * echoed but not yet accepted still counts, so the next one goes out
 * queued behind it; once the receipt is in, it no longer does.
 */
@RunWith(AndroidJUnit4::class)
class PendingReceiptSendTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server
    private val sender get() = h.account.sender

    @Before
    fun setUp() {
        h = AccountHarness()
        val rig = HappyJson.parseToJsonElement(SessionComposerTest.RIG_METADATA_FIXTURE).jsonObject
        val capabilities = JsonObject(rig["capabilities"]!!.jsonObject + ("messageReceipts" to JsonPrimitive(true)))
        server.addSession("s1", updatedAt = 100, metadata = JsonObject(rig + ("capabilities" to capabilities)))
    }

    @After
    fun tearDown() = h.close()

    private fun queuedWhileBusy(index: Int) =
        server.sentRecords("s1")[index].second["meta"]!!.jsonObject["queuedWhileBusy"]!!.jsonPrimitive.content.toBoolean()

    private fun sendAndAwaitEcho(text: String) = runBlocking {
        sender.send("s1", text, SendOptions(awaitDelivery = true))
        eventually(message = "echo of $text") { h.store.outbox("s1").isEmpty() && h.store.messages("s1").any { it.localId != null && it.contentJson?.contains(text) == true } }
    }

    @Test
    fun anEchoedSendWithoutItsReceiptQueuesTheNext() {
        h.startAndSync()
        sendAndAwaitEcho("first")
        assertEquals(false, queuedWhileBusy(0))

        sendAndAwaitEcho("second")
        assertEquals(true, queuedWhileBusy(1))

        // The agent accepts both; the next send has nothing ahead of it.
        val ids = server.sentRecords("s1").indices.map { h.store.messages("s1")[it].id }
        for ((n, ref) in ids.withIndex()) {
            server.appendMessage(
                "s1",
                HappyJson.parseToJsonElement(
                    """{"role":"session","content":{"id":"accepted-$n","time":1,"role":"agent","ev":{"t":"user-message-accepted","id":"a-$n","ref":"$ref","runId":"r"}}}""",
                ).jsonObject,
            )
        }
        runBlocking { h.account.syncNow() }
        eventually(message = "receipts stored") { h.store.messages("s1").size == 4 }
        sendAndAwaitEcho("third")
        assertEquals(false, queuedWhileBusy(4))
    }
}
