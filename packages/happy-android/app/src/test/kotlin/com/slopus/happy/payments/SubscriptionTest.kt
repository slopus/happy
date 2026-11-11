package com.slopus.happy.payments

import android.app.Activity
import android.content.Context
import com.slopus.happy.call.CallAllowance
import com.slopus.happy.call.MemoryUsageStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import java.security.MessageDigest
import java.time.Instant

/**
 * Voice's subscription against a store and RevenueCat that are only this
 * test's ([Subscription]): what is offered, what is posted and
 * acknowledged, for whom, the install's one customer and the one a store
 * account's subscription names, and the one restore a new version makes.
 * No store, network or charge.
 */
@RunWith(AndroidJUnit4::class)
class SubscriptionTest {
    private val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("voice-subscription-test", Context.MODE_PRIVATE)
    private var now = Instant.parse("2026-11-04T10:00:00Z").toEpochMilli()

    /** Another phone's install on the same Google account. */
    private val other = "\$RCAnonymousID:0123456789ab4def8123456789abcdef"

    @Before fun clear() {
        // The one restore a new version makes is its own tests'.
        preferences.edit().clear().putBoolean("migrated", true).commit()
    }

    private val store = FakeStore()
    private val rc = FakeRevenueCat()
    private val activity: Activity by lazy { Robolectric.buildActivity(Activity::class.java).get() }

    private fun TestScope.subscription(store: SubscriptionStore? = this@SubscriptionTest.store, rc: RevenueCat? = this@SubscriptionTest.rc) =
        Subscription(backgroundScope, store, rc, preferences, now = { now }).also { runCurrent() }

    /** Bought elsewhere, by an earlier version or RevenueCat's SDK ([account], the SHA-256 of a customer id), or for [account]'s customer. */
    private fun bought(token: String, purchased: Boolean = true, acknowledged: Boolean = false, product: String = "happy", account: String? = null) =
        StorePurchase(token, listOf(product), purchased, acknowledged, account)

    /** Opens the store's sheet for [subscription]'s customer now and buys [token] there. */
    private suspend fun TestScope.buys(subscription: Subscription, token: String, purchased: Boolean = true, product: String = "happy"): StorePurchase {
        assertTrue(subscription.buy(activity))
        runCurrent()
        return store.bought(token, purchased, product)
    }

    private fun posts() = rc.calls.filter { it.startsWith("post") }

    private fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    /** The preview app is a subscriber from its build alone: no welcome, a subscriber's 2 hours in each calendar month, nothing sold. */
    @Test
    fun thePreviewBuildIsASubscriber() = runTest {
        assertEquals(listOf("preview"), listOf("debug", "release", "preview", "bench").filter(Subscription::grantsPro))
        val subscription = Subscription(backgroundScope, null, null, preferences, grantsPro = true, now = { now }).also { runCurrent() }
        subscription.refresh(); runCurrent()
        assertTrue(subscription.hasPro())
        assertTrue(subscription.pro.value)
        assertEquals(Offer.Subscribed, subscription.offer.value)
        assertEquals(ProMonth(Instant.parse("2026-11-01T00:00:00Z").toEpochMilli(), Instant.parse("2026-12-01T00:00:00Z").toEpochMilli()), subscription.period())
        assertFalse(subscription.buy(activity))
        assertEquals(CallAllowance.PAID_MILLIS, CallAllowance(MemoryUsageStore(), period = subscription::period).remaining(now))
        assertFalse(CallIntro(preferences).welcomes(subscription.offer.value))
    }

