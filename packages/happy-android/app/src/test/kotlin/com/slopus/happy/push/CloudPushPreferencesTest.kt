package com.slopus.happy.push

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class CloudPushPreferencesTest {
    private class Server : Transport {
        var enabled = true
        var fail = false
        var cancel = false
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            if (cancel) throw CancellationException()
            if (fail) return TransportResponse(503, emptyMap(), "{}".toByteArray())
            if (method == "PUT") enabled = body!!.decodeToString() == """{"enabled":true}"""
            return TransportResponse(200, emptyMap(), """{"enabled":$enabled}""".toByteArray())
        }
        override suspend fun close() {}
    }
    private fun source(server: Server) = CloudPushPreferences(CloudPushApi(AgentClient(server, "member", cloud = true)))

    @Test fun loadsAndReplacesOnlyTheMasterPreference() = runTest {
        val server = Server()
        val source = source(server)
        assertEquals(CloudPushPreferences.State.Loading, source.state.value)
        source.refresh()
        source.set(false)
        assertFalse(server.enabled)
        assertEquals(CloudPushPreferences.State.Loaded(CloudPushSettings(false)), source.state.value)
        assertEquals(listOf("GET /v0/cloud/push/settings", "PUT /v0/cloud/push/settings"), server.asked)
    }

    @Test fun failedReadOrWriteNeverInventsAnEnabledState() = runTest {
        val server = Server().apply { fail = true }
        val source = source(server)
        source.refresh()
        assertEquals(CloudPushPreferences.State.Failed, source.state.value)
        source.set(true)
        assertEquals(1, server.asked.size)
        server.fail = false
        source.refresh()
        server.fail = true
        source.set(false)
        assertEquals(CloudPushPreferences.State.Failed, source.state.value)
    }

    @Test fun cancelledWriteRestoresNonSavingStateAndPropagatesCancellation() = runTest {
        val server = Server()
        val source = source(server)
        source.refresh()
        server.cancel = true
        assertThrows(CancellationException::class.java) { kotlinx.coroutines.runBlocking { source.set(false) } }
        assertEquals(CloudPushPreferences.State.Loaded(CloudPushSettings(true)), source.state.value)
    }
}