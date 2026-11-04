package com.slopus.happy.payments

import android.app.Activity
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.payments.ProPassTest.Companion.pro
import com.slopus.happy.payments.ProPassTest.Companion.subscriber
import com.slopus.happy.payments.RevenueCat.Answer
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import java.io.IOException
import java.time.Instant

/**
 * Voice's subscription against a store and RevenueCat that are only this
 * test's ([Subscription]): what is offered, what is posted and
 * acknowledged, for whom, and what a change of account in the middle of
 * it does. No store, network or charge.
 */
@RunWith(AndroidJUnit4::class)
class SubscriptionTest {
    private val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("voice-subscription-test", Context.MODE_PRIVATE)
    private val now = Instant.parse("2026-11-04T10:00:00Z").toEpochMilli()

    @Before fun clear() { preferences.edit().clear().commit() }

    private val store = FakeStore()
    private val rc = FakeRevenueCat()
    private val activity: Activity by lazy { Robolectric.buildActivity(Activity::class.java).get() }

    private fun TestScope.subscription(store: SubscriptionStore? = this@SubscriptionTest.store, rc: RevenueCat? = this@SubscriptionTest.rc) =
        Subscription(backgroundScope, store, rc, preferences, now = { now }).also { runCurrent() }

    private fun bought(token: String, purchased: Boolean = true, acknowledged: Boolean = false, product: String = "happy") =
        StorePurchase(token, listOf(product), purchased, acknowledged)

    private fun posts() = rc.calls.filter { it.startsWith("post") }

    @Test
    fun withoutAKeyNothingIsOfferedAndItSaysWhy() = runTest {
        val subscription = subscription(rc = null)
        subscription.refresh(); runCurrent()
        assertEquals(Offer.Unavailable, subscription.offer.value)
        assertEquals(Subscription.Problem.Unconfigured, subscription.problem.value)
    }

