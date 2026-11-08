package com.slopus.happy.connection

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.Mode
import io.tailcat.NodePublicKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.Collections

/** An agent connection's Tailcat clients by request category, and which category each request is. */
class TailcatClientsTest {
    private class Client(val category: RequestCategory, val key: NodePublicKey) {
        var closed = false
    }

    private val made = Collections.synchronizedList(mutableListOf<Client>())
    private val clients = TailcatClients(
        connect = { category, key -> Client(category, key.publicKey).also { made += it } },
        disconnect = { it.closed = true },
    )

    @Test fun diagnosticSnapshotContainsOnlyConnectedClientsAndNeverCreatesOne() = runBlocking {
        assertTrue(clients.connected().isEmpty())
        assertTrue(made.isEmpty())
        val query = clients.lease(RequestCategory.Query)
        assertEquals(listOf(RequestCategory.Query to query.client), clients.connected())
        clients.reset(query)
        assertEquals(1, clients.count(RequestCategory.Query))
        assertTrue(clients.connected().isEmpty())
        query.release()
        val replacement = clients.lease(RequestCategory.Query)
        assertEquals(listOf(RequestCategory.Query to replacement.client), clients.connected())
        clients.close()
        assertTrue(clients.connected().isEmpty())
    }

    private fun unavailable(block: suspend () -> Unit) = runBlocking {
        try {
            block()
            fail("expected Unavailable")
        } catch (e: AgentConnectionException) {
            assertEquals(AgentConnectionException.Reason.Unavailable, e.reason)
        }
    }

    @Test
    fun eachCategoryHasItsOwnClientUnderItsOwnNodeKey() = runBlocking {
        val realtime = clients.lease(RequestCategory.Realtime)
        val query = clients.lease(RequestCategory.Query)
        val file = clients.lease(RequestCategory.File)
        assertEquals(listOf(RequestCategory.Realtime, RequestCategory.Query, RequestCategory.File), made.map { it.category })
        assertEquals(3, made.map { it.key }.toSet().size)
        // A category's next request reuses its client, busy or not.
        assertSame(realtime.client, clients.lease(RequestCategory.Realtime).client)
        assertSame(query.client, clients.lease(RequestCategory.Query).client)
        file.release()
        assertSame(file.client, clients.lease(RequestCategory.File).client)
        assertEquals(3, made.size)
    }

    @Test
    fun backFromTheBackgroundEveryClientIsHandedBackAndNoneLetGo() = runBlocking {
        assertTrue(clients.connected().isEmpty())
        val realtime = clients.lease(RequestCategory.Realtime)
        val query = clients.lease(RequestCategory.Query)
        val upload = clients.lease(RequestCategory.File)
        realtime.release(); query.release()
        // Idle or carrying an upload, each is kept, to be woken.
        assertEquals(setOf(realtime.client, query.client, upload.client), clients.connected().map { it.second }.toSet())
        assertTrue(!realtime.client.closed && !query.client.closed && !upload.client.closed)
        // The next stream goes over the same client.
        assertSame(realtime.client, clients.lease(RequestCategory.Realtime).client)
        upload.release()
    }

    @Test
    fun filesSpreadOverAtMostEightClients() = runBlocking {
        val leases = (1..10).map { clients.lease(RequestCategory.File) }
        assertEquals(TailcatClients.MAX_FILE_CLIENTS, clients.count(RequestCategory.File))
        assertEquals(8, made.size)
        assertEquals(8, made.map { it.key }.toSet().size)
        // The first eight each took a client of their own; the two over the cap share the idlest.
        assertEquals(8, leases.take(8).map { it.client }.toSet().size)
        assertEquals(listOf(made[0], made[1]), leases.drop(8).map { it.client })
        // An idle client is used before any busy one.
        leases[5].release()
        assertSame(made[5], clients.lease(RequestCategory.File).client)
        // Nothing beyond the files' clients was made.
        assertEquals(0, clients.count(RequestCategory.Query))
    }

