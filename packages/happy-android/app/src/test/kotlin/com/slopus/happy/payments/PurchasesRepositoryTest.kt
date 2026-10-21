package com.slopus.happy.payments

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PurchasesRepositoryTest {
    private val a = PurchaseAccount("https://server-a", "account-a")
    private val b = PurchaseAccount("https://server-b", "account-b")
    private val pro = Purchases(listOf("happy:monthly"), mapOf("pro" to true, "expired" to false))

    private class Client(override val enabled: Boolean = true) : PurchasesClient {
        val events = mutableListOf<String>()
        var info = Purchases()
        var available = true
        var read: suspend () -> Purchases = { info }
        override suspend fun identify(appUserId: String) { events += "identify:$appUserId" }
        override suspend fun refresh(): Purchases { events += "refresh"; return read() }
        override suspend fun canPresent(): Boolean = available
        override suspend fun logout() { events += "logout" }
    }

    private class Cache : PurchasesCache {
        var entry: Pair<PurchaseAccount, Purchases>? = null
        override fun load(account: PurchaseAccount) = entry?.takeIf { it.first == account }?.second ?: Purchases()
        override fun save(account: PurchaseAccount, purchases: Purchases) { entry = account to purchases }
        override fun clear() { entry = null }
    }

    @Test fun startupAndForegroundRefreshPreserveProductIdsAndInactiveEntitlements() = runTest {
        val sdk = Client().apply { info = pro }
        val repository = PurchasesRepository(this, sdk)
        repository.setAccount(a)
        advanceUntilIdle()
        assertEquals(pro, repository.purchases.value)
        assertTrue(repository.hasPro())
        repository.setAccount(a)
        advanceUntilIdle()
        assertEquals(listOf("identify:account-a", "refresh"), sdk.events)
        sdk.info = Purchases(entitlements = mapOf("pro" to false))
        repository.refresh()
        advanceUntilIdle()
        assertFalse(repository.hasPro())
        assertEquals(2, sdk.events.count { it == "refresh" })
    }

    @Test fun missingKeyOrSignedOutCannotShowPaywallOrSync() = runTest {
        val sdk = Client(enabled = false)
        val repository = PurchasesRepository(this, sdk)
        repository.attachHost()
        repository.setAccount(a)
        assertEquals(PaywallOutcome(false, error = "RevenueCat not initialized"), repository.present("voluntary_support"))
        advanceUntilIdle()
        assertTrue(sdk.events.isEmpty())
        assertEquals(Purchases(), repository.purchases.value)
        val signedOut = PurchasesRepository(this, Client())
        assertFalse(signedOut.present(null).success)
    }

    @Test fun purchaseAndRestoreRefreshBeforeReturningAndDuplicateDismissDoesNotEraseSuccess() = runTest {
        for (flow in listOf("voluntary_support", "voice_must_pay")) {
            val sdk = Client()
            val repository = PurchasesRepository(this, sdk)
            repository.attachHost()
            repository.setAccount(a)
            advanceUntilIdle()
            val result = async { repository.presentPaywall(flow) }
            runCurrent()
            val pending = repository.request.value!!
            assertEquals(flow, pending.flow)
            sdk.info = pro
            pending.complete(PaywallOutcome(true, purchased = true), pro)
            pending.complete(PurchasesRepository.Cancelled)
            assertEquals(PaywallOutcome(true, purchased = true), result.await())
            assertEquals(pro, repository.purchases.value)
            assertEquals(2, sdk.events.count { it == "refresh" })
            assertNull(repository.request.value)
        }
    }

    @Test fun dismissalIsSuccessfulAndDoesNotRefresh() = runTest {
        val sdk = Client()
        val repository = PurchasesRepository(this, sdk)
        repository.attachHost()
        repository.setAccount(a)
        advanceUntilIdle()
        val result = async { repository.present("voice_trial_eligible") }
        runCurrent()
        repository.request.value!!.complete(PurchasesRepository.Cancelled)
        assertEquals(PaywallOutcome(success = true, purchased = false), result.await())
        assertEquals(1, sdk.events.count { it == "refresh" })
    }

    @Test fun successfulNativeInfoSurvivesOptionalRefreshFailure() = runTest {
        val sdk = Client()
        val repository = PurchasesRepository(this, sdk)
        repository.attachHost()
        repository.setAccount(a)
        advanceUntilIdle()
        sdk.read = { error("offline") }
        val result = async { repository.present(null) }
        runCurrent()
        repository.request.value!!.complete(PaywallOutcome(true, purchased = true), pro)
        assertTrue(result.await().purchased)
        assertEquals(pro, repository.purchases.value)
    }

    @Test fun logoutClearsCacheAndRejectsLateRefreshBeforeLoggingOutSdk() = runTest {
        val cache = Cache()
        val sdk = Client().apply { info = pro }
        val repository = PurchasesRepository(this, sdk, cache)
        repository.setAccount(a)
        advanceUntilIdle()
        assertNotNull(cache.entry)
        val late = CompletableDeferred<Purchases>()
        sdk.read = { late.await() }
        repository.refresh()
        runCurrent()
        repository.setAccount(null)
        assertEquals(Purchases(), repository.purchases.value)
        assertNull(cache.entry)
        late.complete(pro)
        advanceUntilIdle()
        assertEquals(Purchases(), repository.purchases.value)
        assertNull(cache.entry)
        assertEquals("logout", sdk.events.last())
    }

    @Test fun accountAndServerSwitchInvalidateAnOpenPaywallAndLateNativeCallback() = runTest {
        for (next in listOf(b, a.copy(serverUrl = "https://another-server"))) {
            val sdk = Client()
            val repository = PurchasesRepository(this, sdk)
            repository.attachHost()
            repository.setAccount(a)
            advanceUntilIdle()
            val result = async { repository.present(null) }
            runCurrent()
            val oldRequest = repository.request.value!!
            repository.setAccount(next)
            assertNull(repository.request.value)
            assertEquals(Purchases(), repository.purchases.value)
            oldRequest.complete(PaywallOutcome(true, purchased = true), pro)
            assertEquals(PurchasesRepository.Cancelled, result.await())
            advanceUntilIdle()
            assertFalse(repository.hasPro())
            assertEquals("identify:${next.appUserId}", sdk.events[sdk.events.lastIndex - 1])
        }
    }

    @Test fun roundTripAccountChangeCannotAcceptFirstGenerationsRefresh() = runTest {
        val sdk = Client()
        val repository = PurchasesRepository(this, sdk)
        repository.setAccount(a)
        advanceUntilIdle()
        val late = CompletableDeferred<Purchases>()
        sdk.read = { late.await() }
        repository.refresh()
        runCurrent()
        repository.setAccount(b)
        repository.setAccount(a)
        sdk.read = { Purchases() }
        late.complete(pro)
        advanceUntilIdle()
        assertFalse(repository.hasPro())
    }

    @Test fun providerGuardCatchesAuthChangeBeforeCollectorRuns() = runTest {
        val sdk = Client().apply { info = pro }
        var actual: PurchaseAccount? = a
        val repository = PurchasesRepository(this, sdk, currentAccount = { actual })
        repository.setAccount(a)
        advanceUntilIdle()
        assertTrue(repository.hasPro())
        actual = b
        assertFalse(repository.hasPro())
        assertEquals(Purchases(), repository.purchases.value)
        sdk.info = Purchases()
        advanceUntilIdle()
        actual = null
        assertFalse(repository.present(null).success)
        advanceUntilIdle()
    }

    @Test fun concurrentPresentationIsRejectedAndDetachingHostCancelsFirst() = runTest {
        val repository = PurchasesRepository(this, Client())
        val detach = repository.attachHost()
        repository.setAccount(a)
        advanceUntilIdle()
        val first = async { repository.present(null) }
        runCurrent()
        assertEquals("Paywall already presented", repository.present(null).error)
        detach()
        assertEquals(PurchasesRepository.Cancelled, first.await())
        assertNull(repository.request.value)
        assertEquals("Paywall not available on this platform", repository.present(null).error)
    }

    @Test fun callerCancellationRemovesUiAndAllowsAnotherPresentation() = runTest {
        val repository = PurchasesRepository(this, Client())
        repository.attachHost()
        repository.setAccount(a)
        advanceUntilIdle()
        val first = async { repository.present(null) }
        runCurrent()
        first.cancel()
        runCurrent()
        assertNull(repository.request.value)
        val next = async { repository.present(null) }
        runCurrent()
        repository.request.value!!.complete(PurchasesRepository.Cancelled)
        assertTrue(next.await().success)
    }

    @Test fun missingCurrentOfferingReturnsErrorWithoutLeavingARequest() = runTest {
        val sdk = Client().apply { available = false }
        val repository = PurchasesRepository(this, sdk)
        repository.attachHost()
        repository.setAccount(a)
        advanceUntilIdle()
        assertEquals("Failed to present paywall", repository.present(null).error)
        assertNull(repository.request.value)
    }

    @Test fun cacheRestoresOnlySameAccountAtStartupAndClearsOnSwitch() = runTest {
        val cache = Cache().apply { entry = a to pro }
        val sdk = Client().apply { read = { error("offline") } }
        val repository = PurchasesRepository(this, sdk, cache)
        repository.setAccount(a)
        assertEquals(pro, repository.purchases.value)
        advanceUntilIdle()
        repository.setAccount(b)
        assertEquals(Purchases(), repository.purchases.value)
        assertNull(cache.entry)
        advanceUntilIdle()
    }
}