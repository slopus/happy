package com.slopus.happy.call

import android.app.Activity
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.call.VoicePassTest.Companion.pro
import com.slopus.happy.call.VoicePassTest.Companion.subscriber
import com.slopus.happy.net.HappyJson
import com.slopus.happy.payments.RevenueCat
import com.slopus.happy.payments.RevenueCat.Answer
import com.slopus.happy.payments.StoreOffer
import com.slopus.happy.payments.StorePurchase
import com.slopus.happy.payments.VoiceStore
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
 * test's ([VoiceSubscription]): what is offered, what is posted and
 * acknowledged, for whom, and what a change of account in the middle of
 * it does. No store, network or charge.
 */
@RunWith(AndroidJUnit4::class)
class VoiceSubscriptionTest {
    private val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("voice-subscription-test", Context.MODE_PRIVATE)
    private val now = Instant.parse("2026-11-04T10:00:00Z").toEpochMilli()

    @Before fun clear() { preferences.edit().clear().commit() }

    private class Store : VoiceStore {
        override val updates = MutableSharedFlow<List<StorePurchase>>(extraBufferCapacity = 8)
        var monthly: StoreOffer? = StoreOffer("happy", "monthly", "9,99 €")
        val owned = ArrayList<StorePurchase>()
        val acknowledged = ArrayList<String>()
        val opened = ArrayList<StoreOffer>()
        override suspend fun monthly(product: String, basePlan: String) = monthly?.takeIf { it.product == product && it.basePlan == basePlan }
        override suspend fun owned() = owned.toList()
        override suspend fun buy(activity: Activity, offer: StoreOffer) = opened.add(offer)
        override suspend fun acknowledge(token: String): Boolean {
            acknowledged += token
            owned.replaceAll { if (it.token == token) it.copy(acknowledged = true) else it }
            return true
        }
    }

    /** RevenueCat as far as voice asks it: `pro` for whoever a receipt was posted for. [hold] makes a call wait. */
    private class Rc : RevenueCat {
        val calls = ArrayList<String>()
        val pro = HashMap<String, String>()
        var refusePosts: Int? = null
        var unreachable = false
        var identifyFails = false
        val hold = HashMap<String, CompletableDeferred<Unit>>()
        private suspend fun gate(name: String) { hold[name]?.await() }
        override suspend fun offerings(customer: String): Answer {
            calls += "offerings $customer"
            gate("offerings")
            if (unreachable) return Answer.Unreached(IOException("offline"))
            return Answer.Ok(HappyJson.parseToJsonElement("""{"current_offering_id":"d","offerings":[{"identifier":"d","packages":[{"identifier":"${'$'}rc_monthly","platform_product_identifier":"happy","platform_product_plan_identifier":"monthly"}]}]}"""))
        }
        override suspend fun subscriber(customer: String): Answer {
            calls += "subscriber $customer"
            gate("subscriber")
            if (unreachable) return Answer.Unreached(IOException("offline"))
            return Answer.Ok(answer(customer))
        }
        override suspend fun post(receipt: RevenueCat.Receipt): Answer {
            calls += "post ${receipt.customer} ${receipt.token} ${receipt.products} restore=${receipt.restore}"
            gate("post")
            refusePosts?.let { return Answer.Refused(it, "invalid receipt") }
            pro[receipt.customer] = receipt.products.first()
            return Answer.Ok(answer(receipt.customer))
        }
        override suspend fun identify(from: String, to: String): Answer {
            calls += "identify $from $to"
            gate("identify")
            if (identifyFails) return Answer.Unreached(IOException("offline"))
            pro.remove(from)?.let { pro[to] = it }
            return Answer.Ok(answer(to))
        }
        private fun answer(customer: String) =
            subscriber("2026-11-04T10:00:00Z", pro[customer]?.let { pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z", product = it) })
    }

    private val store = Store()
    private val rc = Rc()
    private val activity: Activity by lazy { Robolectric.buildActivity(Activity::class.java).get() }

    private fun TestScope.subscription(store: VoiceStore? = this@VoiceSubscriptionTest.store, rc: RevenueCat? = this@VoiceSubscriptionTest.rc) =
        VoiceSubscription(backgroundScope, store, rc, preferences, now = { now }).also { runCurrent() }

    private fun bought(token: String, purchased: Boolean = true, acknowledged: Boolean = false, product: String = "happy") =
        StorePurchase(token, listOf(product), purchased, acknowledged)

    private fun posts() = rc.calls.filter { it.startsWith("post") }

    @Test
    fun withoutAKeyNothingIsOfferedAndItSaysWhy() = runTest {
        val subscription = subscription(rc = null)
        subscription.refresh(); runCurrent()
        assertEquals(CallOffer.Unavailable, subscription.offer.value)
        assertEquals(VoiceSubscription.Problem.Unconfigured, subscription.problem.value)
    }

    @Test
    fun theStoresMonthlyProductIsOnSaleAtItsOwnPrice() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(CallOffer.OnSale("9,99 €"), subscription.offer.value)
        assertTrue(subscription.customer.matches(Regex("""\${'$'}RCAnonymousID:[a-f0-9]{32}""")))
    }

    @Test
    fun aProductTheStoreDoesntSellMonthlyIsNotOnSale() = runTest {
        store.monthly = null
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertEquals(CallOffer.Unavailable, subscription.offer.value)
        assertEquals(VoiceSubscription.Problem.NoProduct, subscription.problem.value)
    }

    @Test
    fun aPurchaseIsAcknowledgedOnlyOnceRevenueCatHasTakenIt() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        rc.refusePosts = 400
        store.updates.emit(listOf(bought("t1"))); runCurrent()
        assertTrue(store.acknowledged.isEmpty())
        assertNull(subscription.period())
        assertEquals(VoiceSubscription.Problem.Unconfirmed, subscription.problem.value)
        rc.refusePosts = null
        store.updates.emit(listOf(bought("t1"))); runCurrent()
        assertEquals(listOf("t1"), store.acknowledged)
        assertEquals(CallOffer.Subscribed, subscription.offer.value)
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
        assertEquals(CallOffer.Subscribed, subscription.offer.value)
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
        assertEquals(CallOffer.Unavailable, subscription.offer.value)
        assertEquals(VoiceSubscription.Problem.Unconfirmed, subscription.problem.value)
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
        assertEquals(CallOffer.Subscribed, subscription.offer.value)
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
        assertEquals(CallOffer.Unavailable, subscription.offer.value)
        rc.hold.remove("subscriber")!!.complete(Unit); runCurrent()
        assertNull(subscription.period())
        assertNotEquals(CallOffer.Subscribed, subscription.offer.value)
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
        assertEquals(CallOffer.Subscribed, subscription.offer.value)
        assertEquals(VoiceSubscription.Problem.Unreached, subscription.problem.value)
    }

    @Test
    fun theDebugPreviewNeverGrants() = runTest {
        val subscription = subscription()
        subscription.refresh(); runCurrent()
        assertTrue(CallOffer.Preview(CallOffer.PRICE).onSale)
        assertNull(subscription.period())
        assertTrue(posts().isEmpty())
    }
}
