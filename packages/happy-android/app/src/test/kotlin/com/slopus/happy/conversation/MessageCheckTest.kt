package com.slopus.happy.conversation

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Messages checked against the protocol (`test/resources/messages/fixtures.json`, from
 * happy-agent-client's `protocol/messages.ts`): a valid one reads as before, an invalid one is one
 * placeholder in its place, and the messages around it read on.
 */
class MessageCheckTest {
    private class Fixture(val name: String, val message: JsonElement, val problem: String?)

    private val fixtures: JsonObject = Json.parseToJsonElement(
        javaClass.classLoader!!.getResource("messages/fixtures.json")!!.readText(),
    ).jsonObject

    private fun list(key: String) = fixtures[key]!!.jsonArray.map {
        val o = it.jsonObject
        Fixture(o["name"]!!.jsonPrimitive.content, o["message"]!!, o["problem"]?.jsonPrimitive?.content)
    }

    private val valid = list("valid")
    private val invalid = list("invalid")

    private val logged = ArrayList<String>()
    private val write = UndisplayableLog.write

    init {
        UndisplayableLog.write = { logged += it }
    }

    @After fun restore() {
        UndisplayableLog.write = write
    }

    private fun fixture(name: String) = (valid + invalid).first { it.name == name }.message

    @Test fun `valid messages pass the check and decode as before`() {
        assertTrue(valid.size >= 15)
        for (fixture in valid) {
            assertNull(fixture.name, MessageCheck.problem(fixture.message))
            val decoded = Message.decode(fixture.message, "fallback")
            assertNull(fixture.name, decoded.undisplayable)
            assertEquals(fixture.name, Message.parse(fixture.message), decoded)
        }
    }

    /** desktop's shared fixtures (happy-desktop-state `fixtures/protocol-messages`, copied in `messages/protocol`). */
    private fun shared(kind: String): List<Pair<String, JsonObject>> {
        val dir = java.io.File(javaClass.classLoader!!.getResource("messages/protocol/$kind")!!.toURI())
        return dir.listFiles()!!.filter { it.name.endsWith(".json") }.sorted().map { it.name to Json.parseToJsonElement(it.readText()).jsonObject }
    }

    @Test fun `every shared valid message decodes`() {
        val valid = shared("valid")
        assertTrue(valid.size >= 25)
        for ((name, fixture) in valid) {
            val message = fixture["message"]!!
            assertNull(name, MessageCheck.problem(message))
            assertNull(name, Message.decode(message, "x").undisplayable)
            assertTrue(name, ConversationRowBuilder.build(Message.decode(message, "x"), "a1", null, streaming = false).none { it is ConversationRow.Undisplayable })
        }
    }

    /** Shared invalid fixtures Android reads on purpose: the cluster's older history has a review without `elevated`. */
    private val readAnyway = setOf("review-without-elevated.json")

    @Test fun `every shared invalid message is a placeholder, failing where the fixture says`() {
        val invalid = shared("invalid").filter { it.first !in readAnyway }
        assertTrue(invalid.size >= 7)
        for ((name, fixture) in invalid) {
            val problem = MessageCheck.problem(fixture["message"]!!)!!
            // The first failure found, at or under one of the places the fixture lists.
            val at = problem.substringBefore(": ")
            val listed = fixture["invalidAt"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertTrue("$name: $problem not under $listed", listed.any { at == it || at.startsWith("$it/") })
            val placeholder = Message.decode(fixture["message"]!!, "x")
            assertEquals(name, problem, placeholder.undisplayable)
            assertEquals(name, ConversationRowBuilder.undisplayable(placeholder.id, problem), ConversationRowBuilder.build(placeholder, "a1", null, streaming = false).single())
        }
    }

    @Test fun `a review without elevated reads, its elevation unknown`() {
        for (message in listOf(shared("invalid").toMap().getValue("review-without-elevated.json")["message"]!!, fixture("cluster's settled call reviewed before elevated was sent"))) {
            val decoded = Message.decode(message, "x")
            assertNull(decoded.undisplayable)
            val call = decoded.content.filterIsInstance<Block.ToolCall>().single()
            assertTrue(call.review != null)
            assertNull(call.elevated)
        }
        // The text beside it reads too.
        assertEquals("Running it.", Message.decode(fixture("cluster's settled call reviewed before elevated was sent"), "x").text)
    }

    @Test fun `a tool call's result and arguments are opaque JSON, as older cluster history keeps them`() {
        val decoded = Message.decode(fixture("cluster's older history: a string result and string arguments"), "x")
        assertNull(decoded.undisplayable)
        val calls = decoded.content.filterIsInstance<Block.ToolCall>()
        assertEquals(listOf("c11a", "c11b", "c11c"), calls.map { it.id })
        assertEquals(kotlinx.serialization.json.JsonPrimitive("Message delivered."), calls[0].result)
        assertEquals(3, ConversationRowBuilder.build(decoded, "a1", null, streaming = false).count { it is ConversationRow.Tool })
    }

    @Test fun `a presentation type this build doesn't know is a plain tool call`() {
        val message = Message.decode(shared("valid").toMap().getValue("agent-presentation-unknown-type.json")["message"]!!, "x")
        val call = message.content.filterIsInstance<Block.ToolCall>().single()
        assertNull(call.presentation)
        assertTrue(ConversationRowBuilder.build(message, "a1", null, streaming = false).any { it is ConversationRow.Tool && it.callId == call.id })
    }

    @Test fun `a question's header may be empty, but not past 64`() {
        val card = shared("valid").toMap().getValue("agent-presentation-user-input.json")["message"]!!.toString()
        assertNull(MessageCheck.problem(Json.parseToJsonElement(card.replace(Regex("\"header\":\"[^\"]*\""), "\"header\":\"\""))))
        val long = Json.parseToJsonElement(card.replace(Regex("\"header\":\"[^\"]*\""), "\"header\":\"${"h".repeat(65)}\""))
        assertTrue(MessageCheck.problem(long)!!.endsWith("/header: expected at most 64 characters"))
    }

    @Test fun `a user message's mode may be null, as happy-agent sends legacy ones, but not missing`() {
        assertNull(MessageCheck.problem(fixture("legacy user message with a null mode")))
        assertEquals("/mode: expected a value or null, got missing", MessageCheck.problem(fixture("user message without its mode")))
    }

    @Test fun `invalid messages fail with a short reason`() {
        assertTrue(invalid.size >= 15)
        for (fixture in invalid) assertEquals(fixture.name, fixture.problem, MessageCheck.problem(fixture.message))
    }

    @Test fun `an invalid message keeps where it stands and why, and nothing it held`() {
        for (fixture in invalid) {
            val placeholder = Message.decode(fixture.message, "run1:3")
            assertEquals(fixture.name, fixture.problem, placeholder.undisplayable)
            assertEquals(fixture.name, emptyList<Block>(), placeholder.content)
            assertNull(fixture.name, placeholder.failure)
            assertNull(fixture.name, placeholder.error)
            val id = (fixture.message as? JsonObject)?.get("id")?.jsonPrimitive?.content
            assertEquals(fixture.name, id ?: "run1:3", placeholder.id)
        }
        val card = Message.decode(fixture("cancelled question card from the cluster"), "x")
        assertEquals("bad1", card.id)
        assertEquals("agent", card.role)
        assertFalse(card.toString().contains("review this change"))
    }

    @Test fun `the cluster's cancelled card is a placeholder between neighbours that read`() {
        val page = MessagesPage.parse(
            buildJsonObject {
                put("cursor", "c1")
                put("hasMore", false)
                put(
                    "runs",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("id", "run1")
                                put("status", "completed")
                                put("messages", JsonArray(listOf(fixture("user text"), fixture("cancelled question card from the cluster"), fixture("agent text, reasoning and a command"), JsonObject(emptyMap()))))
                            },
                        )
                    },
                )
            },
        )!!
        val messages = page.runs.single().messages
        assertEquals(listOf("u1", "bad1", "m1", "run1:3"), messages.map { it.id })
        assertEquals(listOf(null, "/content/0/presentation/answers: expected an object, got null", null, "/id: expected a string, got missing"), messages.map { it.undisplayable })

        val builder = ConversationRowBuilder()
        // An agent of its own: the log is once a process, and other tests show this card too.
        val rows = messages.map { builder.rows(it, "a-check", null, streaming = false) }
        assertTrue(rows[0].single() is ConversationRow.User)
        assertEquals(listOf(ConversationRow.Undisplayable("bad1:undisplayable", "bad1", "/content/0/presentation/answers: expected an object, got null")), rows[1])
        assertEquals(listOf("Checking.", "Done.", "ls"), rows[2].map {
            when (it) {
                is ConversationRow.Reasoning -> it.text
                is ConversationRow.Text -> it.text
                is ConversationRow.Tool -> (it.tool.presentation as Presentation.Command).command
                else -> error("unexpected $it")
            }
        })
        // Built again, and in another builder: logged once.
        ConversationRowBuilder().rows(messages[1], "a-check", null, streaming = false)
        assertEquals(1, logged.count { "bad1" in it })
        assertEquals("Message bad1 of agent a-check failed to display: /content/0/presentation/answers: expected an object, got null", logged.first { "bad1" in it })
    }

    @Test fun `an answered card still settles its question`() {
        val rows = ConversationRowBuilder.build(Message.decode(fixture("answered question card, cluster's empty header"), "x"), "a1", null, streaming = false)
        val ask = rows.single() as ConversationRow.Ask
        assertEquals(mapOf("reviewer" to listOf("Kirill")), ask.question.answers)
        assertEquals(AskPhase.Answered, ask.phase)
    }

    @Test fun `a placeholder is kept on the phone as a placeholder`() {
        val placeholder = Message.decode(fixture("cancelled question card from the cluster"), "x")
        val kept = KeptConversation.parse(KeptConversation(listOf(Run("run1", "completed", 1, listOf(placeholder))), emptyList(), false, null, null).json())!!
        assertEquals(placeholder, kept.runs.single().messages.single())
        // A computer can't make a valid message a placeholder by naming the field.
        val named = JsonObject(fixture("user text").jsonObject + ("undisplayable" to kotlinx.serialization.json.JsonPrimitive("no")))
        assertNull(Message.decode(named, "x").undisplayable)
    }

    @Test fun `a hostile message's keys and ID never reach the report`() {
        val secret = "hunter2 sk-live-SECRET"
        val card = fixture("cancelled question card from the cluster").toString()
            .replace("\"id\":\"bad1\"", "\"id\":\"leak $secret\"")
            .replace("\"answers\":null", "\"answers\":{\"$secret\":\"not a list\"}")
        val request = fixture("tool call request with an extra field").toString().replace("\"extra\"", "\"$secret\"")
        for (raw in listOf(card, request)) {
            val message = Message.decode(Json.parseToJsonElement(raw), "x")
            val row = ConversationRowBuilder().rows(message, "a-hostile", null, streaming = false).single() as ConversationRow.Undisplayable
            val url = UndisplayableReport.url("https://cluster.example", "a1", row, "2026.11.1")
            val read = java.net.URLDecoder.decode(url, "UTF-8")
            assertFalse(read, "hunter2" in read || "SECRET" in read || "leak" in read)
            assertTrue(read, "<key>" in read)
            assertFalse(logged.joinToString(), logged.any { "hunter2" in it })
        }
        // However long what is reported, the address stays short enough to open.
        val long = ConversationRow.Undisplayable("k", "m1", "/content/0/presentation/answers/<key>: " + "x".repeat(5000))
        val url = UndisplayableReport.url("https://" + "s".repeat(3000) + ".example", "a1", long, "2026.11.1")
        assertTrue(url.length <= UndisplayableReport.URL_LIMIT)
        assertTrue(java.net.URLDecoder.decode(url, "UTF-8").contains("- Message: m1"))
    }

    @Test fun `a bug report says where the message was and why, not what it said`() {
        val row = ConversationRow.Undisplayable("bad1:undisplayable", "bad1", "/content/0/presentation/answers: expected an object, got null")
        val body = UndisplayableReport.body("https://cluster.example", "agent1", row, "2026.11.1")
        assertEquals(
            """
            A message in a Happy Agent conversation failed to display.

            - Server: https://cluster.example
            - Agent: agent1
            - Message: bad1
            - Error: /content/0/presentation/answers: expected an object, got null
            - App: Android 2026.11.1
            """.trimIndent(),
            body,
        )
        val url = UndisplayableReport.url(null, "agent1", row, "2026.11.1")
        assertTrue(url.startsWith("https://github.com/slopus/happy/issues/new?title=Android%3A%20a%20message%20failed%20to%20display&body="))
        assertTrue(java.net.URLDecoder.decode(url.substringAfter("body="), "UTF-8").contains("- Server: paired agent\n"))
    }
}