    @Test
    fun aFailedClientIsResetAloneAndReconnectsUnderANewKey() = runBlocking {
        val realtime = clients.lease(RequestCategory.Realtime)
        val query = clients.lease(RequestCategory.Query)
        val first = clients.lease(RequestCategory.File)
        val second = clients.lease(RequestCategory.File)
        assertNotSame(first.client, second.client)
        clients.reset(second)
        assertTrue(second.client.closed)
        assertEquals(listOf(false, false, false), listOf(realtime, query, first).map { it.client.closed })
        // The next file request goes to the idle place, which connects again under a key no client had.
        second.release()
        val again = clients.lease(RequestCategory.File)
        assertSame(second.slot, again.slot)
        assertNotSame(second.client, again.client)
        assertEquals(5, made.map { it.key }.toSet().size)
        // A late reset for the old failure leaves the new client be.
        clients.reset(second)
        assertEquals(false, again.client.closed)
        assertSame(realtime.client, clients.lease(RequestCategory.Realtime).client)
        assertSame(query.client, clients.lease(RequestCategory.Query).client)
    }

    @Test
    fun resettingACategoryLeavesTheOthers() = runBlocking {
        val realtime = clients.lease(RequestCategory.Realtime)
        val query = clients.lease(RequestCategory.Query)
        val files = (1..3).map { clients.lease(RequestCategory.File) }
        clients.reset(RequestCategory.File)
        assertTrue(files.all { it.client.closed })
        assertEquals(false, realtime.client.closed)
        assertEquals(false, query.client.closed)
        clients.reset(RequestCategory.Query)
        assertTrue(query.client.closed)
        assertEquals(false, realtime.client.closed)
        assertNotSame(query.client, clients.lease(RequestCategory.Query).client)
    }

    @Test
    fun closeClosesEveryClientAndNothingConnectsAfter() {
        runBlocking {
            clients.lease(RequestCategory.Realtime)
            clients.lease(RequestCategory.Query)
            clients.lease(RequestCategory.File)
            clients.lease(RequestCategory.File)
            clients.close()
            assertTrue(made.all { it.closed })
        }
        unavailable { clients.lease(RequestCategory.Query) }
        assertEquals(4, made.size)
    }

    @Test
    fun aClientThatConnectsAfterCloseIsClosed() = runBlocking {
        val connecting = CompletableDeferred<Unit>()
        val release = java.util.concurrent.CountDownLatch(1)
        val slow = TailcatClients(
            connect = { category, key -> connecting.complete(Unit); release.await(); Client(category, key.publicKey).also { made += it } },
            disconnect = { it.closed = true },
        )
        val lease = async(kotlinx.coroutines.Dispatchers.Default) { runCatching { slow.lease(RequestCategory.Query) } }
        connecting.await()
        slow.close()
        release.countDown()
        val failure = lease.await().exceptionOrNull() as? AgentConnectionException
        assertEquals(AgentConnectionException.Reason.Unavailable, failure?.reason)
        assertTrue(made.single().closed)
    }

    @Test
    fun aFailedConnectIsUnavailableAndTriedAgain() {
        var attempts = 0
        val flaky = TailcatClients(
            connect = { category, key -> if (++attempts == 1) throw IOException("relay down") else Client(category, key.publicKey) },
            disconnect = { it.closed = true },
        )
        unavailable { flaky.lease(RequestCategory.File) }
        runBlocking {
            flaky.lease(RequestCategory.File)
            assertEquals(1, flaky.count(RequestCategory.File))
        }
        assertEquals(2, attempts)
    }

