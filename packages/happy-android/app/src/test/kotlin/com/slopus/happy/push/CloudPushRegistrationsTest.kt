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
    private var now = 0L
    private fun manager() = CloudPushRegistrations(ledger, { it == account && signedIn }, { id }, { now })

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

    /**
     * A renewal the daemon took is one it gave a new version: cancelled on
     * the phone before its answer was kept, the unpair that follows names
     * the old version, and the daemon answers 204 and removes nothing.
     */
    @Test fun aRenewalCancelledInFlightIsStillFinishedAndItsVersionKept() = runTest {
        var liveVersion: String? = null
        val gate = CompletableDeferred<Unit>()
        val server = Server().apply { respond = { request ->
            if (request.method == "DELETE") {
                if (request.headers["If-Match"] == liveVersion) liveVersion = null
                204 to ""
            } else {
                val renewal = liveVersion != null
                liveVersion = if (renewal) nextVersion else version
                if (renewal) gate.await()
                registered(liveVersion!!)
            }
        } }
        val manager = manager()
        register(manager, api(server))
        val renewing = launch { register(manager, api(server)) }
        runCurrent()
        assertEquals(nextVersion, liveVersion)
        // Another trigger, or the background, cancels the work the renewal belongs to.
        renewing.cancel()
        runCurrent()
        val removing = launch { manager.remove(account, api(server)) }
        runCurrent()
        assertEquals("unpair waits for the renewal", listOf("PUT", "PUT"), server.asked.map { it.method })
        gate.complete(Unit)
        renewing.join(); removing.join()
        assertEquals(mapOf("If-Match" to nextVersion), server.asked.last().headers)
        assertNull("the daemon keeps no row", liveVersion)
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    private val route = CloudPushFarewellRoute("tcAddress", 24781, "device-token-secret")
    private val expiry = 1796688000000

    /** Its daemon could not be told at unpair: the farewell keeps that pairing's own way to it, until the daemon answers. */
    @Test fun aForgottenPairingsFarewellKeepsItsRouteUntilItsDaemonAnswers() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        server.respond = { 503 to "{}" }
        manager.leaving(account.connectionId, route)
        manager.remove(account, api(server))
        signedIn = false
        assertEquals(route, ledger.snapshot().pending.single().route)

        // A new process: nothing but the ledger is left of the pairing.
        val later = manager()
        val ways = mutableListOf<CloudPushFarewellRoute>()
        val daemon = Server().apply { respond = { 503 to "{}" } }
        assertTrue("still owed", later.retire { ways += it; CloudPushFarewellLink(api(daemon)) })
        assertEquals(1, ledger.snapshot().pending.size)
        daemon.respond = { 204 to "" }
        var closed = 0
        assertFalse("answered", later.retire { ways += it; CloudPushFarewellLink(api(daemon)) { closed++ } })
        assertEquals(listOf(route, route), ways)
        assertEquals(1, closed)
        assertEquals(listOf("DELETE", "DELETE"), daemon.asked.map { it.method })
        assertEquals(mapOf("If-Match" to version), daemon.asked.last().headers)
        assertTrue(ledger.snapshot().pending.isEmpty())
        assertFalse("the route goes with the farewell", disk!!.contains("device-token-secret"))
        assertFalse(later.retire { fail("nothing is owed"); CloudPushFarewellLink(api(daemon)) })
    }

    /** The desktop removed the phone meanwhile: the daemon answers, and asking again would change nothing. */
    @Test fun aFarewellRefusedForGoodIsNotAskedAgain() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        manager.leaving(account.connectionId, route)
        manager.remove(account, null)
        signedIn = false
        val daemon = Server().apply { respond = { 401 to "{}" } }
        assertFalse(manager.retire { CloudPushFarewellLink(api(daemon)) })
        assertTrue(ledger.snapshot().pending.isEmpty())
        assertFalse(disk!!.contains("device-token-secret"))
    }

    @Test fun aFarewellIsNotAskedPastItsRegistrationsOwnExpiry() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        manager.leaving(account.connectionId, route)
        manager.remove(account, null)
        signedIn = false
        val daemon = Server().apply { respond = { 503 to "{}" } }
        now = expiry - 1
        assertTrue(manager.retire { CloudPushFarewellLink(api(daemon)) })
        now = expiry
        assertFalse(manager.retire { fail("the daemon has dropped it by itself"); CloudPushFarewellLink(api(daemon)) })
        assertTrue(ledger.snapshot().pending.isEmpty())
        assertFalse(disk!!.contains("device-token-secret"))
    }

    /** A sign-in's credential is revoked at sign-out: nothing of it is kept, and its removal waits for the same member to sign in again. */
    @Test fun aSignInsRemovalKeepsNoCredentialAndIsNotAskedWithoutOne() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        manager.leaving(account.connectionId, null)
        manager.remove(account, null)
        signedIn = false
        assertNull(ledger.snapshot().pending.single().route)
        assertFalse(manager.retire { fail("no route to ask over"); CloudPushFarewellLink(api(server)) })
        assertEquals(1, ledger.snapshot().pending.size)
    }

    @Test fun nothingRegistersOnAConnectionThatIsBeingForgotten() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        manager.leaving(account.connectionId, route)
        assertFalse(register(manager, api(server)))
        assertTrue(server.asked.isEmpty())
        assertTrue(ledger.snapshot().bindings.isEmpty())
    }

    /** The unpair gave up waiting for a renewal in flight: when that lands with the connection gone, its removal still has the route. */
    @Test fun aRegistrationThatLandsAfterItsConnectionLeftGoesWithTheRoute() = runTest {
        val gate = CompletableDeferred<Unit>()
        val server = Server().apply { respond = { gate.await(); registered() } }
        val manager = manager()
        val registering = async { register(manager, api(server)) }
        runCurrent()
        manager.leaving(account.connectionId, route)
        signedIn = false
        gate.complete(Unit)
        assertFalse(registering.await())
        assertEquals(route, ledger.snapshot().pending.single().route)
    }

    @Test fun anAnswerSettlesARequestAndADaemonThatIsBusyOrDownDoesNot() {
        for (status in listOf(200, 204, 400, 401, 403, 404, 410)) assertTrue("$status", pushAnswerSettles(status))
        for (status in listOf(408, 429, 500, 502, 503, 504)) assertFalse("$status", pushAnswerSettles(status))
    }

    // The daemon took a registration and the phone never heard the answer: the row has a version only that answer named.

    /** happy-agent's rows: every PUT gives a new version, a DELETE naming another answers 204 and keeps the row. */
    private inner class Rows {
        var live: String? = null
        private var minted = 0
        val server = Server().apply { respond = { request ->
            if (request.method == "DELETE") {
                if (request.headers["If-Match"] == live) live = null
                204 to ""
            } else {
                live = listOf(version, nextVersion, thirdVersion)[minted++]
                if (lose) throw java.io.IOException("the answer never came")
                registered(live!!)
            }
        } }
        var lose = false
    }
    private val thirdVersion = "9d2f6c1e-0b7a-4f43-8a5e-6f2f1f6f2c11"
    private val renewal = CloudPushRenewal("HappyPushToken[0123456789ABCDEFGHIJKL]", "com.slopus.happy.dev", "en-US")

    @Test fun aRegistrationWhoseAnswerNeverCameIsRegisteredOnceMoreAndRemovedWithThatVersion() = runTest {
        val rows = Rows()
        val manager = manager()
        assertTrue(register(manager, api(rows.server)))
        rows.lose = true
        assertFalse(register(manager, api(rows.server)))
        assertEquals("the phone still holds the version before", version, ledger.snapshot().bindings.single().registration!!.version)
        assertTrue(ledger.snapshot().bindings.single().unanswered)
        rows.lose = false
        manager.remove(account, api(rows.server)) { renewal }
        assertEquals(listOf("PUT", "PUT", "PUT", "DELETE"), rows.server.asked.map { it.method })
        assertEquals(mapOf("If-Match" to thirdVersion), rows.server.asked.last().headers)
        assertNull("the daemon keeps no row", rows.live)
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    /** The very first registration: the phone has no version at all, and a row may be there. */
    @Test fun aFirstRegistrationWhoseAnswerNeverCameIsStillRemoved() = runTest {
        val rows = Rows().apply { lose = true }
        val manager = manager()
        assertFalse(register(manager, api(rows.server)))
        assertNull(ledger.snapshot().bindings.single().registration)
        rows.lose = false
        manager.remove(account, api(rows.server)) { renewal }
        assertEquals(listOf("PUT", "PUT", "DELETE"), rows.server.asked.map { it.method })
        assertNull(rows.live)
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    @Test fun anAnswerThatSettlesLeavesNothingUnsureAndSilenceDoes() = runTest {
        val server = Server().apply { respond = { registered() } }
        val manager = manager()
        register(manager, api(server))
        assertFalse(ledger.snapshot().bindings.single().unanswered)
        for (status in listOf(503, 429, 408)) {
            server.respond = { status to "{}" }
            assertFalse(register(manager, api(server)))
            assertTrue("$status", ledger.snapshot().bindings.single().unanswered)
        }
        // Refused: the daemon answered and changed nothing.
        server.respond = { 409 to "{}" }
        assertFalse(register(manager, api(server)))
        assertFalse(ledger.snapshot().bindings.single().unanswered)
        assertEquals(version, ledger.snapshot().bindings.single().registration!!.version)
        server.respond = { 204 to "" }
        val before = server.asked.size
        manager.remove(account, api(server)) { fail("nothing to register again for"); renewal }
        assertEquals(listOf("DELETE"), server.asked.drop(before).map { it.method })
    }

    /** The daemon was unreachable at unpair too: the farewell that outlives the pairing registers once more, then removes. */
    @Test fun aForgottenPairingsUnsureFarewellKeepsWhatItRegistersWithUntilItHasTheVersion() = runTest {
        val rows = Rows()
        val manager = manager()
        register(manager, api(rows.server))
        rows.lose = true
        register(manager, api(rows.server))
        manager.leaving(account.connectionId, route)
        manager.remove(account, null) { renewal }
        signedIn = false
        val queued = ledger.snapshot().pending.single()
        assertTrue(queued.putFirst)
        assertEquals(renewal, queued.renewal)
        rows.lose = false

        // The PUT is answered, the DELETE is not: the record now has the version, and nothing to register with.
        var answers = 0
        val real = rows.server.respond
        rows.server.respond = { request -> if (request.method == "DELETE" && answers++ == 0) 503 to "{}" else real(request) }
        val later = manager()
        assertTrue(later.retire { CloudPushFarewellLink(api(rows.server)) })
        val heard = ledger.snapshot().pending.single()
        assertFalse(heard.putFirst)
        assertNull(heard.renewal)
        assertEquals(thirdVersion, heard.registration.version)
        assertFalse(disk!!.contains("HappyPushToken"))
        assertFalse(later.retire { CloudPushFarewellLink(api(rows.server)) })
        assertEquals(listOf("PUT", "PUT", "PUT", "DELETE", "DELETE"), rows.server.asked.map { it.method })
        assertNull(rows.live)
        assertTrue(ledger.snapshot().pending.isEmpty())
        assertFalse(disk!!.contains("device-token-secret"))
    }

    /** No relay token to be had: what is known is all there is. A limit, not a fix. */
    @Test fun withNothingToRegisterWithAnUnsureFarewellSendsTheVersionItHasOrNothing() = runTest {
        val rows = Rows()
        val manager = manager()
        register(manager, api(rows.server))
        rows.lose = true
        register(manager, api(rows.server))
        rows.lose = false
        manager.remove(account, api(rows.server)) { null }
        assertEquals(mapOf("If-Match" to version), rows.server.asked.last().headers)
        assertEquals("the row the phone never heard of stays", nextVersion, rows.live)
        assertTrue(ledger.snapshot().pending.isEmpty())

        // And with no version ever heard, there is nothing to send.
        disk = null
        val first = Rows().apply { lose = true }
        val again = manager()
        register(again, api(first.server))
        first.lose = false
        again.remove(account, api(first.server)) { null }
        assertEquals(listOf("PUT"), first.server.asked.map { it.method })
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    /** A sign-in's record never holds the relay capability: whoever delivers it brings one. */
    @Test fun aSignInsUnsureRemovalRegistersOnceMoreWithWhatIsAtHandThen() = runTest {
        val rows = Rows()
        val manager = manager()
        register(manager, api(rows.server))
        rows.lose = true
        register(manager, api(rows.server))
        rows.lose = false
        manager.remove(account, null) { renewal }
        val queued = ledger.snapshot().pending.single()
        assertTrue(queued.putFirst)
        assertNull(queued.renewal)
        assertFalse(disk!!.contains("HappyPushToken"))
        manager.cleanup(account, api(rows.server)) { renewal }
        assertEquals(listOf("PUT", "PUT", "PUT", "DELETE"), rows.server.asked.map { it.method })
        assertNull(rows.live)
        assertTrue(ledger.snapshot().pending.isEmpty())
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