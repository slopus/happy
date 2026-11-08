package com.slopus.happy.push

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class CloudPushApiTest {
    private val id = "4470b26d-5c8b-4921-9aad-b0a9a62a17a3"
    private val version = "24e65a60-b9a8-4ba4-9605-05d942595948"
    private val token = "HappyPushToken[0123456789ABCDEFGHIJKL]"
    private val settings = """{"enabled":true,"hideMessageContent":true,"turnComplete":true,"needsInput":false,"messages":true}"""
    private val registration = CloudPushRegistration(id, version, 1_796_688_000_000)
    private fun registered() = """{"registration":{"id":"$id","version":"$version","expiresAt":1796688000000}}"""

    private data class Asked(val method: String, val path: String, val body: String?, val headers: Map<String, String>)
    private class Server : Transport {
        val asked = mutableListOf<Asked>()
        var status = 200
        var body = "{}"
        var cancel = false
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            assertEquals("server-bearer", credential)
            asked += Asked(method, path, body?.decodeToString(), headers)
            if (cancel) throw CancellationException()
            return TransportResponse(status, mapOf("content-type" to "application/json"), this.body.toByteArray())
        }
        override suspend fun close() {}
    }
    private fun api(server: Server) = CloudPushApi(AgentClient(server, "server-bearer", cloud = true))

    @Test fun registrationExposesOnlyWrapperAndContractMetadata() = runTest {
        val server = Server().apply { body = registered() }
        assertEquals(registration, api(server).register(id, HappyPushToken.parse(token)!!, "com.slopus.happy.dev", "en-US"))
        assertEquals(Asked("PUT", "/v0/cloud/push/registrations/$id", """{"token":"$token","platform":"android","appId":"com.slopus.happy.dev","locale":"en-US"}""", emptyMap()), server.asked.single())
    }

    @Test fun unregisterAndViewUseExactOpaqueVersionAndExplicitNull() = runTest {
        val server = Server().apply { status = 204 }
        val api = api(server)
        api.unregister(registration)
        api.view(registration, "agent-1")
        api.view(registration, null)
        assertEquals(listOf("DELETE", "PUT", "PUT"), server.asked.map { it.method })
        assertEquals(listOf(null, """{"agentId":"agent-1"}""", """{"agentId":null}"""), server.asked.map { it.body })
        assertTrue(server.asked.all { it.headers == mapOf("If-Match" to version) })
        assertTrue(server.asked.drop(1).all { it.path == "/v0/cloud/push/registrations/$id/view" })
    }

    @Test fun settingsRequireAllFiveBooleansAndRoundTripUnchanged() = runTest {
        val server = Server().apply { body = settings }
        val api = api(server)
        val result = api.settings()
        assertEquals(CloudPushSettings(true, true, true, false, true), result)
        assertEquals(result, api.settings(result))
        assertEquals(settings, server.asked.last().body)
        for (invalid in listOf("{}", settings.replace("\"hideMessageContent\":true,", ""), settings.replace("\"hideMessageContent\":true", "\"hideMessageContent\":null"))) {
            server.body = invalid
            assertThrows(CloudPushException::class.java) { kotlinx.coroutines.runBlocking { api.settings() } }
        }
    }

    @Test fun mismatchedOrMalformedRegistrationIsRejectedWithoutEchoingBody() = runTest {
        val server = Server()
        for (body in listOf(registered().replace(id, version), registered().replace(version, "bad-version"), registered().replace("1796688000000", "0"), """{"token":"$token"}""")) {
            server.body = body
            val error = assertThrows(CloudPushException::class.java) {
                kotlinx.coroutines.runBlocking { api(server).register(id, HappyPushToken.parse(token)!!, "com.slopus.happy.preview", null) }
            }
            assertEquals("Cloud push request failed", error.message)
            assertNull(error.cause)
        }
    }

    @Test fun staleViewConflictIsExposedWithoutBlindRetryOrServerErrorBody() = runTest {
        val server = Server().apply { status = 409; body = """{"error":{"code":"stale","message":"$token"}}""" }
        val error = assertThrows(CloudPushException::class.java) { kotlinx.coroutines.runBlocking { api(server).view(registration, "a1") } }
        assertEquals(409, error.status)
        assertEquals("Cloud push request failed", error.message)
        assertNull(error.cause)
        assertEquals(1, server.asked.size)
    }

    @Test fun localConnectionsAndInvalidIdsCannotRegister() = runTest {
        val server = Server()
        assertThrows(IllegalArgumentException::class.java) { CloudPushApi(AgentClient(server, "server-bearer")) }
        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking { api(server).register("../other", HappyPushToken.parse(token)!!, "com.slopus.happy.dev", null) }
        }
        assertTrue(server.asked.isEmpty())
    }

    @Test fun cancellationRemainsCancellation() = runTest {
        val server = Server().apply { cancel = true }
        assertThrows(CancellationException::class.java) { kotlinx.coroutines.runBlocking { api(server).settings() } }
    }
}