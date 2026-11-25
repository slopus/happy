package com.slopus.happy.push

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.UUID

/**
 * After unpair the daemon holds no registration for this phone. The daemon
 * here is happy-agent's: every PUT gives the row a new version, and a
 * DELETE naming an older one answers 204 and keeps the row. (Grown from
 * the verifier's probes of #2095.)
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CloudPushUnpairTest {
    private class Daemon : Transport {
        val rows = linkedMapOf<String, String>()
        val asked = mutableListOf<String>()
        var hold: CompletableDeferred<Unit>? = null
        var down = false
        /** The daemon takes a registration and its answer never reaches the phone. */
        var lose = false
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            if (down) throw IOException("unreachable")
            val id = path.substringAfterLast('/')
            asked += "$method $id"
            return when (method) {
                "PUT" -> {
                    val version = UUID.randomUUID().toString()
                    rows[id] = version
                    if (lose) throw IOException("the answer never came")
                    hold?.await()
                    TransportResponse(200, emptyMap(), """{"registration":{"id":"$id","version":"$version","expiresAt":1796688000000}}""".toByteArray())
                }
                "DELETE" -> {
                    if (rows[id] == headers["If-Match"]) rows.remove(id)
                    TransportResponse(204, emptyMap(), ByteArray(0))
                }
                else -> TransportResponse(404, emptyMap(), "{}".toByteArray())
            }
        }
        override suspend fun close() {}
    }

    private val route = CloudPushFarewellRoute("tcAddress", 24781, "device-token")

    /** [disk] outlives a fixture, as the ledger outlives a process. */
    private inner class Fixture(scope: TestScope, first: List<CloudPushAccount>, val daemon: Daemon = Daemon(), disk: Array<String?> = arrayOfNulls(1)) {
        val accounts = MutableStateFlow(first)
        val foreground = MutableStateFlow(false)
        val ledger = CloudPushLedger({ disk[0] }, { disk[0] = it })
        // The clock stands before every registration here expires.
        val registrations = CloudPushRegistrations(ledger, { it in accounts.value }, clock = { 0 })
        val api = CloudPushApi(AgentClient(daemon, "device-token"))
        val sync = CloudPushSync(
            accounts, foreground, MutableSharedFlow(), registrations,
            api = { if (it in accounts.value) api else null },
            deviceTokens = { "native-one" },
            exchange = { HappyPushToken.parse("HappyPushToken[0123456789ABCDEFGHIJKL]")!! },
            notificationsAllowed = { true }, appId = "com.slopus.happy.dev", locale = { "en-US" },
            dispatcher = StandardTestDispatcher(scope.testScheduler),
            // The pairing's own way to its daemon: the same daemon, asked with what the route kept.
            farewell = { way ->
                assertEquals(route, way)
                CloudPushFarewellLink(CloudPushApi(AgentClient(daemon, way.deviceToken)))
            },
        )
        init { sync.start(scope.backgroundScope) }

        /** removeAgentConnection: the farewell while the connection can still ask, then the connection goes. */
        suspend fun unpair(account: CloudPushAccount) {
            registrations.leaving(account.connectionId, route)
            registrations.remove(account, api) { sync.renewal() }
            sync.retire()
            accounts.value = accounts.value - account
        }
        val left get() = "rows left: ${daemon.rows.keys} asked: ${daemon.asked}"
    }

    private val paired = CloudPushAccount("connection-paired", "k3x9q2m7p0a4b8c1d5e6f7g2", "standalone")

    @Test fun renewedInTheForegroundThenUnpairedLeavesNoRow() = runTest {
        val f = Fixture(this, listOf(paired))
        f.foreground.value = true; runCurrent()
        f.foreground.value = false; runCurrent()
        f.foreground.value = true; runCurrent()
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
    }

    @Test fun aRenewalTheDaemonTookWhileThePhoneWentToTheBackgroundLeavesNoRowAfterUnpair() = runTest {
        val f = Fixture(this, listOf(paired))
        f.foreground.value = true; runCurrent()
        f.foreground.value = false; runCurrent()
        val answer = CompletableDeferred<Unit>()
        f.daemon.hold = answer
        f.foreground.value = true; runCurrent()
        // The daemon renewed the row; the phone goes to the background before the answer arrives.
        f.foreground.value = false; runCurrent()
        f.daemon.hold = null
        val unpairing = launch { f.unpair(paired) }
        runCurrent()
        answer.complete(Unit)
        unpairing.join(); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
    }

    /** A trigger that fires again while a renewal is in flight neither doubles the row nor loses the version the daemon gave. */
    @Test fun aTriggerThatFiresWhileARenewalIsInFlightLeavesOneRowWhoseVersionThePhoneHolds() = runTest {
        val f = Fixture(this, listOf(paired))
        f.foreground.value = true; runCurrent()
        val answer = CompletableDeferred<Unit>()
        f.daemon.hold = answer
        f.foreground.value = false; runCurrent()
        f.foreground.value = true; runCurrent()
        // Held. The app goes away and comes back again before the answer.
        f.foreground.value = false; runCurrent()
        f.foreground.value = true; runCurrent()
        assertEquals("one renewal in flight, nothing beside it", 2, f.daemon.asked.size)
        f.daemon.hold = null
        answer.complete(Unit); runCurrent()
        assertEquals(f.left, 1, f.daemon.rows.size)
        val binding = f.ledger.snapshot().bindings.single()
        assertEquals("the phone holds the daemon's latest version", f.daemon.rows[binding.id], binding.registration!!.version)
        assertEquals(false, binding.unanswered)
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
    }

    /** The daemon took a renewal and its answer never came (a timeout, a dead process): only registering again names the row's version. */
    @Test fun aRenewalWhoseAnswerNeverCameLeavesNoRowAfterUnpair() = runTest {
        val f = Fixture(this, listOf(paired))
        f.foreground.value = true; runCurrent()
        f.daemon.lose = true
        f.foreground.value = false; runCurrent()
        f.foreground.value = true; runCurrent()
        f.daemon.lose = false
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
        assertTrue(f.ledger.snapshot().pending.isEmpty())
    }

    @Test fun aFirstRegistrationWhoseAnswerNeverCameLeavesNoRowAfterUnpair() = runTest {
        val f = Fixture(this, listOf(paired))
        f.daemon.lose = true
        f.foreground.value = true; runCurrent()
        assertEquals(f.left, 1, f.daemon.rows.size)
        f.daemon.lose = false
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
    }

    /** Both at once: the answer never came, and the daemon is unreachable at unpair. The next launch has only the ledger. */
    @Test fun aRenewalWhoseAnswerNeverCameIsRemovedAtTheNextLaunchWhenTheDaemonWasDownAtUnpair() = runTest {
        val disk = arrayOfNulls<String>(1)
        val f = Fixture(this, listOf(paired), disk = disk)
        f.foreground.value = true; runCurrent()
        f.daemon.lose = true
        f.foreground.value = false; runCurrent()
        f.foreground.value = true; runCurrent()
        f.daemon.lose = false
        f.daemon.down = true
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 1, f.daemon.rows.size)
        f.daemon.down = false
        val next = Fixture(this, emptyList(), f.daemon, disk)
        runCurrent()
        assertEquals(next.left, 0, f.daemon.rows.size)
        assertTrue(next.ledger.snapshot().pending.isEmpty())
        assertTrue("nothing of the pairing is kept once told", disk[0]!!.let { "device-token" !in it && "HappyPushToken" !in it })
    }

    /** A team's daemon: the pairing has no member, and no row, until the daemon names one; the row it then gets goes at unpair. */
    @Test fun aTeamPairingRegistersOnlyOnceItsMemberIsKnownAndLeavesNoRowAfterUnpair() = runTest {
        val f = Fixture(this, emptyList())
        f.foreground.value = true; runCurrent()
        assertTrue(f.left, f.daemon.asked.isEmpty())
        val member = paired.copy(userId = "member-one")
        f.accounts.value = listOf(member); runCurrent()
        assertEquals(f.left, 1, f.daemon.rows.size)
        f.foreground.value = false; runCurrent()
        f.foreground.value = true; runCurrent()
        f.unpair(member); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
    }

    @Test fun aDaemonThatCouldNotBeReachedAtUnpairIsToldWhenItIsBackWithTheAppStillRunning() = runTest {
        val f = Fixture(this, listOf(paired))
        f.foreground.value = true; runCurrent()
        f.daemon.down = true
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 1, f.daemon.rows.size)
        advanceTimeBy(60_000); runCurrent()
        assertEquals("still down", 1, f.daemon.rows.size)
        f.daemon.down = false
        // Asked again on its own, further and further apart, at most five minutes.
        advanceTimeBy(300_001); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
        assertTrue(f.ledger.snapshot().pending.isEmpty())
    }

    @Test fun aDaemonThatCouldNotBeReachedAtUnpairIsToldAtTheNextLaunch() = runTest {
        val disk = arrayOfNulls<String>(1)
        val f = Fixture(this, listOf(paired), disk = disk)
        f.foreground.value = true; runCurrent()
        f.daemon.down = true
        f.unpair(paired); runCurrent()
        assertEquals(f.left, 1, f.daemon.rows.size)
        f.daemon.down = false
        // A new process: no connection, only the ledger.
        val next = Fixture(this, emptyList(), f.daemon, disk)
        runCurrent()
        assertEquals(next.left, 0, f.daemon.rows.size)
        assertTrue(next.ledger.snapshot().pending.isEmpty())
    }

    /** The person leaves the app right after confirming: the farewell is already queued and is still sent. */
    @Test fun leavingTheAppRightAfterConfirmingStillTellsTheDaemon() = runTest {
        val f = Fixture(this, listOf(paired))
        f.foreground.value = true; runCurrent()
        val unpairing = launch { f.unpair(paired) }
        f.foreground.value = false
        runCurrent(); unpairing.join(); runCurrent()
        assertEquals(f.left, 0, f.daemon.rows.size)
    }
}