    @Test
    fun theTransportPutsEachKindOfTrafficOnItsCategory() {
        val asked = Collections.synchronizedList(mutableListOf<RequestCategory>())
        val keys = Collections.synchronizedList(mutableListOf<NodePublicKey>())
        val transport = TailcatTransport(24781, 35_000, 15 * 60_000) { category, key ->
            asked += category
            keys += key.publicKey
            throw IOException("offline")
        }
        unavailable { transport.request("GET", "/v0/bootstrap/desktop", "token") }
        unavailable { transport.request("PUT", "/v0/profile/photo", "token", ByteArray(3), category = RequestCategory.File) }
        unavailable { transport.stream("/v0/events/stream", "token") }
        unavailable { transport.socket() }
        assertEquals(listOf(RequestCategory.Query, RequestCategory.File, RequestCategory.Realtime, RequestCategory.File), asked)
        assertEquals(4, keys.toSet().size)
    }

    /** What each request was sent as. */
    private class Recorder : Transport {
        val seen = Collections.synchronizedList(mutableListOf<Pair<String, RequestCategory>>())

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            seen += "$method ${path.substringBefore('?')}" to category
            val text = when {
                path.endsWith("/file") -> "{\"hash\":\"" + java.security.MessageDigest.getInstance("SHA-256").digest(byteArrayOf(1)).joinToString("") { "%02x".format(it) } + "\"}"
                path == "/v0/health" -> "{\"ready\":true,\"version\":{\"protocol\":99,\"daemon\":\"1\"}}"
                path == "/v0/config" -> "{\"config\":{\"node\":{\"name\":\"Studio\",\"avatar\":{\"thumbhash\":\"x\"}}}}"
                else -> "{}"
            }
            return TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        val resets = Collections.synchronizedList(mutableListOf<RequestCategory>())
        override suspend fun reset(category: RequestCategory) { resets += category }

        override suspend fun close() {}
    }

    @Test
    fun theEndpointPassesTheCategoryOn() = runBlocking {
        val base = Recorder()
        val endpoint = AgentEndpointTransport(AgentEndpoint(AgentConnectionCredentials("tailcat", 24781, "device", "token")) { }) { base }
        endpoint.request("GET", "/v0/agents/a1/files/x", "token", category = RequestCategory.File)
        endpoint.reset(RequestCategory.Realtime)
        assertEquals(listOf("GET /v0/agents/a1/files/x" to RequestCategory.File), base.seen)
        assertEquals(listOf(RequestCategory.Realtime), base.resets)
        endpoint.close()
    }

    @Test
    fun callSitesTagTheirCategory() = runBlocking {
        val agent = Recorder()
        val client = AgentClient(agent, "token")
        client.send("GET", "/v0/bootstrap/desktop")
        client.sendBytes("PUT", "/v0/profile/photo", byteArrayOf(1), mapOf("Content-Type" to "image/jpeg"))
        ArtifactClient(client).file("r1", 2, "report.md")
        val api = ConversationApi { method, path, body: JsonElement?, category -> client.send(method, path, body, category = category) }
        api.uploadFile("w1", "a.png", byteArrayOf(1))
        api.media("a1", "t1", 0)
        api.send("a1", "m1", "hi", emptyList(), Mode("anthropic", "opus", "high", null, "default"))
        api.send("a1", "m2", "", listOf(Block.Image("image/png", "AQ==")), Mode("anthropic", "opus", "high", null, "default"))
        AgentIdentity.refresh(agent, "token", "Studio")
        assertEquals(
            listOf(
                "GET /v0/bootstrap/desktop" to RequestCategory.Query,
                "PUT /v0/profile/photo" to RequestCategory.File,
                "GET /v0/artifacts/r1/versions/2/files/report.md" to RequestCategory.File,
                "PUT /v0/workspaces/w1/file" to RequestCategory.File,
                "GET /v0/agents/a1/tool-calls/t1/media/0" to RequestCategory.File,
                "POST /v0/agents/a1/send" to RequestCategory.Query,
                "POST /v0/agents/a1/send" to RequestCategory.File,
                "GET /v0/health" to RequestCategory.Query,
                "GET /v0/config" to RequestCategory.Query,
                "GET /v0/node/avatar" to RequestCategory.File,
            ),
            agent.seen,
        )
    }
}
