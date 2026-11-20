package com.slopus.happy.payments

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * A subscription the store holds for this device's store account, bought
 * on this phone or another. [account]: Play's obfuscated account id, as
 * [SubscriptionStore.buy] gave it (the customer itself, see
 * [Subscription.named]); null for one bought without one.
 */
data class StorePurchase(
    val token: String,
    val products: List<String>,
    val purchased: Boolean,
    val acknowledged: Boolean,
    val account: String? = null,
)

/** What the store's purchase sheet came to. */
sealed interface StoreUpdate {
    /** Bought or pending, or a pending purchase now paid for. */
    data class Purchases(val purchases: List<StorePurchase>) : StoreUpdate

    /** Closed without buying. */
    data object Cancelled : StoreUpdate

    /** The store couldn't sell it (already owned, unavailable, an error). */
    data class Failed(val code: Int) : StoreUpdate
}

/** A monthly subscription the store sells: its price as the store words it, for this person's country. */
data class StoreOffer(val product: String, val basePlan: String, val price: String)

/** The store voice buys through, apart so voice's purchases can be tested without Play. */
interface SubscriptionStore {
    /** What each purchase sheet came to, and pending purchases as they complete. */
    val updates: SharedFlow<StoreUpdate>

    /** The [product]'s [basePlan] if it renews every month; null if the store doesn't sell it so, or isn't reachable. */
    suspend fun monthly(product: String, basePlan: String): StoreOffer?

    /** Every subscription the store account holds, pending or bought; null when the store didn't answer. */
    suspend fun owned(): List<StorePurchase>?

    /**
     * Shows the store's purchase sheet, the purchase it makes named
     * [account] for good ([StorePurchase.account]); what comes of it arrives
     * in [updates]. False if it couldn't open.
     */
    suspend fun buy(activity: Activity, offer: StoreOffer, account: String): Boolean

    suspend fun acknowledge(token: String): Boolean
}

/**
 * Google Play Billing (8.3.0, the version RevenueCat's SDK already brings)
 * for voice's subscription. Its own client, beside the SDK's; it asks
 * nothing of RevenueCat itself.
 */
class PlayBilling internal constructor(newClient: (PurchasesUpdatedListener) -> BillingClient) : SubscriptionStore {
    constructor(context: Context) : this({ listener ->
        BillingClient.newBuilder(context.applicationContext)
            .setListener(listener)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
    })

    private val mutableUpdates = MutableSharedFlow<StoreUpdate>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    override val updates: SharedFlow<StoreUpdate> = mutableUpdates

    private val client = newClient(
        PurchasesUpdatedListener { result, purchases ->
            mutableUpdates.tryEmit(
                when (result.responseCode) {
                    BillingClient.BillingResponseCode.OK -> StoreUpdate.Purchases(purchases.orEmpty().map(::purchase))
                    BillingClient.BillingResponseCode.USER_CANCELED -> StoreUpdate.Cancelled
                    else -> StoreUpdate.Failed(result.responseCode)
                },
            )
        },
    )
    private val connecting = Mutex()

    /** What [monthly] found, for [buy]: Play wants its own details and the base plan's offer token. */
    private val found = HashMap<StoreOffer, Pair<ProductDetails, String>>()

    override suspend fun monthly(product: String, basePlan: String): StoreOffer? {
        if (!connect()) return null
        val params = QueryProductDetailsParams.newBuilder().setProductList(
            listOf(QueryProductDetailsParams.Product.newBuilder().setProductId(product).setProductType(BillingClient.ProductType.SUBS).build()),
        ).build()
        val details = firstAnswer<ProductDetails?> { answer ->
            client.queryProductDetailsAsync(params) { result, found ->
                answer(found.productDetailsList.takeIf { result.ok }?.firstOrNull { it.productId == product })
            }
        } ?: return null
        // The base plan itself (no offer id), renewing every month.
        val plan = details.subscriptionOfferDetails?.firstOrNull { it.basePlanId == basePlan && it.offerId == null } ?: return null
        val phase = plan.pricingPhases.pricingPhaseList.lastOrNull() ?: return null
        if (phase.billingPeriod != "P1M" || phase.recurrenceMode != ProductDetails.RecurrenceMode.INFINITE_RECURRING) return null
        return StoreOffer(product, basePlan, phase.formattedPrice).also { synchronized(found) { found[it] = details to plan.offerToken } }
    }

    override suspend fun owned(): List<StorePurchase>? {
        if (!connect()) return null
        return firstAnswer { answer ->
            client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result, purchases ->
                answer(purchases.takeIf { result.ok }?.map(::purchase))
            }
        }
    }

    override suspend fun buy(activity: Activity, offer: StoreOffer, account: String): Boolean {
        val (details, offerToken) = synchronized(found) { found[offer] } ?: return false
        if (!connect()) return false
        val params = BillingFlowParams.newBuilder().setProductDetailsParamsList(
            listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details).setOfferToken(offerToken).build()),
        ).setObfuscatedAccountId(account).build()
        return client.launchBillingFlow(activity, params).ok
    }

    override suspend fun acknowledge(token: String): Boolean {
        if (!connect()) return false
        return firstAnswer { answer ->
            client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()) { answer(it.ok) }
        }
    }

    private suspend fun connect(): Boolean = connecting.withLock {
        if (client.isReady) return@withLock true
        firstAnswer { answer ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) = answer(result.ok)

                override fun onBillingServiceDisconnected() = answer(false)
            })
        }
    }

    /**
     * Play's first answer to one request. Play can answer twice: when it
     * hasn't answered in 28.5 s, its timeout (on the main thread) cancels the
     * request and answers that it timed out, while the request it cancelled
     * answers too (on Play's worker), and a second resume throws.
     */
    private suspend fun <T> firstAnswer(ask: (answer: (T) -> Unit) -> Unit): T = suspendCancellableCoroutine { continuation ->
        val answered = AtomicBoolean()
        ask { if (answered.compareAndSet(false, true)) continuation.resume(it) }
    }

    private val BillingResult.ok get() = responseCode == BillingClient.BillingResponseCode.OK

    private fun purchase(purchase: Purchase) = StorePurchase(
        token = purchase.purchaseToken,
        products = purchase.products,
        purchased = purchase.purchaseState == Purchase.PurchaseState.PURCHASED,
        acknowledged = purchase.isAcknowledged,
        account = purchase.accountIdentifiers?.obfuscatedAccountId,
    )
}
