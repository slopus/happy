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
    private var now = Instant.parse("2026-11-04T10:00:00Z").toEpochMilli()

    @Before fun clear() { preferences.edit().clear().commit() }

    private val store = FakeStore()
    private val rc = FakeRevenueCat()
    private val activity: Activity by lazy { Robolectric.buildActivity(Activity::class.java).get() }

    private fun TestScope.subscription(store: SubscriptionStore? = this@SubscriptionTest.store, rc: RevenueCat? = this@SubscriptionTest.rc) =
        Subscription(backgroundScope, store, rc, preferences, now = { now }).also { runCurrent() }

    /** Bought elsewhere, or by RevenueCat's SDK: no customer id of this install's names it. */
    private fun bought(token: String, purchased: Boolean = true, acknowledged: Boolean = false, product: String = "happy") =
        StorePurchase(token, listOf(product), purchased, acknowledged)

    /** Opens the store's sheet for [subscription]'s customer now and buys [token] there. */
    private suspend fun TestScope.buys(subscription: Subscription, token: String, purchased: Boolean = true, product: String = "happy"): StorePurchase {
        assertTrue(subscription.buy(activity))
        runCurrent()
        return store.bought(token, purchased, product)
    }

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
        val t1 = buys(subscription, "t1")
        store.emit(t1); runCurrent()
        assertTrue(store.acknowledged.isEmpty())
        assertNull(subscription.period())
        assertEquals(Subscription.Problem.Unconfirmed, subscription.problem.value)
        rc.refusePosts = null
        store.emit(t1); runCurrent()
        assertEquals(listOf("t1"), store.acknowledged)
        assertEquals(Offer.Subscribed, subscription.offer.value)
    }

    @Test
    fun aPendingPurchaseIsNeitherPostedNorAcknowledged() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val pending = buys(subscription, "t1", purchased = false)
        store.emit(pending); runCurrent()
        store.owned += pending
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
        assertTrue(store.acknowledged.isEmpty())
    }

    @Test
    fun theSweepFinishesWhatWasLeftUnfinishedAfterARestartForItsBuyerWhateverIsOnSale() = runTest {
        val first = subscription()
        first.refresh(); runCurrent()
        val install = first.customer
        // Bought, and the app died before the store said so; then signed in, and the product went off sale.
        store.owned += buys(first, "t-old", product = "happy_old")
        store.owned += bought("done", acknowledged = true, product = "relay_pro")
        store.monthly = null
        rc.pro["account-a"] = "happy"
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        subscription.refresh(); runCurrent()
        assertEquals(listOf("post $install t-old [happy_old] restore=false"), posts())
        assertEquals(listOf("t-old"), store.acknowledged)
    }

    @Test
    fun aPurchaseNoAttemptHereNamesIsLeftForRestore() = runTest {
        store.owned += bought("elsewhere")
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
        assertTrue(store.acknowledged.isEmpty())
        assertNotEquals(Subscription.Problem.Unconfirmed, subscription.problem.value)
        assertTrue(subscription.restore())
        assertEquals(listOf("post account-a elsewhere [happy] restore=true"), posts())
    }

    @Test
    fun oneSheetAtATime() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.buy(activity))
        assertFalse(subscription.buy(activity))
        assertEquals(1, store.opened.size)
        store.updates.emit(StoreUpdate.Cancelled); runCurrent()
        assertTrue(subscription.buy(activity))
    }

    @Test
    fun aCancelledSheetForOneAccountGivesTheNextNothing() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.buy(activity)); runCurrent()
        store.updates.emit(StoreUpdate.Cancelled); runCurrent()
        subscription.relay("account-b"); runCurrent()
        subscription.refresh(); runCurrent()
        val b = buys(subscription, "tb")
        store.emit(b); runCurrent()
        assertEquals(listOf("post account-b tb [happy] restore=false"), posts())
        assertTrue(subscription.pro.value)
    }

    @Test
    fun aFailedSheetLetsAnotherOpenForTheSameCustomerId() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.buy(activity)); runCurrent()
        store.updates.emit(StoreUpdate.Failed(7)); runCurrent()
        assertTrue(subscription.buy(activity))
        // One id per customer, whatever the sheet: the store names every purchase and renewal of theirs with it.
        assertEquals(store.opened[0].second, store.opened[1].second)
        subscription.relay("account-b"); runCurrent()
        subscription.refresh(); runCurrent()
        store.updates.emit(StoreUpdate.Cancelled); runCurrent()
        assertTrue(subscription.buy(activity))
        assertNotEquals(store.opened[0].second, store.opened[2].second)
        // RevenueCat's SDK's id for the same customer: the SHA-256 of its id, never the id itself.
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest("account-b".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(sha, store.opened[2].second)
    }

    /**
     * A later purchase under the same customer id (bought again after a
     * lapse; on Apple, every renewal) is its buyer's after a sign-out,
     * another account, a restart, and told twice, without granting whoever
     * is signed in.
     */
    @Test
    fun aRenewalIsItsBuyersWhoeverIsSignedInAfterARestartAndToldTwice() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        val first = buys(subscription, "ta")
        store.emit(first); runCurrent()
        subscription.relay(null); runCurrent()
        subscription.relay("account-b"); runCurrent()
        subscription.refresh(); runCurrent()
        val renewal = first.copy(token = "ta-renewed")
        store.emit(renewal); runCurrent()
        store.emit(renewal); runCurrent()
        assertEquals(listOf("post account-a ta [happy] restore=false", "post account-a ta-renewed [happy] restore=false"), posts())
        assertFalse(subscription.pro.value)
        // After a restart, the sweep finds it finished.
        store.owned += renewal.copy(acknowledged = true)
        store.owned += first.copy(token = "ta-renewed-again")
        val again = subscription()
        again.relay("account-b"); runCurrent()
        again.refresh(); runCurrent()
        assertEquals("post account-a ta-renewed-again [happy] restore=false", posts().last())
        assertEquals(3, posts().size)
        assertFalse(again.pro.value)
    }

    /** Restored for B, a purchase bought as A is B's from then on: nothing the store says of it later goes back to A. */
    @Test
    fun aRestoredPurchaseIsTheRestoringCustomersFromThenOn() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        rc.refusePosts = 400
        val t1 = buys(subscription, "t1")
        store.emit(t1); runCurrent()
        store.owned += t1
        rc.refusePosts = null
        subscription.relay("account-b"); runCurrent()
        assertTrue(subscription.restore())
        assertEquals(listOf("post account-b t1 [happy] restore=true"), posts().filter { "restore=true" in it })
        // Told again, swept, after a restart: never posted for A.
        store.emit(t1); runCurrent()
        val again = subscription()
        again.relay("account-a"); runCurrent()
        again.refresh(); runCurrent()
        assertTrue(posts().none { it.startsWith("post account-a t1") && "restore=false" in it && posts().indexOf(it) > 1 })
        assertEquals(1, posts().count { it == "post account-b t1 [happy] restore=true" })
    }

    @Test
    fun aPurchasePendingForMonthsIsStillItsBuyers() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        val pending = buys(subscription, "ta", purchased = false)
        store.emit(pending); runCurrent()
        subscription.relay("account-b"); runCurrent()
        now += 120L * 24 * 60 * 60 * 1000
        store.emit(pending.copy(purchased = true)); runCurrent()
        assertEquals(listOf("post account-a ta [happy] restore=false"), posts())
    }

    @Test
    fun aPendingPurchaseStaysItsBuyersThroughAnotherAccountsPurchase() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        val pending = buys(subscription, "ta", purchased = false)
        store.emit(pending); runCurrent()
        subscription.relay("account-b"); runCurrent()
        subscription.refresh(); runCurrent()
        val b = buys(subscription, "tb")
        store.emit(b); runCurrent()
        // Paid for at last, days later: still account A's.
        store.emit(pending.copy(purchased = true)); runCurrent()
        assertEquals(listOf("post account-b tb [happy] restore=false", "post account-a ta [happy] restore=false"), posts())
    }

    @Test
    fun aRestoreWhileAPurchaseIsPendingLeavesItForItsBuyer() = runTest {
        val subscription = subscription()
        subscription.relay("account-a"); runCurrent()
        subscription.refresh(); runCurrent()
        val pending = buys(subscription, "ta", purchased = false)
        store.emit(pending); runCurrent()
        store.owned += pending
        store.owned += bought("old", acknowledged = true)
        subscription.relay("account-b"); runCurrent()
        subscription.restore()
        assertEquals(listOf("post account-b old [happy] restore=true"), posts())
        // Paid for, then the app restarted: the sweep posts it for A.
        store.owned.replaceAll { if (it.token == "ta") it.copy(purchased = true) else it }
        val again = subscription()
        again.relay("account-b"); runCurrent()
        again.refresh(); runCurrent()
        assertEquals("post account-a ta [happy] restore=false", posts().last())
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
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        rc.refusePosts = 400
        store.owned += buys(subscription, "t1")
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
        val t1 = buys(subscription, "t1")
        // Signed in while the store's sheet was up.
        subscription.relay("account-a"); runCurrent()
        store.emit(t1); runCurrent()
        assertEquals(listOf("post $install t1 [happy] restore=false"), posts())
        assertEquals("account-a", subscription.customer)
        // The install's purchase isn't the account's access.
        assertNull(subscription.period())
    }

    @Test
    fun signingInMergesWhatTheInstallBoughtFirstAndSigningOutNeverGoesBackToIt() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        store.owned += buys(subscription, "t1")
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
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        store.owned += buys(subscription, "t1")
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
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        store.owned += buys(subscription, "t1")
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
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        store.owned += buys(subscription, "t1")
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
