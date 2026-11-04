package com.slopus.happy.payments

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/**
 * The app's offer sheets ([Offers]): one at a time, and how each was
 * closed. The welcome's start is the only free way on; closing is never a
 * start; `pro` that came while a sheet was up closes it as bought.
 */
@RunWith(AndroidJUnit4::class)
class OffersTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val preferences = context.getSharedPreferences("offers-subscription-test", Context.MODE_PRIVATE)
    private val introPreferences = context.getSharedPreferences("offers-intro-test", Context.MODE_PRIVATE)
    private val now = Instant.parse("2026-11-04T10:00:00Z").toEpochMilli()
    private val store = FakeStore()
    private val rc = FakeRevenueCat()

    @Before fun clear() {
        preferences.edit().clear().commit()
        introPreferences.edit().clear().commit()
    }

    private fun TestScope.setUp(): Pair<Subscription, Offers> {
        val subscription = Subscription(backgroundScope, store, rc, preferences, now = { now })
        val offers = Offers(backgroundScope, subscription, CallIntro(introPreferences))
        subscription.refresh()
        runCurrent()
        return subscription to offers
    }

    @Test
    fun theWelcomesStartIsTheOnlyFreeWayOnAndClosingIsNeverAStart() = runTest {
        val (_, offers) = setUp()
        val started = async { offers.ask(OfferSheet.Welcome(offers.offer)) }
        runCurrent()
        assertTrue(offers.sheet.value is OfferSheet.Welcome)
        offers.start()
        assertEquals(OfferResult.Start, started.await())
        assertNull(offers.sheet.value)

        val closed = async { offers.ask(OfferSheet.Welcome(offers.offer)) }
        runCurrent()
        offers.dismiss()
        assertEquals(OfferResult.Dismissed, closed.await())

        // Required has no start at all.
        val required = async { offers.ask(OfferSheet.Required(offers.offer)) }
        runCurrent()
        offers.start()
        runCurrent()
        assertTrue(offers.sheet.value is OfferSheet.Required)
        offers.dismiss()
        assertEquals(OfferResult.Dismissed, required.await())
    }

    @Test
    fun oneSheetAtATimeAndACancelledAskTakesItsSheetAway() = runTest {
        val (_, offers) = setUp()
        val first = async { offers.ask(OfferSheet.Support(offers.offer)) }
        runCurrent()
        assertEquals(OfferResult.Dismissed, offers.ask(OfferSheet.Required(offers.offer)))
        assertTrue(offers.sheet.value is OfferSheet.Support)
        first.cancel()
        runCurrent()
        assertNull(offers.sheet.value)
    }

    @Test
    fun proThatCameWhileUpClosesItAsBought() = runTest {
        val (_, offers) = setUp()
        val asked = async { offers.ask(OfferSheet.Required(offers.offer)) }
        runCurrent()
        assertTrue(offers.offer is Offer.OnSale)
        // The store's sheet came back bought, and RevenueCat took it.
        store.updates.emit(listOf(StorePurchase("t1", listOf("happy"), purchased = true, acknowledged = false)))
        runCurrent()
        assertEquals(OfferResult.Pro, asked.await())
        assertNull(offers.sheet.value)
    }

    @Test
    fun theUsedUpSheetWaitsForItsCallerWhenProComes() = runTest {
        val (_, offers) = setUp()
        val asked = async { offers.ask(OfferSheet.Used(null, offers.offer)) }
        runCurrent()
        store.updates.emit(listOf(StorePurchase("t1", listOf("happy"), purchased = true, acknowledged = false)))
        runCurrent()
        assertTrue(offers.sheet.value is OfferSheet.Used)
        offers.dismiss()
        assertEquals(OfferResult.Pro, asked.await())
    }

    @Test
    fun aSubscriberOpeningSupportIsNotAnsweredAsANewPurchase() = runTest {
        rc.pro["account-a"] = "happy"
        val (subscription, offers) = setUp()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.pro.value)
        val asked = async { offers.ask(OfferSheet.Support(offers.offer)) }
        runCurrent()
        assertTrue(offers.sheet.value is OfferSheet.Support)
        offers.dismiss()
        assertEquals(OfferResult.Dismissed, asked.await())
    }

    @Test
    fun anAccountChangeClosesWhateverIsUp() = runTest {
        val (subscription, offers) = setUp()
        val asked = async { offers.ask(OfferSheet.Required(offers.offer)) }
        runCurrent()
        subscription.relay("account-b")
        offers.close()
        assertEquals(OfferResult.Dismissed, asked.await())
        assertNull(offers.sheet.value)
    }

    @Test
    fun theWelcomeIsDueOnceAndOnlyWhileSomethingIsOnSale() = runTest {
        store.monthly = null
        val (_, offers) = setUp()
        assertFalse(offers.welcomes())
        assertTrue(offers.intro.due)
        store.monthly = StoreOffer("happy", "monthly", "9,99 €")
        val (_, again) = setUp()
        assertTrue(again.welcomes())
        assertFalse(again.welcomes())
    }
}