    /** A store build is unchanged: without RevenueCat's `pro` it sells, welcomes and counts the free 20 minutes. */
    @Test
    fun aStoreBuildIsNotASubscriberUntilItBuys() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertFalse(subscription.grantsPro)
        assertFalse(subscription.hasPro())
        assertNull(subscription.period())
        assertEquals(Offer.OnSale("9,99 €"), subscription.offer.value)
        assertEquals(CallAllowance.FREE_MILLIS, CallAllowance(MemoryUsageStore(), period = subscription::period).remaining(now))
        assertTrue(CallIntro(preferences).welcomes(subscription.offer.value))
    }

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
        assertEquals(subscription.customer, subscription().customer)
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
        assertEquals("9,99 €", subscription.subscribedPrice.value)
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
    fun theSweepFinishesWhatWasLeftUnfinishedAfterARestartWhateverIsOnSale() = runTest {
        val first = subscription()
        first.refresh(); runCurrent()
        val install = first.customer
        // Bought, and the app died before the store said so; then the product went off sale.
        store.owned += buys(first, "t-old", product = "happy_old")
        store.owned += bought("done", acknowledged = true, product = "relay_pro")
        // This install's own from an earlier version, named by the SHA-256 of its id.
        store.owned += bought("legacy", account = sha(install))
        store.monthly = null
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        subscription.refresh(); runCurrent()
        assertEquals(listOf("post $install t-old [happy_old] restore=false", "post $install legacy [happy] restore=false"), posts())
        assertEquals(listOf("t-old", "legacy"), store.acknowledged)
    }

    @Test
    fun aPurchaseThatNamesNoOneIsLeftForRestore() = runTest {
        store.owned += bought("elsewhere")
        store.owned += bought("someone", account = sha("someone"))
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
        assertTrue(store.acknowledged.isEmpty())
        assertNotEquals(Subscription.Problem.Unconfirmed, subscription.problem.value)
        assertTrue(subscription.restore())
        assertEquals(
            listOf("post ${subscription.customer} elsewhere [happy] restore=true", "post ${subscription.customer} someone [happy] restore=true"),
            posts(),
        )
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
    fun everySheetCarriesTheCustomerItselfAsItsStoreId() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.buy(activity)); runCurrent()
        store.updates.emit(StoreUpdate.Failed(7)); runCurrent()
        assertTrue(subscription.buy(activity))
        // One id, whatever the sheet: Play names every purchase of theirs with it, and any phone reads it back.
        assertEquals(store.opened[0].second, store.opened[1].second)
        assertEquals(subscription.customer, store.opened[0].second)
        assertEquals(subscription.customer, Subscription.named(store.opened[0].second))
        assertTrue(store.opened[0].second.length <= 64)
    }

    @Test
    fun onlyAnInstallsIdNamesACustomer() {
        assertEquals(other, Subscription.named(other))
        assertNull(Subscription.named(null))
        assertNull(Subscription.named("account-a"))
        assertNull(Subscription.named(sha(other)))
        assertNull(Subscription.named(other.uppercase()))
        assertNull(Subscription.named("\$RCAnonymousID:0123"))
    }

    /** A later purchase under the same id is its buyer's after a restart, and told twice it is posted once. */
    @Test
    fun aRenewalIsItsBuyersAfterARestartAndToldTwice() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val install = subscription.customer
        val first = buys(subscription, "ta")
        store.emit(first); runCurrent()
        val renewal = first.copy(token = "ta-renewed")
        store.emit(renewal); runCurrent()
        store.emit(renewal); runCurrent()
        assertEquals(listOf("post $install ta [happy] restore=false", "post $install ta-renewed [happy] restore=false"), posts())
        // After a restart, the sweep finds it finished.
        store.owned += renewal.copy(acknowledged = true)
        store.owned += first.copy(token = "ta-renewed-again")
        val again = subscription()
        again.refresh(); runCurrent()
        assertEquals("post $install ta-renewed-again [happy] restore=false", posts().last())
        assertEquals(3, posts().size)
    }

    /** Restored, a purchase another id named is the install's: told again or swept, it never goes back to that id. */
    @Test
    fun aRestoredPurchaseIsTheInstallsFromThenOn() = runTest {
        val legacy = bought("t1", account = sha("account-a"))
        store.owned += legacy
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        rc.refusePosts = 400
        assertFalse(subscription.restore())
        rc.refusePosts = null
        assertTrue(subscription.restore())
        val install = subscription.customer
        assertEquals(listOf("post $install t1 [happy] restore=true", "post $install t1 [happy] restore=true"), posts())
        // Told again, and swept after a restart: nothing more, never for account-a.
        store.emit(legacy); runCurrent()
        val again = subscription()
        again.refresh(); runCurrent()
        assertTrue(posts().none { "account-a" in it })
        assertEquals(2, posts().size)
    }

    @Test
    fun aPurchasePendingForMonthsIsStillItsBuyers() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val pending = buys(subscription, "ta", purchased = false)
        store.emit(pending); runCurrent()
        now += 120L * 24 * 60 * 60 * 1000
        store.emit(pending.copy(purchased = true)); runCurrent()
        assertEquals(listOf("post ${subscription.customer} ta [happy] restore=false"), posts())
    }

    @Test
    fun aRestoreWhileAPurchaseIsPendingLeavesItForItsBuyer() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val pending = buys(subscription, "ta", purchased = false)
        store.emit(pending); runCurrent()
        store.owned += pending
        store.owned += bought("old", acknowledged = true)
        subscription.restore()
        assertEquals(listOf("post ${subscription.customer} old [happy] restore=true"), posts())
        // Paid for, then the app restarted: the sweep posts it.
        store.owned.replaceAll { if (it.token == "ta") it.copy(purchased = true) else it }
        val again = subscription()
        again.refresh(); runCurrent()
        assertEquals("post ${subscription.customer} ta [happy] restore=false", posts().last())
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

    /** Restore needs the key, the customer and the store, never an offering: with none set up, an old purchase still comes back. */
    @Test
    fun restoreWorksWithNoCurrentOffering() = runTest {
        rc.noOffering = true
        store.owned += bought("t1", acknowledged = true, product = "happy_lifetime")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(Offer.Unavailable, subscription.offer.value)
        assertTrue(subscription.restore())
        assertEquals(listOf("post ${subscription.customer} t1 [happy_lifetime] restore=true"), posts())
        assertTrue(subscription.hasPro())
    }

    /** Restore adopts as a launch does first: a subscription another phone bought is restored for its own customer, never pulled to this one's. */
    @Test
    fun restoreAdoptsTheCustomerTheStoresSubscriptionNamesFirst() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        store.owned += bought("elsewhere", acknowledged = true, account = other)
        assertTrue(subscription.restore())
        assertEquals(other, subscription.customer)
        assertEquals(listOf("post $other elsewhere [happy] restore=true"), posts())
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
    fun anExistingProCountsWhateverIsOnSaleAndWithNothingBoughtHere() = runTest {
        // A yearly product, granted in RevenueCat: its word is enough.
        val install = subscription().customer
        rc.pro[install] = "happy_yearly"
        store.monthly = null
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(subscription.pro.value)
        assertTrue(subscription.hasPro())
        assertEquals(Offer.Subscribed, subscription.offer.value)
        assertNull("a yearly pro is said at the monthly price", subscription.subscribedPrice.value)
        assertEquals(Subscription.Problem.NoProduct, subscription.problem.value)
        assertTrue(posts().isEmpty())
        // Offline at the next launch, within the day: still pro, from the first moment.
        rc.unreachable = true
        val again = subscription()
        assertTrue(again.pro.value)
        again.refresh(); runCurrent()
        assertTrue(again.pro.value)
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
        now += 25L * 60 * 60 * 1000
        assertNull(subscription.period())
    }

    @Test
    fun theDebugPreviewNeverGrants() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(Offer.Preview(Offer.PRICE).onSale)
        assertNull(subscription.period())
        assertTrue(posts().isEmpty())
    }

    // Another phone on the same Google account

    /** The store account holds a subscription another phone bought: its customer is this install's from now on, with no restore. */
    @Test
    fun aSubscriptionNamingAnotherInstallIsAdoptedWithoutARestore() = runTest {
        val mine = subscription().customer
        store.owned += bought("elsewhere", acknowledged = true, account = other)
        rc.pro[other] = "happy"
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(other, subscription.customer)
        assertNotEquals(mine, subscription.customer)
        assertTrue(subscription.pro.value)
        assertEquals(Offer.Subscribed, subscription.offer.value)
        assertTrue("adopting posted a receipt", posts().isEmpty())
        assertEquals(listOf("offerings $other", "subscriber $other"), rc.calls)
        // Restarted: still the adopted customer.
        assertEquals(other, subscription().customer)
    }

    /** Bought on the other phone while this one runs: adopted at the next foreground. */
    @Test
    fun aSubscriptionBoughtElsewhereIsAdoptedAtTheNextForeground() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val mine = subscription.customer
        assertFalse(subscription.pro.value)
        store.owned += bought("elsewhere", account = other)
        rc.pro[other] = "happy"
        subscription.refresh(); runCurrent()
        assertNotEquals(mine, subscription.customer)
        assertEquals(other, subscription.customer)
        assertTrue(subscription.pro.value)
        // Not yet acknowledged: posted for the customer it names, once.
        assertEquals(listOf("post $other elsewhere [happy] restore=false"), posts())
    }

    @Test
    fun anInstallWhoseOwnSubscriptionIsThereKeepsItsCustomer() = runTest {
        val mine = subscription().customer
        store.owned += bought("elsewhere", acknowledged = true, account = other)
        store.owned += bought("mine", acknowledged = true, account = mine)
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(mine, subscription.customer)
    }

    @Test
    fun nothingIsAdoptedFromAPendingOrUnnamedSubscription() = runTest {
        val mine = subscription().customer
        store.owned += bought("pending", purchased = false, account = other)
        store.owned += bought("legacy", acknowledged = true, account = sha(other))
        store.owned += bought("sdk", acknowledged = true)
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(mine, subscription.customer)
    }

    // The one restore a new version makes

    /**
     * The first launch of this version: the store account holds a
     * subscription that names no one (an earlier version's, or happy-app's
     * RevenueCat SDK's) and this install hasn't pro: posted once as a
     * restore, the install's from then on. Never again by itself.
     */
    @Test
    fun theFirstLaunchRestoresAnUnnamedSubscriptionOnce() = runTest {
        preferences.edit().remove("migrated").commit()
        store.owned += bought("hashed", acknowledged = true, account = sha("account-a"))
        store.owned += bought("sdk", acknowledged = true)
        store.owned += bought("pending", purchased = false)
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        val install = subscription.customer
        assertEquals(listOf("post $install hashed [happy] restore=true", "post $install sdk [happy] restore=true"), posts())
        assertTrue(subscription.pro.value)
        // Lost in RevenueCat later: nothing restores by itself again, after a restart either.
        rc.pro.remove(install)
        now += 2L * 24 * 60 * 60 * 1000
        subscription.refresh(); runCurrent()
        val again = subscription()
        again.refresh(); runCurrent()
        assertFalse(again.pro.value)
        assertEquals(2, posts().size)
    }

    @Test
    fun theFirstLaunchRestoresNothingWhenTheInstallHasPro() = runTest {
        preferences.edit().remove("migrated").commit()
        val install = subscription().customer
        rc.pro[install] = "happy"
        store.owned += bought("sdk", acknowledged = true)
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
        // Done: pro lost later restores nothing.
        rc.pro.remove(install)
        now += 2L * 24 * 60 * 60 * 1000
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
    }

    @Test
    fun theFirstLaunchRestoresNothingWhenTheAdoptedCustomerHasPro() = runTest {
        preferences.edit().remove("migrated").commit()
        rc.pro[other] = "happy"
        store.owned += bought("named", acknowledged = true, account = other)
        store.owned += bought("sdk", acknowledged = true)
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(other, subscription.customer)
        assertTrue(posts().isEmpty())
    }

    /** RevenueCat unreached, or not taking the restore: tried again at the next launch or foreground, until it is done once. */
    @Test
    fun theFirstLaunchsRestoreWaitsForRevenueCat() = runTest {
        preferences.edit().remove("migrated").commit()
        store.owned += bought("sdk", acknowledged = true)
        rc.unreachable = true
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(posts().isEmpty())
        rc.unreachable = false
        rc.refusePosts = 503
        subscription.refresh(); runCurrent()
        assertFalse(subscription.pro.value)
        rc.refusePosts = null
        subscription.refresh(); runCurrent()
        assertTrue(subscription.pro.value)
        subscription.refresh(); runCurrent()
        // One refused, one taken, none after.
        assertEquals(listOf("post ${subscription.customer} sdk [happy] restore=true"), posts().distinct())
        assertEquals(2, posts().size)
    }

    /**
     * An earlier version's: the Happy account as the customer, the ids it
     * bought with, a purchase restored to it. None of it is the
     * subscription's any more, and nothing is posted for the account.
     */
    @Test
    fun whatAnEarlierVersionKeptForAHappyAccountIsDropped() = runTest {
        val install = subscription().customer
        preferences.edit()
            .putString("customer", "account-a")
            .putBoolean("posted-by-install", true)
            .putString("accounts", """{"${sha("account-a")}":"account-a"}""")
            .putString("restored", """{"${sha("restored-to-a")}":"account-a"}""")
            .commit()
        store.owned += bought("bought-as-a", account = sha("account-a"))
        store.owned += bought("restored-to-a")
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(install, subscription.customer)
        assertTrue(posts().isEmpty())
        assertTrue(rc.calls.none { "account-a" in it })
        for (key in listOf("customer", "posted-by-install", "accounts")) assertFalse(key, preferences.contains(key))
    }
}
