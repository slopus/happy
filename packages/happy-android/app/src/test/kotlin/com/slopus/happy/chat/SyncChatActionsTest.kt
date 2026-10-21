package com.slopus.happy.chat

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.sync.AccountHarness
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.MessageSender
import com.slopus.happy.sync.SendException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/** The chat's actions reach the agent as Sync's session RPCs, in happy-app's payloads. */
@RunWith(AndroidJUnit4::class)
class SyncChatActionsTest {
    private lateinit var h: AccountHarness
    private lateinit var actions: SyncChatActions

    @Before
    fun setUp() {
        h = AccountHarness()
        h.server.addSession("cli", updatedAt = 100, metadata = buildJsonObject { put("path", "/repo"); put("host", "mac") })
        actions = SyncChatActions { h.account }
    }

    @After
    fun tearDown() = h.close()

    private fun respond(method: String): List<JsonElement> {
        val calls = CopyOnWriteArrayList<JsonElement>()
        h.server.rpc["cli:$method"] = { params ->
            calls += h.server.openRpc("cli", params)
            h.server.sealRpc("cli", JsonNull)
        }
        return calls
    }

    @Test
    fun permissionAnswersCarryModeToolsAndDecision() = runBlocking {
        h.startAndSync()
        val calls = respond("permission")
        actions.answerPermission("cli", PermissionAnswer("r1", approved = true, allowedTools = listOf("Bash(ls)")))
        actions.answerPermission("cli", PermissionAnswer("r2", approved = false, decision = PermissionDecision.Abort))
        assertEquals(buildJsonObject {
            put("id", "r1"); put("approved", true)
            putJsonArray("allowTools") { add(JsonPrimitive("Bash(ls)")) }
        }, calls[0])
        assertEquals(buildJsonObject { put("id", "r2"); put("approved", false); put("decision", "abort") }, calls[1])
    }

    @Test
    fun questionAnswersOmitAnEmptyCustomAnswer() = runBlocking {
        h.startAndSync()
        val calls = respond("communication")
        actions.answerQuestion(
            "cli", "c1",
            linkedMapOf("q1" to AgentQuestionAnswer(listOf("Blue")), "q2" to AgentQuestionAnswer(emptyList(), "teal")),
        )
        actions.cancelQuestion("cli", "c2")
        assertEquals(buildJsonObject {
            put("id", "c1"); put("kind", "form"); put("status", "answered")
            putJsonObject("answers") {
                putJsonObject("q1") { putJsonArray("options") { add(JsonPrimitive("Blue")) } }
                putJsonObject("q2") { putJsonArray("options") {}; put("custom", "teal") }
            }
        }, calls[0])
        assertEquals(buildJsonObject { put("id", "c2"); put("kind", "form"); put("status", "cancelled") }, calls[1])
    }

    @Test
    fun sendQueuesTheMessageWithTheChatsMetaOnTop() = runBlocking {
        h.startAndSync()
        actions.send("cli", "hello", buildJsonObject { put("displayText", "Hi") }, awaitDelivery = true)
        val (_, record) = h.server.sentRecords("cli").single()
        assertEquals("Hi", record["meta"]!!.jsonObject["displayText"]!!.jsonPrimitive.content)
    }

    @Test
    fun aSendThatQueuedNothingSaysWhy() = runBlocking {
        h.startAndSync()
        try {
            actions.send("missing", "hello")
            fail("nothing should be queued")
        } catch (e: SendException) {
            assertEquals(MessageSender.NOT_SYNCED, e.message)
        }
    }

    @Test
    fun modePicksGoToTheComposer() = runBlocking {
        h.startAndSync()
        actions.setModes("cli", mapOf(AgentModeField.PERMISSION_MODE to "acceptEdits"))
        assertEquals("acceptEdits", h.account.composer.mirrors.value["cli"]?.permissionMode)
    }
}
