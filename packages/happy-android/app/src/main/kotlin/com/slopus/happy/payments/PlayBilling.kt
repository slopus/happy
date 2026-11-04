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
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

/**
 * A subscription the store holds for this device's store account. [attempt]:
 * the purchase sheet it was bought from, as [SubscriptionStore.buy] named it
 * (Play's obfuscated account id); null for one bought elsewhere.
 */
data class StorePurchase(
    val token: String,
    val products: List<String>,
    val purchased: Boolean,
    val acknowledged: Boolean,
    val attempt: String? = null,
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
     * [attempt] for good ([StorePurchase.attempt]); what comes of it arrives
     * in [updates]. False if it couldn't open.
     */
    suspend fun buy(activity: Activity, offer: StoreOffer, attempt: String): Boolean

    suspend fun acknowledge(token: String): Boolean
}

/**
 * Google Play Billing (8.3.0, the version RevenueCat's SDK already brings)
 * for voice's subscription. Its own client, beside the SDK's; it asks
 * nothing of RevenueCat itself.
 */
class PlayBilling(context: Context) : SubscriptionStore {
    private val mutableUpdates = MutableSharedFlow<StoreUpdate>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    override val updates: SharedFlow<StoreUpdate> = mutableUpdates

    private val client = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases ->
            mutableUpdates.tryEmit(
                when (result.responseCode) {
                    BillingClient.BillingResponseCode.OK -> StoreUpdate.Purchases(purchases.orEmpty().map(::purchase))
                    BillingClient.BillingResponseCode.USER_CANCELED -> StoreUpdate.Cancelled
                    else -> StoreUpdate.Failed(result.responseCode)
                },
            )
        }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()
    private val connecting = Mutex()

    /** What [monthly] found, for [buy]: Play wants its own details and the base plan's offer token. */
    private val found = HashMap<StoreOffer, Pair<ProductDetails, String>>()

    override suspend fun monthly(product: String, basePlan: String): StoreOffer? {
        if (!connect()) return null
        val params = QueryProductDetailsParams.newBuilder().setProductList(
            listOf(QueryProductDetailsParams.Product.newBuilder().setProductId(product).setProductType(BillingClient.ProductType.SUBS).build()),
        ).build()
        val details = suspendCancellableCoroutine<ProductDetails?> { continuation ->
            client.queryProductDetailsAsync(params) { result, found ->
                continuation.resume(found.productDetailsList.takeIf { result.ok }?.firstOrNull { it.productId == product })
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
        return suspendCancellableCoroutine { continuation ->
            client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result, purchases ->
                continuation.resume(purchases.takeIf { result.ok }?.map(::purchase))
            }
        }
    }

    override suspend fun buy(activity: Activity, offer: StoreOffer, attempt: String): Boolean {
        val (details, offerToken) = synchronized(found) { found[offer] } ?: return false
        if (!connect()) return false
        val params = BillingFlowParams.newBuilder().setProductDetailsParamsList(
            listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details).setOfferToken(offerToken).build()),
        ).setObfuscatedAccountId(attempt).build()
        return client.launchBillingFlow(activity, params).ok
    }

    override suspend fun acknowledge(token: String): Boolean {
        if (!connect()) return false
        return suspendCancellableCoroutine { continuation ->
            client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()) { continuation.resume(it.ok) }
        }
    }

    private suspend fun connect(): Boolean = connecting.withLock {
        if (client.isReady) return@withLock true
        suspendCancellableCoroutine { continuation ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (continuation.isActive) continuation.resume(result.ok)
                }

                override fun onBillingServiceDisconnected() {
                    if (continuation.isActive) continuation.resume(false)
                }
            })
        }
    }

    private val BillingResult.ok get() = responseCode == BillingClient.BillingResponseCode.OK

    private fun purchase(purchase: Purchase) = StorePurchase(
        token = purchase.purchaseToken,
        products = purchase.products,
        purchased = purchase.purchaseState == Purchase.PurchaseState.PURCHASED,
        acknowledged = purchase.isAcknowledged,
        attempt = purchase.accountIdentifiers?.obfuscatedAccountId,
    )
}
