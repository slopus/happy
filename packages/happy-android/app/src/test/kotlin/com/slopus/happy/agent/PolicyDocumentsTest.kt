package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Happy Cloud server's instructions and security policy in its settings, and whether it serves them. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolicyDocumentsTest {
    private class Server(private val answers: Map<String, Pair<Int, String>>) : Transport {
        val asked = mutableListOf<Pair<String, String?>>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path" to body?.decodeToString()
            val (status, text) = answers["$method $path"] ?: (404 to """{"error":"Not found","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    @Test
    fun theCatalogSaysWhetherTheServerServesThem() {
        val owner = ServerPermissions.parse(Json.parseToJsonElement("""{"role":"owner","granted":["policy.edit"],"permissions":[{"id":"policy.edit","description":"d"},{"id":"content.write"}]}""").jsonObject)!!
        assertTrue(PolicyDocument.served(owner))
        assertTrue(owner.allows(Permission.POLICY_EDIT))
        val member = ServerPermissions.parse(Json.parseToJsonElement("""{"granted":["content.write"],"permissions":[{"id":"policy.edit"},{"id":"content.write"}]}""").jsonObject)!!
        assertTrue(PolicyDocument.served(member))
        assertFalse(member.allows(Permission.POLICY_EDIT))
        // Deployed before: no catalog at all.
        val before = ServerPermissions.parse(Json.parseToJsonElement("""{"granted":["content.write"]}""").jsonObject)!!
        assertFalse(PolicyDocument.served(before))
        assertFalse(PolicyDocument.served(ServerPermissions.Unknown))
    }

    @Test
    fun eachDocumentReadsAndWritesItsOwnRouteAndKey() = runBlocking {
        val server = Server(
            mapOf(
                "GET /v0/config/instructions" to (200 to """{"instructions":"Be kind."}"""),
                "GET /v0/config/security" to (200 to """{}"""),
                "PUT /v0/config/security" to (200 to """{"policy":"No deploys.\n"}"""),
            ),
        )
        val client = AgentClient(server, "t")
        assertEquals("Be kind.", PolicyDocument.Instructions.read(client))
        assertEquals("", PolicyDocument.Security.read(client))
        assertEquals("No deploys.\n", PolicyDocument.Security.write(client, "No deploys."))
        assertEquals("PUT /v0/config/security" to """{"policy":"No deploys."}""", server.asked.last())
        assertEquals(256 * 1024, PolicyDocument.Instructions.limit)
        assertEquals(32 * 1024, PolicyDocument.Security.limit)
    }

    @Test
    fun aChangeIsReadAgainOnlyWhileNothingTypedWaits() {
        val scope = TestScope(StandardTestDispatcher())
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 4)
        var text = "one"
        var typing = false
        val source = PolicyDocumentSource({ text }, { it }, events, scope, typing = { typing })
        scope.runCurrent()
        assertEquals("one", source.current.value.saved)
        text = "two"
        typing = true
        events.tryEmit(AgentEvent(null, "config.updated", kotlinx.serialization.json.JsonObject(emptyMap())))
        scope.runCurrent()
        assertEquals("one", source.current.value.saved)
        typing = false
        events.tryEmit(AgentEvent(null, "config.updated", kotlinx.serialization.json.JsonObject(emptyMap())))
        scope.runCurrent()
        assertEquals("two", source.current.value.saved)
    }

    @Test
    fun aRefusedSaveSaysWhy() = runBlocking {
        suspend fun refusal(status: Int): PolicyDocumentSource.Problem? {
            val scope = TestScope(StandardTestDispatcher())
            val source = PolicyDocumentSource({ "" }, { throw AgentApiException(status, null, "no") }, MutableSharedFlow(), scope)
            assertFalse(source.save("x"))
            return source.current.value.problem
        }
        assertEquals(PolicyDocumentSource.Problem.NotAllowed, refusal(403))
        assertEquals(PolicyDocumentSource.Problem.TooLong, refusal(400))
        assertEquals(PolicyDocumentSource.Problem.Failed, refusal(500))
    }
}
