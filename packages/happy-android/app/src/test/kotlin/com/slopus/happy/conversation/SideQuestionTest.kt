package com.slopus.happy.conversation

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `/btw` as the composer reads it, where a chat offers it, and the side
 * question routes as the phone asks them (happy-agent API.md "Side
 * questions"; sideQuestion.ts and its spec in the former web app).
 */
class SideQuestionTest {
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test fun `btw takes the rest of the words as its question, and a bare btw asks nothing`() {
        assertEquals("what changed?", SideQuestion.question("/btw what changed?"))
        assertEquals("spaced out", SideQuestion.question("  /btw   spaced out  "))
        assertEquals("first line\nsecond line", SideQuestion.question("/btw first line\nsecond line"))
        assertEquals("", SideQuestion.question("/btw"))
        assertEquals("", SideQuestion.question("/btw   "))
        assertNull(SideQuestion.question("/btwx"))
        assertNull(SideQuestion.question("by the way /btw"))
        assertNull(SideQuestion.question("/compact"))
        assertNull(SideQuestion.question("btw what changed?"))
    }

    private val catalog = ModeCatalog.parse(
        json(
            """{"config":{
                "defaults":{"providerId":"claude","modelId":"claude-code/opus","permissionMode":"auto"},
                "models":{
                    "claude-code/opus":{"name":"Opus","sideQuestions":true},
                    "claude-code/haiku":{"name":"Haiku","sideQuestions":false},
                    "openai/gpt-5.6-sol":{"name":"GPT-5.6 Sol"},
                    "acme/bot":{"name":"Bot","sideQuestions":"true"}
                },
                "providers":{
                    "claude":{"type":"claude","enabled":true,"models":[{"id":"claude-code/opus"},{"id":"claude-code/haiku"}]},
                    "codex":{"type":"codex","enabled":true,"models":[{"id":"openai/gpt-5.6-sol"}]}
                }}}""",
        ),
    )

    private fun mode(modelId: String) = Mode("claude", modelId, "high", null, "auto")

    @Test fun `only a model whose definition says sideQuestions true answers them`() {
        assertEquals(setOf("claude-code/opus"), catalog.sideQuestions)
        assertTrue(catalog.answersSideQuestions("claude-code/opus"))
        // Its id's shape says nothing: a Claude Code model that says false, or a string, answers none.
        assertFalse(catalog.answersSideQuestions("claude-code/haiku"))
        assertFalse(catalog.answersSideQuestions("acme/bot"))
        assertFalse(catalog.answersSideQuestions("openai/gpt-5.6-sol"))
        // An older daemon's configuration says it of none.
        assertTrue(ModeCatalog.parse(json("""{"config":{"models":{"claude-code/opus":{"name":"Opus"}}}}""")).sideQuestions.isEmpty())
    }

    @Test fun `a chat offers btw only where the computer serves side questions and its model answers them`() {
        assertTrue(SideQuestion.offered(served = true, catalog = catalog, mode = mode("claude-code/opus")))
        assertFalse(SideQuestion.offered(served = false, catalog = catalog, mode = mode("claude-code/opus")))
        assertFalse(SideQuestion.offered(served = true, catalog = catalog, mode = mode("openai/gpt-5.6-sol")))
        assertFalse(SideQuestion.offered(served = true, catalog = null, mode = mode("claude-code/opus")))
        assertFalse(SideQuestion.offered(served = true, catalog = catalog, mode = null))
        // Happy Cloud's connections list models as the computer defines them: the flag goes with them.
        val cloud = ModeCatalog.withConnections(catalog, emptyList())
        assertTrue(SideQuestion.offered(served = true, catalog = cloud, mode = mode("claude-code/opus")))
    }

    @Test fun `the list offers btw first, and no agent command of that name shadows it`() {
        val btw = SlashCommand(SideQuestion.COMMAND, true, "Ask about this chat without adding to it", SlashCommand.SIDE_QUESTION)
        val agent = listOf(
            SlashCommand("compact", false, "Summarize.", SlashCommand.COMPACTION),
            SlashCommand("btw", false, "Something else."),
            SlashCommand("code-review", true, "Review.", SlashCommand.SKILL),
        )
        val offered = SideQuestion.commands(agent, btw)
        assertEquals(listOf("btw", "compact", "code-review"), offered.map { it.name })
        assertTrue(offered.first().isSideQuestion)
        assertEquals(listOf("btw"), SlashCommands.matching(offered, "b").map { it.name })
        assertEquals(listOf("btw", "compact", "code-review"), SlashCommands.matching(offered, "").map { it.name })
    }

    @Test fun `a reply is answering, answered or failed, and nothing else`() {
        assertEquals(SideReply.Answering("q1"), SideReply.parse(json("""{"sideQuestion":{"id":"q1","status":"answering"}}""")))
        assertEquals(
            SideReply.Answered("q1", "The retry loop in `uploader.ts`.", false),
            SideReply.parse(json("""{"sideQuestion":{"id":"q1","status":"answered","response":"The retry loop in `uploader.ts`.","synthetic":false}}""")),
        )
        assertEquals(SideReply.Answered("q1", null, false), SideReply.parse(json("""{"sideQuestion":{"id":"q1","status":"answered","response":null,"synthetic":false}}""")))
        assertEquals(SideReply.Answered("q1", "No answer.", true), SideReply.parse(json("""{"sideQuestion":{"id":"q1","status":"answered","response":"No answer.","synthetic":true}}""")))
        assertEquals(SideReply.Failed("q1", "Rate limited."), SideReply.parse(json("""{"sideQuestion":{"id":"q1","status":"failed","error":"Rate limited."}}""")))
        assertNull(SideReply.parse(json("""{"sideQuestion":{"id":"q1","status":"thinking"}}""")))
        assertNull(SideReply.parse(json("""{"sideQuestion":{"status":"answering"}}""")))
        assertNull(SideReply.parse(json("""{"question":{"id":"q1","status":"answering"}}""")))
    }

    /** The routes asked, with their bodies; each answered by [answer]. */
    private class Routes(val answer: (method: String, path: String) -> TransportResponse) {
        val asked = ArrayList<Triple<String, String, JsonElement?>>()
        val request: AgentRequest = { method, path, body, category ->
            assertEquals(RequestCategory.Query, category)
            asked += Triple(method, path, body)
            answer(method, path)
        }
    }

    private fun ok(text: String) = TransportResponse(200, body = text.toByteArray())

    @Test fun `a question is posted with its thread's history, collected and cancelled by its id`() = runTest {
        val routes = Routes { method, _ ->
            when (method) {
                "DELETE" -> ok("""{"cancelled":true}""")
                else -> ok("""{"sideQuestion":{"id":"q 1","status":"answering"}}""")
            }
        }
        val api = ConversationApi(routes.request)
        assertEquals(SideReply.Answering("q 1"), api.askSideQuestion("agent 1", "Which file?"))
        assertEquals(SideReply.Answering("q 1"), api.askSideQuestion("agent 1", "And then?", listOf(SideTurn("What are you working on?", "Retrying failed uploads."))))
        assertEquals(SideReply.Answering("q 1"), api.sideQuestion("agent 1", "q 1"))
        api.cancelSideQuestion("agent 1", "q 1")
        assertEquals(
            listOf(
                "POST" to "/v0/agents/agent%201/side-questions",
                "POST" to "/v0/agents/agent%201/side-questions",
                "GET" to "/v0/agents/agent%201/side-questions/q%201",
                "DELETE" to "/v0/agents/agent%201/side-questions/q%201",
            ),
            routes.asked.map { it.first to it.second },
        )
        // No history is no `history` key; with one, oldest first, each its question and response.
        assertEquals(json("""{"question":"Which file?"}"""), routes.asked[0].third)
        assertEquals(
            json("""{"question":"And then?","history":[{"question":"What are you working on?","response":"Retrying failed uploads."}]}"""),
            routes.asked[1].third,
        )
        assertTrue(routes.asked[1].third!!.jsonObject["history"] is JsonArray)
    }

    @Test fun `a refusal is its status and code, and a reply of no known shape is an invalid answer`() = runTest {
        val refused = ConversationApi(Routes { _, _ -> TransportResponse(409, body = """{"error":"No conversation yet.","code":"harness_not_running"}""".toByteArray()) }.request)
        val e = runCatching { refused.askSideQuestion("a1", "Which file?") }.exceptionOrNull() as ConversationApiException
        assertEquals(409, e.status)
        assertEquals("harness_not_running", e.code)
        val odd = ConversationApi(Routes { _, _ -> ok("""{"sideQuestion":{"id":"q1"}}""") }.request)
        val invalid = runCatching { odd.sideQuestion("a1", "q1") }.exceptionOrNull() as AgentConnectionException
        assertEquals(AgentConnectionException.Reason.InvalidResponse, invalid.reason)
        // A DELETE's answer, whatever its body says, is a success.
        ConversationApi(Routes { _, _ -> ok("""{"cancelled":false}""") }.request).cancelSideQuestion("a1", "q1")
        ConversationApi(Routes { _, _ -> TransportResponse(204) }.request).cancelSideQuestion("a1", "q1")
    }

    private class Health(val text: String) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())

        override suspend fun close() {}
    }

    @Test fun `health's capabilities say whether the computer serves side questions`() {
        val served = """{"ready":true,"version":{"protocol":30},"capabilities":{"search":true,"sideQuestions":true}}"""
        val older = """{"ready":true,"version":{"protocol":30},"capabilities":{"search":true}}"""
        val client = AgentClient(Health(served), "t")
        assertFalse("nothing is offered before health is read", client.sideQuestions)
        client.noteHealth(json(served))
        assertTrue(client.sideQuestions)
        client.noteHealth(json(older))
        assertFalse(client.sideQuestions)
        client.noteHealth(json("""{"ready":true,"version":{"protocol":30}}"""))
        assertFalse(client.sideQuestions)
        // The same flag from the identity read, as search's is.
        val info = AgentIdentity.bootstrap(json(served), null, "Mac")
        assertTrue(info.sideQuestions)
        assertFalse(AgentIdentity.bootstrap(json(older), null, "Mac").sideQuestions)
        client.noteHealth(info)
        assertTrue(client.sideQuestions)
    }

    @Test fun `health read on demand notes the flag too`() = runTest {
        val client = AgentClient(Health("""{"ready":true,"version":{"protocol":30},"capabilities":{"sideQuestions":true}}"""), "t")
        client.healthNow()
        assertTrue(client.sideQuestions)
    }
}