    @Test
    fun theStoresMonthlyProductIsOnSaleAtItsOwnPrice() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(Offer.OnSale("9,99 €"), subscription.offer.value)
        assertTrue(subscription.customer.matches(Regex("""\${'$'}RCAnonymousID:[a-f0-9]{32}""")))
    }

    @Test
    fun aProductTheStoreDoesntSellMonthlyIsNotOnSale() = runTest {
        store.monthly = null
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(Offer.Unavailable, subscription.offer.value)
        assertEquals(Subscription.Problem.NoProduct, subscription.problem.value)
    }

    @Test
    fun aPurchaseIsAcknowledgedOnlyOnceRevenueCatHasTakenIt() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        rc.refusePosts = 400
        store.updates.emit(listOf(bought("t1"))); runCurrent()
        assertTrue(store.acknowledged.isEmpty())
        assertNull(subscription.period())
        assertEquals(Subscription.Problem.Unconfirmed, subscription.problem.value)
        rc.refusePosts = null
        store.updates.emit(listOf(bought("t1"))); runCurrent()
        assertEquals(listOf("t1"), store.acknowledged)
        assertEquals(Offer.Subscribed, subscription.offer.value)
    }

    @Test
    fun aPendingPurchaseIsNeitherPostedNorAcknowledged() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        store.updates.emit(listOf(bought("t1", purchased = false))); runCurrent()
        store.owned += bought("t1", purchased = false)
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
        assertTrue(store.acknowledged.isEmpty())
    }

    @Test
    fun theSweepFinishesWhatWasLeftUnfinishedWhateverIsOnSale() = runTest {
        // An older product no longer offered, bought and never finished; and one already done.
        store.monthly = null
        store.owned += bought("t-old", product = "happy_old")
        store.owned += bought("done", acknowledged = true, product = "relay_pro")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        subscription.refresh(); runCurrent()
        assertEquals(listOf("post ${subscription.customer} t-old [happy_old] restore=false"), posts())
        assertEquals(listOf("t-old"), store.acknowledged)
        assertEquals(Offer.Subscribed, subscription.offer.value)
    }

    @Test
    fun restorePostsEverythingOwnedWithItsOwnProductsWhateverIsOnSale() = runTest {
        store.owned += bought("t1", acknowledged = true, product = "happy_yearly")
        store.monthly = null
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        // A reinstall: nothing kept here, the store still holds it, and nothing was posted on its own.
        assertTrue(posts().isEmpty())
        assertTrue(subscription.restore())
        assertEquals(listOf("post ${subscription.customer} t1 [happy_yearly] restore=true"), posts())
        // Asked again, it goes again: what was posted before never stands in a restore's way.
        assertTrue(subscription.restore())
        assertEquals(2, posts().size)
    }

    @Test
    fun boughtButUnconfirmedOffersNothingAndGrantsNothing() = runTest {
        rc.refusePosts = 400
        store.owned += bought("t1")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(Offer.Unavailable, subscription.offer.value)
        assertEquals(Subscription.Problem.Unconfirmed, subscription.problem.value)
        assertNull(subscription.period())
        assertFalse(subscription.restore())
        assertTrue(store.acknowledged.isEmpty())
    }

    @Test
    fun aPurchaseIsPostedForWhoeverOpenedTheStoreWhoeverIsSignedInBy() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val install = subscription.customer
        assertTrue(subscription.buy(activity))
        // Signed in while the store's sheet was up.
        subscription.relay("account-a"); runCurrent()
        store.updates.emit(listOf(bought("t1"))); runCurrent()
        assertEquals(listOf("post $install t1 [happy] restore=false"), posts())
        assertEquals("account-a", subscription.customer)
        // The install's purchase isn't the account's access.
        assertNull(subscription.period())
    }

    @Test
    fun signingInMergesWhatTheInstallBoughtFirstAndSigningOutNeverGoesBackToIt() = runTest {
        store.owned += bought("t1")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val install = subscription.customer
        subscription.relay("account-a"); runCurrent()
        assertEquals("identify $install account-a", rc.calls.last())
        assertEquals("account-a", subscription.customer)
        subscription.refresh(); runCurrent()
        assertEquals(Offer.Subscribed, subscription.offer.value)
        // Signed out: a new install customer, neither the account nor the one merged into it.
        subscription.relay(null); runCurrent()
        val after = subscription.customer
        assertNotEquals(install, after)
        assertNotEquals("account-a", after)
        assertNull(subscription.period())
        // Another account on this phone: switched to, never merged, and nothing restored on its own.
        subscription.relay("account-b"); runCurrent()
        assertEquals("account-b", subscription.customer)
        assertEquals(1, rc.calls.count { it.startsWith("identify") })
        subscription.refresh(); runCurrent()
        assertTrue(posts().none { it.startsWith("post account-b") })
        assertNull(subscription.period())
    }

    @Test
    fun anAccountsExistingProCountsWhateverIsOnSaleAndWithNothingBoughtHere() = runTest {
        // Bought long ago, a yearly product, on another device: RevenueCat's word is enough.
        rc.pro["account-a"] = "happy_yearly"
        store.monthly = null
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.pro.value)
        assertTrue(subscription.hasPro())
        assertEquals(Offer.Subscribed, subscription.offer.value)
        assertEquals(Subscription.Problem.NoProduct, subscription.problem.value)
        assertTrue(posts().isEmpty())
        // Offline at the next launch, within the day: still pro, without asking.
        rc.unreachable = true
        val again = subscription()
        again.relay("account-a"); runCurrent()
        assertTrue(again.pro.value)
    }

    @Test
    fun proGoesTheMomentTheAccountChangesAndNeverComesBackForAnother() = runTest {
        rc.pro["account-a"] = "happy"
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.pro.value)
        subscription.relay("account-b")
        assertFalse(subscription.pro.value)
        assertFalse(subscription.hasPro())
        runCurrent()
        subscription.refresh(); runCurrent()
        assertFalse(subscription.pro.value)
        subscription.relay(null); runCurrent()
        subscription.refresh(); runCurrent()
        assertFalse(subscription.pro.value)
    }

    @Test
    fun anAccountWithNothingBoughtHereIsSwitchedToWithoutAnIdentify() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        assertEquals("account-a", subscription.customer)
        subscription.relay("account-b"); runCurrent()
        assertEquals("account-b", subscription.customer)
        assertTrue(rc.calls.none { it.startsWith("identify") })
    }

    @Test
    fun aFailedMergeKeepsTheInstallAndPostsNothingUnderTheAccount() = runTest {
        store.owned += bought("t1")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val install = subscription.customer
        rc.identifyFails = true
        subscription.relay("account-a"); runCurrent()
        assertEquals(install, subscription.customer)
        store.owned += bought("t2")
        subscription.refresh(); runCurrent()
        assertTrue(posts().none { it.startsWith("post account-a") })
        // Tried again on the next refresh, and then the account's.
        rc.identifyFails = false
        subscription.refresh(); runCurrent()
        assertEquals("account-a", subscription.customer)
    }

    @Test
    fun anAnswerForTheCustomerBeforeASignOutIsDropped() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        rc.pro["account-a"] = "happy"
        rc.hold["subscriber"] = CompletableDeferred()
        subscription.refresh(); runCurrent()
        // Signed out while RevenueCat was still answering for the account.
        subscription.relay(null)
        assertNull(subscription.period())
        assertEquals(Offer.Unavailable, subscription.offer.value)
        rc.hold.remove("subscriber")!!.complete(Unit); runCurrent()
        assertNull(subscription.period())
        assertNotEquals(Offer.Subscribed, subscription.offer.value)
        assertNotEquals("account-a", subscription.customer)
    }

    @Test
    fun aMergeThatAnsweredAfterASignOutStillRetiresTheInstallId() = runTest {
        store.owned += bought("t1")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val install = subscription.customer
        rc.hold["identify"] = CompletableDeferred()
        subscription.relay("account-a"); runCurrent()
        subscription.relay(null)
        rc.hold.remove("identify")!!.complete(Unit); runCurrent()
        // RevenueCat merged it: that id is the account's now, so this install never uses it again.
        assertNotEquals(install, subscription.customer)
        assertNotEquals("account-a", subscription.customer)
        assertNull(subscription.period())
    }

    @Test
    fun aRestoreForTheCustomerBeforeASwitchSaysNothingRestored() = runTest {
        store.owned += bought("t1", acknowledged = true)
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        rc.hold["post"] = CompletableDeferred()
        val restored = CompletableDeferred<Boolean>()
        backgroundScope.launch { restored.complete(subscription.restore()) }
        runCurrent()
        subscription.relay("account-b")
        rc.hold.remove("post")!!.complete(Unit); runCurrent()
        assertFalse(restored.await())
        assertEquals("account-b", subscription.customer)
        assertNull(subscription.period())
    }

    @Test
    fun offlineKeepsWhatRevenueCatSaidForADay() = runTest {
        store.owned += bought("t1")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        rc.unreachable = true
        subscription.refresh(); runCurrent()
        assertEquals(Offer.Subscribed, subscription.offer.value)
        assertEquals(Subscription.Problem.Unreached, subscription.problem.value)
    }

    @Test
    fun theDebugPreviewNeverGrants() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(Offer.Preview(Offer.PRICE).onSale)
        assertNull(subscription.period())
        assertTrue(posts().isEmpty())
    }
}
