package com.slopus.happy.push

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudPushSyncTest {
    private val first = CloudPushAccount("one", "https://one.example", "member-one")
    private val second = CloudPushAccount("two", "https://two.example", "member-two")
    private class Server : Transport {
        val asked = mutableListOf<String>()
        var fail = false
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            if (fail) return TransportResponse(503, emptyMap(), "{}".toByteArray())
            val json = if (method == "PUT") """{"registration":{"id":"${path.substringAfterLast('/')}","version":"24e65a60-b9a8-4ba4-9605-05d942595948","expiresAt":1796688000000}}""" else ""
            return TransportResponse(if (method == "PUT") 200 else 204, emptyMap(), json.toByteArray())
        }
        override suspend fun close() {}
    }
    private inner class Fixture(scope: TestScope) {
        val accounts = MutableStateFlow(listOf(first))
        val foreground = MutableStateFlow(false)
        val network = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        var allowed = true
        var native: String? = "native-one"
        var tokenReads = 0
        val exchanges = mutableListOf<String>()
        val registered = mutableListOf<String>()
        var exchanging: suspend () -> Unit = {}
        val servers = mapOf(first to Server(), second to Server())
        private var disk: String? = null
        val ledger = CloudPushLedger({ disk }, { disk = it })
        val registrations = CloudPushRegistrations(ledger, { it in accounts.value })
        val sync = CloudPushSync(
            accounts, foreground, network, registrations,
            api = { servers[it]?.let { server -> CloudPushApi(AgentClient(server, "bearer", cloud = true)) } },
            deviceTokens = { tokenReads++; native },
            exchange = { exchanges += it; exchanging(); HappyPushToken.parse("HappyPushToken[0123456789ABCDEFGHIJKL]")!! },
            notificationsAllowed = { allowed }, appId = "com.slopus.happy.dev", locale = { "en-US" },
            dispatcher = StandardTestDispatcher(scope.testScheduler),
            registered = { registered += it.connectionId },
        )
        init { sync.start(scope.backgroundScope) }
    }

    @Test fun foregroundRenewsCloudBindingButReusesStableRelayExchange() = runTest {
        val f = Fixture(this)
        runCurrent()
        assertEquals(0, f.tokenReads)
        f.foreground.value = true
        runCurrent()
        assertEquals(1, f.servers.getValue(first).asked.size)
        f.foreground.value = false
        runCurrent()
        f.foreground.value = true
        runCurrent()
        assertEquals(2, f.servers.getValue(first).asked.size)
        assertEquals(listOf("native-one"), f.exchanges)
        f.sync.start(backgroundScope)
        runCurrent()
        assertEquals(2, f.servers.getValue(first).asked.size)
    }

    @Test fun noPermissionMeansNoTokenReadOrRegistrationUntilExplicitRefresh() = runTest {
        val f = Fixture(this)
        f.allowed = false
        f.foreground.value = true
        runCurrent()
        assertEquals(0, f.tokenReads)
        assertTrue(f.servers.getValue(first).asked.isEmpty())
        f.allowed = true
        f.sync.refresh()
        runCurrent()
        assertEquals(1, f.servers.getValue(first).asked.size)
        f.allowed = false
        f.sync.refresh()
        runCurrent()
        assertTrue(f.servers.getValue(first).asked.last().startsWith("DELETE "))
        assertTrue(f.ledger.snapshot().bindings.isEmpty())
    }

    @Test fun nativeRotationCanRenewWhileBackgroundedWithoutStartingAPollLoop() = runTest {
        val f = Fixture(this)
        f.foreground.value = true
        runCurrent()
        f.foreground.value = false
        runCurrent()
        f.native = "native-two"
        f.sync.refresh(native = true)
        runCurrent()
        assertEquals(listOf("native-one", "native-two"), f.exchanges)
        assertEquals(2, f.servers.getValue(first).asked.size)
        f.sync.refresh()
        runCurrent()
        assertEquals(2, f.servers.getValue(first).asked.size)
    }

    @Test fun nativeCallbackCanStartAColdBackgroundProcess() = runTest {
        val f = Fixture(this)
        f.sync.refresh(native = true)
        runCurrent()
        assertFalse(f.foreground.value)
        assertEquals(1, f.servers.getValue(first).asked.size)
    }

    @Test fun disappearedConnectionRetiresAndSameMemberReturnCleansBeforeRenewing() = runTest {
        val f = Fixture(this)
        f.foreground.value = true
        runCurrent()
        f.accounts.value = emptyList()
        runCurrent()
        assertTrue(f.ledger.snapshot().bindings.isEmpty())
        assertEquals(1, f.ledger.snapshot().pending.size)
        f.accounts.value = listOf(first)
        runCurrent()
        assertEquals(listOf("PUT", "DELETE", "PUT"), f.servers.getValue(first).asked.map { it.substringBefore(' ') })
        assertTrue(f.ledger.snapshot().pending.isEmpty())
    }

    @Test fun networkReturnRetriesAuthorizedCleanupEvenInBackground() = runTest {
        val f = Fixture(this)
        f.foreground.value = true
        runCurrent()
        f.foreground.value = false
        f.accounts.value = emptyList()
        runCurrent()
        f.accounts.value = listOf(first)
        runCurrent()
        assertEquals(1, f.ledger.snapshot().pending.size)
        f.network.emit(Unit)
        runCurrent()
        assertEquals(listOf("PUT", "DELETE"), f.servers.getValue(first).asked.map { it.substringBefore(' ') })
        assertTrue(f.ledger.snapshot().pending.isEmpty())
    }

    @Test fun oneFailingServerDoesNotPreventAnotherAccountsRegistration() = runTest {
        val f = Fixture(this)
        f.accounts.value = listOf(first, second)
        f.servers.getValue(first).fail = true
        f.foreground.value = true
        runCurrent()
        assertEquals(1, f.servers.getValue(first).asked.size)
        assertEquals(1, f.servers.getValue(second).asked.size)
        assertEquals(listOf("native-one"), f.exchanges)
        assertNotNull(f.ledger.snapshot().bindings.first { it.account == second }.registration)
    }

    @Test fun backgroundingCancelsInFlightExchangeAndNoAccountsNeverReadsNativeToken() = runTest {
        val f = Fixture(this)
        f.accounts.value = emptyList()
        f.foreground.value = true
        runCurrent()
        assertEquals(0, f.tokenReads)
        var cancelled = false
        f.exchanging = { try { awaitCancellation() } finally { cancelled = true } }
        f.accounts.value = listOf(first)
        runCurrent()
        f.foreground.value = false
        runCurrent()
        assertTrue(cancelled)
        assertTrue(f.servers.getValue(first).asked.isEmpty())
    }

    @Test fun eachRegistrationTheServerTookIsToldAndAFailedOneIsnt() = runTest {
        val f = Fixture(this)
        f.accounts.value = listOf(first, second)
        f.servers.getValue(second).fail = true
        f.foreground.value = true
        runCurrent()
        assertEquals(listOf("one"), f.registered)
        f.servers.getValue(second).fail = false
        f.sync.refresh()
        runCurrent()
        assertEquals(listOf("one", "one", "two"), f.registered)
    }
}
