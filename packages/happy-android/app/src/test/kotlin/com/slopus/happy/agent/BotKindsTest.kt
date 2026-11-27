package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Happy Cloud's shared and personal bots: how they read, where home lists them, and how one is edited. */
class BotKindsTest {
    private fun catalog(bootstrap: JsonObject) =
        AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))

    private fun bot(id: String, name: String, kind: String?, admin: Boolean, editable: Boolean? = null, orderKey: String = "1") =
        Wire.bot(id, name, Wire.agent("a$id"), orderKey = orderKey)
            .with("isAdmin", admin)
            .let { if (kind != null) it.with("kind", kind) else it }
            .let { if (editable != null) it.with("editable", editable) else it }

    // An owner gets the shared bot and the personal ones; a member the personal ones alone.
    private val shared = bot("chief", "Chief of Staff", "shared", admin = true).with("systemKey", "chief_of_staff")
    private val researcher = bot("research", "Researcher", "personal", admin = false, editable = true, orderKey = "2")
        .with("instructions", "Read papers.").with("revision", 3)
    private val writer = bot("writer", "Writer", "personal", admin = false, editable = false, orderKey = "3")

    @Test
    fun theWireBotReadsEveryKindAndAdminTogetherAndALegacyBotWithout() {
        fun decode(bot: JsonObject) = AgentClient.json.decodeFromJsonElement(WireBot.serializer(), bot)
        val personal = decode(researcher)
        assertEquals("personal", personal.kind)
        assertEquals(true, personal.editable)
        assertEquals("Read papers.", personal.instructions)
        assertEquals(3, personal.revision)
        assertEquals(false, personal.isAdmin)
        // kind and isAdmin are apart: each pair reads, and places by kind alone.
        for (kind in listOf("shared", "personal")) for (admin in listOf(true, false)) {
            val wire = bot("b", "B", kind, admin)
            assertEquals(kind, decode(wire).kind)
            assertEquals(admin, decode(wire).isAdmin)
            assertEquals(if (kind == "shared") BotKind.Shared else BotKind.Personal, BotKind.of(wire))
        }
        val legacy = Wire.bot("b1", "Scout", Wire.agent("ab1"))
        assertNull(decode(legacy).kind)
        assertNull(decode(legacy).editable)
        assertNull(BotKind.of(legacy))
        assertFalse(BotKind.carried(legacy))
        assertFalse(botEditable(legacy))
        // A kind this build doesn't know is a cluster bot listed as one.
        val later = legacy.with("kind", "team")
        assertNull(BotKind.of(later))
        assertTrue(BotKind.carried(later))
    }

    @Test
    fun anOwnerHasTheSharedBotLastAmongThePlacesAndThePersonalOnesUnderBots() {
        val surfaces = listOf(Wire.surface("s1", "Roadmap", "document"))
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(bots = listOf(writer, shared, researcher), surfaces = surfaces)), feedUnread = 1)
        assertEquals(
            listOf("section-places", "feed", "artifacts", "todos", "surface-s1", "agent-achief", "section-bots", "agent-aresearch", "agent-awriter"),
            feed.rows.map { it.key },
        )
        val chief = feed.conversations.first { it.agentId == "achief" }
        assertEquals(ConversationKind.Bot, chief.kind)
        assertEquals("Chief of Staff", chief.title)
        assertTrue(chief.happy)
    }

    @Test
    fun aMemberHasOnlyThePersonalBotsUnderBots() {
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(bots = listOf(researcher, writer))))
        assertEquals(
            listOf("section-places", "artifacts", "todos", "section-bots", "agent-aresearch", "agent-awriter"),
            feed.rows.map { it.key },
        )
    }

    @Test
    fun placesFollowTheKindNotTheAdminFlag() {
        val sharedPlain = bot("s", "Desk", "shared", admin = false)
        val personalAdmin = bot("p", "Builder", "personal", admin = true, orderKey = "2")
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(bots = listOf(sharedPlain, personalAdmin))))
        assertEquals(
            listOf("section-places", "artifacts", "todos", "agent-as", "section-bots", "agent-ap"),
            feed.rows.map { it.key },
        )
    }

    @Test
    fun aHappyAgentDaemonsBotsAreListedAsBefore() {
        val admin = Wire.bot("b1", "Happy", Wire.agent("ab1")).with("isAdmin", true).with("systemKey", "chief_of_staff")
        val other = Wire.bot("b2", "Scout", Wire.agent("ab2"), orderKey = "2")
        val feed = AgentFeed.derive(catalog(Wire.bootstrap(bots = listOf(admin, other))))
        assertEquals(
            listOf("section-places", "artifacts", "todos", "section-bots", "agent-ab1", "agent-ab2"),
            feed.rows.map { it.key },
        )
    }

    @Test
    fun theFormValidatesAndSendsOnlyWhatChanged() {
        val form = BotEditForm.of(researcher)
        assertEquals(BotEditForm("Researcher", "Read papers.", "Researcher", "Read papers."), form)
        assertFalse(form.changed)
        assertFalse(form.canSave)
        // Spaces round the same name are no change.
        assertFalse(form.copy(name = "  Researcher ").changed)

        val renamed = form.copy(name = " Scholar ")
        assertTrue(renamed.canSave)
        assertEquals("""{"name":"Scholar","mutationId":"m"}""", renamed.body("m").toString())
        val told = form.copy(instructions = "Read papers.\nCite them.")
        assertEquals(JsonPrimitive("Read papers.\nCite them."), told.body("m")["instructions"])
        assertNull(told.body("m")["name"])
        // Empty instructions are instructions too.
        assertTrue(form.copy(instructions = "").canSave)

        assertEquals(BotEditForm.Problem.NameBlank, form.copy(name = "   ").problem)
        assertEquals(BotEditForm.Problem.NameTooLong, form.copy(name = "x".repeat(257)).problem)
        assertNull(form.copy(name = "x".repeat(256)).problem)
        // Code points, not UTF-16 units: 256 emoji fit.
        assertNull(form.copy(name = "😀".repeat(256)).problem)
        assertEquals(BotEditForm.Problem.NameControl, form.copy(name = "a\u0007b").problem)
        assertEquals(BotEditForm.Problem.InstructionsTooLong, form.copy(instructions = "x".repeat(32 * 1024 + 1)).problem)
        assertNull(form.copy(instructions = "x".repeat(32 * 1024)).problem)
        // UTF-8 bytes: 8193 four-byte characters are over.
        assertEquals(BotEditForm.Problem.InstructionsTooLong, form.copy(instructions = "😀".repeat(8193)).problem)
        assertFalse(form.copy(name = "", instructions = "New").canSave)
    }

    @Test
    fun theBotHeardAgainMovesWhatWasntTouchedAndKeepsWhatWasTyped() {
        val form = BotEditForm.of(researcher).copy(instructions = "Typed here")
        val updated = researcher.with("name", "Renamed elsewhere").with("instructions", "Changed elsewhere")
        val heard = form.heard(updated)
        assertEquals(BotEditForm("Renamed elsewhere", "Typed here", "Renamed elsewhere", "Changed elsewhere"), heard)
        // A copy without instructions (a bootstrap's, an event's) keeps those last heard.
        val bare = JsonObject(researcher - "instructions")
        assertEquals("Read papers.", BotEditForm.of(researcher).heard(bare).savedInstructions)
        // Saved: what was typed is now the bot's, so nothing is left to save.
        val saved = form.heard(researcher.with("instructions", "Typed here"))
        assertFalse(saved.changed)
    }

    /** Answers by "METHOD path", one after another; records each request's headers and body. */
    private class Answers(vararg answers: Pair<String, Pair<Int, String>>) : Transport {
        val queue = answers.toMutableList()
        val asked = mutableListOf<Triple<String, Map<String, String>, String?>>()

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += Triple("$method $path", headers, body?.let { String(it) })
            val at = queue.indexOfFirst { it.first == "$method $path" }
            if (at < 0) return TransportResponse(404, mapOf("content-type" to "application/json"), """{"error":"Not found","code":"not_found"}""".toByteArray())
            val (status, text) = queue.removeAt(at).second
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    private fun answer(bot: JsonObject) = """{"bot":$bot}"""

    @Test
    fun aSaveNamesItsVersionAndOneThatLostARaceGoesOnceMoreOverTheNewer() = runBlocking {
        val newer = researcher.with("version", "03")
        val saved = newer.with("name", "Scholar").with("version", "04")
        val agent = Answers(
            "PATCH /v0/bots/research" to (409 to """{"error":"Version conflict","code":"conflict","bot":$newer}"""),
            "PATCH /v0/bots/research" to (200 to answer(saved)),
        )
        val editor = BotEditor(AgentClient(agent, "t"), "research")
        val result = editor.save(BotEditForm.of(researcher).copy(name = "Scholar"), "01")
        assertEquals("Scholar", result["name"]!!.jsonPrimitive.content)
        assertEquals(listOf("01", "03"), agent.asked.map { it.second["If-Match"] })
        // The same change both times, under one mutationId.
        val bodies = agent.asked.map { AgentClient.json.parseToJsonElement(it.third!!).jsonObject }
        assertEquals(bodies[0], bodies[1])
        assertEquals(JsonPrimitive("Scholar"), bodies[0]["name"])
        assertNull(bodies[0]["instructions"])
    }

    @Test
    fun aRefusalIsTheServersAndPicturesGoToTheirOwnRoute() = runBlocking {
        val agent = Answers(
            "PATCH /v0/bots/chief" to (403 to """{"error":"Shared bots can't be changed.","code":"forbidden"}"""),
            "PUT /v0/bots/research/avatar" to (200 to answer(researcher.with("avatar", JsonObject(mapOf("kind" to JsonPrimitive("image"), "thumbhash" to JsonPrimitive("abc")))))),
            "DELETE /v0/bots/research/avatar" to (200 to answer(researcher)),
        )
        val client = AgentClient(agent, "t")
        try {
            BotEditor(client, "chief").save(BotEditForm.of(shared).copy(name = "Boss"), "01")
            fail("A refusal throws")
        } catch (e: AgentApiException) {
            assertEquals(403, e.status)
            assertEquals("Shared bots can't be changed.", e.message)
            assertFalse(Permission.refused(e.status, e.code, e.message))
        }
        val editor = BotEditor(client, "research")
        val pictured = editor.setAvatar(byteArrayOf(1, 2, 3), "01")
        assertEquals("abc", (pictured["avatar"] as JsonObject).string("thumbhash"))
        val put = agent.asked.first { it.first == "PUT /v0/bots/research/avatar" }
        assertEquals("01", put.second["If-Match"])
        assertEquals("image/jpeg", put.second["Content-Type"])
        editor.removeAvatar("02")
        assertEquals("02", agent.asked.last().second["If-Match"])
    }
}
