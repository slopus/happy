package com.slopus.happy.payments

import com.android.billingclient.api.BillingClient
import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.PurchaseError
import com.slopus.happy.analytics.PaywallStep
import com.slopus.happy.analytics.PurchaseProduct
import android.app.Activity
import android.content.SharedPreferences
import com.slopus.happy.payments.RevenueCat.Answer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/**
 * The app's one subscription: RevenueCat's `pro`, bought through the store
 * ([SubscriptionStore]) and told to RevenueCat's REST API ([RevenueCat]),
 * without its SDK. Everything that sells it or asks about it asks here:
 * voice's sheets and hours, the relay's voice, Support us.
 *
 * Whose it is: this install's own anonymous customer (`$RCAnonymousID:`
 * and 32 hex digits, as RevenueCat's SDK makes them), kept on the phone
 * and never told to anyone but RevenueCat: not the Happy account, not
 * analytics. No account, signed in or out, changes it.
 *
 * Every phone on the Google account: a purchase carries its customer
 * readably, as Play's obfuscated account id ([StorePurchase.account]), on
 * the purchase for good. At launch and foreground, an active subscription
 * the store account holds that names a customer makes that customer this
 * install's ([adopt]): nothing is restored or moved in RevenueCat, so
 * phones never pull a subscription from each other.
 *
 * Access is only what RevenueCat says, kept a day at most ([ProPassCache]).
 * Everything that asks RevenueCat or the store runs one at a time ([work]),
 * and each customer change starts a new [generation] at once: an answer
 * asked under an older one is dropped. A purchase is posted for the
 * customer it names, or the one Restore moved it to ([RESTORED]), and
 * acknowledged only once RevenueCat has taken it; one left unfinished is
 * finished at the next launch or foreground. One that names no one is left
 * alone. One sheet at a time.
 *
 * Restore is the person's tap: every subscription the store account holds
 * posted for the customer now, whatever is on sale; each one RevenueCat
 * takes is that customer's from then on. With one exception: the first
 * time RevenueCat answers after this version is installed, a subscription
 * that names no customer (bought before purchases named theirs) is
 * restored once to this install, if it hasn't `pro` ([migrate]).
 *
 * The preview app grants `pro` itself ([grantsPro]): everything that asks
 * sees a subscriber, with a subscriber's hours in each calendar month
 * ([ProMonth.calendar]); nothing is sold or restored.
 */
