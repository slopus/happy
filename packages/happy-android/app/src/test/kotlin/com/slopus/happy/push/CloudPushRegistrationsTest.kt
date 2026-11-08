package com.slopus.happy.push

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudPushRegistrationsTest {
    private val account = CloudPushAccount("connection-one", "https://one.example", "member-one")
    private val id = "4470b26d-5c8b-4921-9aad-b0a9a62a17a3"
    private val version = "24e65a60-b9a8-4ba4-9605-05d942595948"
    private val nextVersion = "e5b987fe-3693-4ffc-8194-25e954b1615a"
    private val token = HappyPushToken.parse("HappyPushToken[0123456789ABCDEFGHIJKL]")!!
    private var disk: String? = null
    private val ledger = CloudPushLedger({ disk }, { disk = it })
    private var signedIn = true
    private fun manager() = CloudPushRegistrations(ledger, { it == account && signedIn }, { id })

    private class Server : Transport {
        data class Asked(val method: String, val path: String, val headers: Map<String, String>)
        val asked = mutableListOf<Asked>()
        var respond: suspend (Asked) -> Pair<Int, String> = { 204 to "" }
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            val request = Asked(method, path, headers)
            asked += request
            val (status, answer) = respond(request)
            return TransportResponse(status, mapOf("content-type" to "application/json"), answer.toByteArray())
        }
        override suspend fun close() {}
    }
    private fun registered(version: String = this.version) = 200 to """{"registration":{"id":"$id","version":"$version","expiresAt":1796688000000}}"""
    private fun api(server: Server) = CloudPushApi(AgentClient(server, "member-bearer", cloud = true))
    private suspend fun register(manager: CloudPushRegistrations, api: CloudPushApi) = manager.register(account, api, token, "com.slopus.happy.dev", "en-US")

    @Test fun separateRegistrationIdentityPersistsAcrossManagerRestartWithoutCapabilities() = runTest {
        val server = Server().apply { respond = { registered() } }
        assertTrue(register(manager(), api(server)))
        assertTrue(register(manager(), api(server)))
        assertEquals(listOf("/v0/cloud/push/registrations/$id", "/v0/cloud/push/registrations/$id"), server.asked.map { it.path })
        assertEquals(version, ledger.snapshot().bindings.single().registration!!.version)
        assertFalse(disk!!.contains("HappyPushToken"))
        assertFalse(disk!!.contains("bearer"))
        assertFalse(disk!!.contains("deviceId"))
        assertFalse(disk!!.contains("refresh"))
    }

    @Test fun offlineRemovalIsDurableAndOnlyMatchingMemberServerMayCleanIt() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        manager.remove(account, null)
        assertTrue(ledger.snapshot().bindings.isEmpty())
        assertEquals(1, ledger.snapshot().pending.size)
        signedIn = false
        manager().cleanup(account, api(server))
        val otherAccounts = CloudPushRegistrations(ledger, { true }, { id })
        otherAccounts.cleanup(account.copy(userId = "other"), api(server))
        otherAccounts.cleanup(account.copy(server = "https://two.example"), api(server))
        assertEquals(1, server.asked.size)
        signedIn = true
        server.respond = { 204 to "" }
        manager().cleanup(account, api(server))
        assertTrue(ledger.snapshot().pending.isEmpty())
        assertEquals(mapOf("If-Match" to version), server.asked.last().headers)
    }

    @Test fun delayedCleanupCannotDeleteNewlyRenewedVersion() = runTest {
        var liveVersion: String? = version
        val server = Server().apply { respond = { request ->
            if (request.method == "DELETE") {
                if (request.headers["If-Match"] == liveVersion) liveVersion = null
                204 to ""
            } else registered(liveVersion!!)
        } }
        val manager = manager()
        register(manager, api(server))
        manager.remove(account, null)
        liveVersion = nextVersion
        // Reuse of an ID is safe too: deletion carries only the retired version.
        register(manager, api(server))
        manager.cleanup(account, api(server))
        assertEquals(nextVersion, liveVersion)
        assertEquals(nextVersion, ledger.snapshot().bindings.single().registration!!.version)
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    @Test fun removalQueuesBeforeAttemptAndKeepsPendingAfterFailure() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        server.respond = {
            assertTrue(ledger.snapshot().bindings.isEmpty())
            assertEquals(version, ledger.snapshot().pending.single().registration.version)
            503 to "{}"
        }
        manager.remove(account, api(server))
        assertEquals(1, ledger.snapshot().pending.size)
        assertEquals("DELETE", server.asked.last().method)
    }

    @Test fun logoutDuringRegistrationKeepsAcknowledgedVersionForCleanup() = runTest {
        val gate = CompletableDeferred<Unit>()
        val server = Server().apply { respond = { gate.await(); registered() } }
        val manager = manager()
        val registering = async { register(manager, api(server)) }
        runCurrent()
        signedIn = false
        gate.complete(Unit)
        assertFalse(registering.await())
        assertTrue(ledger.snapshot().bindings.isEmpty())
        assertEquals(version, ledger.snapshot().pending.single().registration.version)
    }

    @Test fun registerAndRemoveSerializePerBinding() = runTest {
        val gate = CompletableDeferred<Unit>()
        val server = Server().apply { respond = { request ->
            if (request.method == "PUT") { gate.await(); registered() } else 204 to ""
        } }
        val manager = manager()
        val registering = launch { register(manager, api(server)) }
        runCurrent()
        val removing = launch { manager.remove(account, api(server)) }
        runCurrent()
        assertEquals(1, server.asked.size)
        gate.complete(Unit)
        registering.join(); removing.join()
        assertEquals(listOf("PUT", "DELETE"), server.asked.map { it.method })
        assertTrue(ledger.snapshot().bindings.isEmpty())
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    @Test fun removalUsesNewestAcknowledgedVersion() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        server.respond = { registered(nextVersion) }
        register(manager, api(server))
        server.respond = { 204 to "" }
        manager.remove(account, api(server))
        assertEquals(mapOf("If-Match" to nextVersion), server.asked.last().headers)
        assertEquals(3, server.asked.size)
        assertTrue(ledger.snapshot().bindings.isEmpty())
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    @Test fun unauthenticatedRegistrationAndCorruptLedgerFailClosed() = runTest {
        val server = Server()
        signedIn = false
        assertFalse(register(manager(), api(server)))
        assertNull(disk)
        signedIn = true
        disk = "corrupt"
        assertThrows(Exception::class.java) { kotlinx.coroutines.runBlocking { register(manager(), api(server)) } }
        assertTrue(server.asked.isEmpty())
    }
}