class Subscription(
    private val scope: CoroutineScope,
    private val store: SubscriptionStore?,
    private val revenueCat: RevenueCat?,
    private val preferences: SharedPreferences,
    val grantsPro: Boolean = false,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** Why the offer is what it is, when something stands in its way. */
    sealed interface Problem {
        /** The build has no RevenueCat key, or no store. */
        data object Unconfigured : Problem

        /** RevenueCat's current offering has no monthly package, or the store doesn't sell it monthly. */
        data object NoProduct : Problem

        /** RevenueCat or the store couldn't be reached. */
        data object Unreached : Problem

        /** RevenueCat refused: a key, product or receipt it won't take. */
        data class Refused(val status: Int, val message: String?) : Problem

        /** The store holds a purchase RevenueCat hasn't taken yet: nothing to sell, nothing granted. */
        data object Unconfirmed : Problem
    }

    private val cache = ProPassCache(preferences)
    private val work = Mutex()
    private val generation = AtomicLong()
    private var monthly: StoreOffer? = null
    private var unconfirmed = false
    /** A purchase sheet is open. */
    private var launching = false

    private val mutableOffer = MutableStateFlow<Offer>(Offer.Unavailable)
    val offer: StateFlow<Offer> = mutableOffer.asStateFlow()
    private val mutableProblem = MutableStateFlow<Problem?>(if (revenueCat == null || store == null) Problem.Unconfigured else null)
    val problem: StateFlow<Problem?> = mutableProblem.asStateFlow()
    private val mutablePro = MutableStateFlow(false)
    private val mutableSubscribedPrice = MutableStateFlow<String?>(null)

    /**
     * What [customer] pays a month, as the store words it: the monthly
     * product's price, when that is the product granting `pro`; null for
     * any other, or while that isn't known.
     */
    val subscribedPrice: StateFlow<String?> = mutableSubscribedPrice.asStateFlow()

    /**
     * Whether [customer] has `pro` now, as RevenueCat last said within a
     * day: any product that grants it, whatever is on sale. [hasPro] asks
     * at this moment.
     */
    val pro: StateFlow<Boolean> = mutablePro.asStateFlow()

    /** Whose subscription this is: this install's customer, made at its first ask. */
    val customer: String
        get() = preferences.getString(INSTALL, null)?.takeIf { isInstall(it) } ?: fresh()

    init {
        preferences.edit().apply { RETIRED.forEach { remove(it) } }.apply()
        publish()
        if (store != null) scope.launch { store.updates.collect { bought(it) } }
    }

    /** The month of 2 hours [customer] has now; null without `pro`, or when RevenueCat hasn't said within a day. */
    fun period(): ProMonth? = if (grantsPro) ProMonth.calendar(now()) else cache.period(customer, now())

    fun hasPro(): Boolean = period() != null

    /**
     * Launch and foreground: purchases left unfinished, whose subscription
     * the store account holds, what's on sale, and what RevenueCat says now.
     */
    fun refresh() {
        scope.launch { work.withLock { refreshing(restore = false) } }
    }

    /**
     * The store's purchase sheet for the monthly subscription, for the
     * customer it opens for, whose id the purchase carries: what comes of it
     * is posted for them. False if it couldn't open, or one is open.
     */
    suspend fun buy(activity: Activity): Boolean {
        val store = store ?: return false
        val (offer, account) = work.withLock {
            if (launching) return false
            val offer = monthly.takeIf { mutableOffer.value is Offer.OnSale } ?: return false
            launching = true
            offer to customer
        }
        if (store.buy(activity, offer, account)) return true
        work.withLock { launching = false }
        return false
    }

    /**
     * Restore: its customer adopted as at launch, then every subscription
     * the store account holds and has paid for posted again as a restore
     * with its own products, whatever is on sale and whatever was posted
     * before. True when RevenueCat then says [customer] has `pro`.
     */
    suspend fun restore(): Boolean = work.withLock {
        refreshing(restore = true)
        (cache.period(customer, now()) != null).also { restored ->
            if (restored) paywall(PaywallStep.Restored) else paywallError(restoreError(mutableProblem.value) ?: PurchaseError.NothingToRestore)
        }
    }

    private suspend fun refreshing(restore: Boolean) {
        val revenueCat = revenueCat ?: return publish()
        val store = store ?: return publish()
        val owned = store.owned()
        if (owned != null) adopt(owned)
        val asked = generation.get()
        val customer = customer
        mutableProblem.value = null
        // What's on sale only chooses what Subscribe buys.
        val offerings = revenueCat.offerings(customer)
        val found = (offerings as? Answer.Ok)?.let { RevenueCat.monthly(it.body) }?.let { (product, plan) -> store.monthly(product, plan) }
        if (asked != generation.get()) return
        monthly = found
        when {
            offerings !is Answer.Ok -> trouble(offerings)
            found == null -> mutableProblem.value = Problem.NoProduct
        }
        if (owned == null) mutableProblem.value = Problem.Unreached
        var unfinished = false
        for (purchase in owned.orEmpty()) {
            if (asked != generation.get()) return
            if (!purchase.purchased || (!restore && purchase.acknowledged)) continue
            if (!restore && hash(purchase.token) in posted()) {
                // RevenueCat has it; only the acknowledgement was left.
                store.acknowledge(purchase.token)
                continue
            }
            // Restoring, everything is the customer's now; otherwise only what names a customer, for them.
            val owner = if (restore) customer else ownerOf(purchase) ?: continue
            if (!post(revenueCat, store, purchase, owner, restore, asked)) unfinished = true
        }
        if (owned != null) unconfirmed = unfinished
        val answer = revenueCat.subscriber(customer)
        if (asked != generation.get()) return
        when (answer) {
            is Answer.Ok -> if (ProPass.answered(answer.body)) cache.save(customer, ProPass.from(answer.body), now())
            else -> trouble(answer)
        }
        if (!restore && answer is Answer.Ok && owned != null) migrate(revenueCat, store, owned, customer, asked)
        publish()
    }

    /**
     * The customer an active subscription the store account holds names,
     * made this install's when none of them is already: bought on another
     * phone with the same Google account, or by this install before a
     * reinstall. Nothing is posted; RevenueCat already has it under that
     * customer.
     */
    private fun adopt(owned: List<StorePurchase>) {
        val customer = customer
        val held = owned.filter { it.purchased }
        val named = held.mapNotNull { named(it.account) }
        val adopted = named.firstOrNull() ?: return
        if (customer in named || held.any { restored()[hash(it.token)] == customer }) return
        preferences.edit().putString(INSTALL, adopted).commit()
        generation.incrementAndGet()
        publish()
    }

    /**
     * The one restore this version makes by itself: the first time
     * RevenueCat answers for this install without `pro`, every subscription
     * the store account holds that names no customer is posted as a restore
     * for it. Done once RevenueCat has taken them all, or when there was
     * nothing to take; tried again at the next launch or foreground until
     * then.
     */
    private suspend fun migrate(revenueCat: RevenueCat, store: SubscriptionStore, owned: List<StorePurchase>, customer: String, asked: Long) {
        if (preferences.getBoolean(MIGRATED, false)) return
        var failed = false
        if (cache.period(customer, now()) == null) {
            for (purchase in owned) {
                if (!purchase.purchased || named(purchase.account) != null) continue
                if (asked != generation.get()) return
                if (!post(revenueCat, store, purchase, customer, restore = true, asked)) failed = true
            }
        }
        if (!failed) preferences.edit().putBoolean(MIGRATED, true).apply()
    }

    /**
     * What a purchase sheet came to, or a pending purchase now paid for:
     * each purchase posted for its own customer and acknowledged once
     * taken. Whatever it came to, the sheet has closed.
     */
    private suspend fun bought(update: StoreUpdate) = work.withLock {
        // The sheet was open: what came of it is the purchase's end. Otherwise a pending one was paid for.
        val sheet = launching
        launching = false
        when (update) {
            StoreUpdate.Cancelled -> if (sheet) paywall(PaywallStep.Cancelled)
            is StoreUpdate.Failed -> if (sheet) paywallError(storeError(update.code))
            is StoreUpdate.Purchases -> if (sheet && update.purchases.any { !it.purchased }) paywallError(PurchaseError.Pending)
        }
        val purchases = (update as? StoreUpdate.Purchases)?.purchases ?: return@withLock
        val revenueCat = revenueCat ?: return@withLock
        val store = store ?: return@withLock
        val asked = generation.get()
        for (purchase in purchases) {
            if (!purchase.purchased) continue
            if (hash(purchase.token) in posted()) {
                // Told again: RevenueCat has it already.
                if (!purchase.acknowledged) store.acknowledge(purchase.token)
                continue
            }
            val owner = ownerOf(purchase) ?: continue
            if (post(revenueCat, store, purchase, owner, restore = false, asked)) {
                paywall(PaywallStep.Purchased)
            } else {
                unconfirmed = true
                paywallError(PurchaseError.VerificationFailed)
            }
        }
        if (asked == generation.get()) publish()
    }

    /** A paywall step; Android sells one product, the subscription (`pro`). */
    private fun paywall(step: PaywallStep) = Analytics.record(AnalyticsEvent.Paywall(step, PurchaseProduct.Pro))

    private fun paywallError(error: PurchaseError) = Analytics.record(AnalyticsEvent.PaywallError(PurchaseProduct.Pro, error))

    /** What stood in a restore's way; null when there was simply nothing to restore. */
    private fun restoreError(problem: Problem?): PurchaseError? = when (problem) {
        null, Problem.NoProduct -> null
        Problem.Unconfigured -> PurchaseError.StoreUnavailable
        Problem.Unreached -> PurchaseError.Network
        is Problem.Refused, Problem.Unconfirmed -> PurchaseError.VerificationFailed
    }

    /** Play Billing's response code as `paywall_error`'s code. */
    private fun storeError(code: Int): PurchaseError = when (code) {
        BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE, BillingClient.BillingResponseCode.BILLING_UNAVAILABLE,
        BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> PurchaseError.StoreUnavailable
        BillingClient.BillingResponseCode.NETWORK_ERROR -> PurchaseError.Network
        BillingClient.BillingResponseCode.ITEM_UNAVAILABLE, BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED,
        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> PurchaseError.NotAllowed
        else -> PurchaseError.Unknown
    }

    /**
     * Posts [purchase] for [owner] (the customer who bought it; restoring,
     * the customer now), acknowledges it once RevenueCat has it, and keeps
     * RevenueCat's answer only for the customer of generation [asked].
     */
    private suspend fun post(revenueCat: RevenueCat, store: SubscriptionStore, purchase: StorePurchase, owner: String, restore: Boolean, asked: Long): Boolean {
        val customer = customer
        val basePlan = monthly?.takeIf { it.product in purchase.products }?.basePlan
        val answer = revenueCat.post(RevenueCat.Receipt(owner, purchase.token, purchase.products, basePlan, restore))
        if (answer !is Answer.Ok) {
            trouble(answer)
            return false
        }
        preferences.edit().putStringSet(POSTED, posted() + hash(purchase.token)).apply()
        // Restored: the purchase is its new customer's, for whatever the store says of it next.
        if (restore) preferences.edit().putString(RESTORED, Json.encodeToString(ACCOUNT_MAP, restored() + (hash(purchase.token) to owner))).commit()
        if (!purchase.acknowledged) store.acknowledge(purchase.token)
        if (owner == customer && asked == generation.get() && ProPass.answered(answer.body)) cache.save(customer, ProPass.from(answer.body), now())
        return true
    }

    private fun publish() {
        val pro = hasPro()
        mutablePro.value = pro
        // RevenueCat names a Play subscription by its product, or with its base plan after a colon.
        val product = cache.pass(customer, now())?.product
        mutableSubscribedPrice.value = monthly?.takeIf { pro && (product == it.product || product == "${it.product}:${it.basePlan}") }?.price
        mutableOffer.value = when {
            pro -> Offer.Subscribed
            unconfirmed -> Offer.Unavailable.also { mutableProblem.value = Problem.Unconfirmed }
            else -> monthly?.let { Offer.OnSale(it.price) } ?: Offer.Unavailable
        }
    }

    private fun trouble(answer: Answer) {
        mutableProblem.value = when (answer) {
            is Answer.Refused -> Problem.Refused(answer.status, answer.message)
            is Answer.Unreached -> Problem.Unreached
            is Answer.Ok -> return
        }
    }

    private fun posted(): Set<String> = preferences.getStringSet(POSTED, emptySet()).orEmpty()

    /** The purchases Restore moved, and to whom; one moved to a Happy account by an earlier version is no one's. */
    private fun restored(): Map<String, String> = preferences.getString(RESTORED, null)
        ?.let { runCatching { Json.decodeFromString(ACCOUNT_MAP, it) }.getOrNull() }.orEmpty().filterValues { isInstall(it) }

    /**
     * Whose [purchase] is: the customer it was last restored for, else the
     * one its store id names (an earlier version's, the SHA-256 of this
     * install's id, as this install's own); null for one that names no one.
     */
    private fun ownerOf(purchase: StorePurchase): String? {
        restored()[hash(purchase.token)]?.let { return it }
        named(purchase.account)?.let { return it }
        val customer = customer
        return customer.takeIf { purchase.account == hash(it) }
    }

    /** A new anonymous install customer, as RevenueCat's SDK makes them. */
    private fun fresh(): String {
        val id = ANONYMOUS + UUID.randomUUID().toString().replace("-", "").lowercase()
        preferences.edit().putString(INSTALL, id).commit()
        return id
    }

    companion object {
        const val PREFS_NAME = "voice-subscription"
        const val ANONYMOUS = "\$RCAnonymousID:"
        private const val INSTALL = "install"
        private const val RESTORED = "restored"
        private const val POSTED = "posted"
        private const val MIGRATED = "migrated"

        /** Earlier versions', when the Happy account could be the customer: cleared, never read. */
        private val RETIRED = listOf("customer", "accounts", "posted-by-install")

        private val ACCOUNT_MAP = MapSerializer(String.serializer(), String.serializer())
        private val INSTALL_ID = Regex("""\${'$'}RCAnonymousID:[0-9a-f]{32}""")

        /** Whether a build of [buildType] grants `pro` itself: the preview app, decided when it is built. */
        fun grantsPro(buildType: String): Boolean = buildType == "preview"

        /** Whether [id] is an install's customer, as [fresh] makes them. */
        fun isInstall(id: String): Boolean = INSTALL_ID.matches(id)

        /**
         * The customer a purchase's obfuscated account id names: the id
         * itself, when it is an install's; null for none. Earlier versions,
         * and RevenueCat's SDK, sent the SHA-256 of the customer id, which
         * names no one.
         */
        fun named(account: String?): String? = account?.takeIf { isInstall(it) }

        private fun hash(token: String) = MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
