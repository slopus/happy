package com.slopus.happy.call

import android.app.Activity
import android.content.SharedPreferences
import com.slopus.happy.payments.RevenueCat
import com.slopus.happy.payments.RevenueCat.Answer
import com.slopus.happy.payments.StoreOffer
import com.slopus.happy.payments.StorePurchase
import com.slopus.happy.payments.VoiceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest
import java.util.UUID

/**
 * Voice's subscription: RevenueCat's `pro`, bought through the store
 * ([VoiceStore]) and told to RevenueCat's REST API ([RevenueCat]), without
 * its SDK. Whose it is: the Happy account's when one is signed in ([relay],
 * the subject RevenueCat already knows it by), otherwise this install's own
 * anonymous customer. Signing in merges what the install bought into the
 * account (`identify`) before the account is used; signing out starts a new
 * install customer, never the one an account was merged with.
 *
 * Access is only what RevenueCat says, kept a day at most ([VoicePassCache]).
 * Everything that asks RevenueCat or the store, or changes the customer,
 * runs one at a time ([work]), so no answer lands on a customer it wasn't
 * for. A purchase is acknowledged only once RevenueCat has taken it.
 */
class VoiceSubscription(
    private val scope: CoroutineScope,
    private val store: VoiceStore?,
    private val revenueCat: RevenueCat?,
    private val preferences: SharedPreferences,
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

        /** The store holds a voice subscription RevenueCat hasn't confirmed: nothing to sell, nothing granted. */
        data object Unconfirmed : Problem
    }

    private val cache = VoicePassCache(preferences)
    private val work = Mutex()
    private var relay: String? = null
    private var monthly: StoreOffer? = null
    private var unconfirmed = false

    private val mutableOffer = MutableStateFlow<CallOffer>(CallOffer.Unavailable)
    val offer: StateFlow<CallOffer> = mutableOffer.asStateFlow()
    private val mutableProblem = MutableStateFlow<Problem?>(if (revenueCat == null || store == null) Problem.Unconfigured else null)
    val problem: StateFlow<Problem?> = mutableProblem.asStateFlow()

    /** Whose subscription voice asks about now. */
    val customer: String get() = preferences.getString(CUSTOMER, null) ?: install

    private val install: String
        get() = preferences.getString(INSTALL, null) ?: fresh()

    init {
        publish()
        if (store != null) scope.launch { store.updates.collect { bought(it) } }
    }

    /** The month of 5 hours [customer] has now; null without `pro`, or when RevenueCat hasn't said within a day. */
    fun period(): VoicePeriod? = cache.period(customer, now())

    /**
     * The Happy account signed in now, by its subject; null when none.
     * Another account is switched to, never merged into; signing out starts
     * a new install customer.
     */
    fun relay(subject: String?) {
        scope.launch {
            work.withLock {
                relay = subject
                if (subject == null && preferences.getString(CUSTOMER, null) != null) {
                    // Whatever the account was merged with stays the account's.
                    fresh()
                    preferences.edit().remove(CUSTOMER).remove(POSTED_BY_INSTALL).apply()
                }
                settle()
                publish()
            }
        }
    }

    /** Launch and foreground: what's on sale, purchases RevenueCat hasn't had, and what RevenueCat says now. */
    fun refresh() {
        scope.launch { work.withLock { refreshing() } }
    }

    /** The store's purchase sheet for the monthly subscription; what comes of it arrives through the store. */
    suspend fun buy(activity: Activity): Boolean {
        val offer = work.withLock { monthly.takeIf { mutableOffer.value is CallOffer.OnSale } } ?: return false
        return store?.buy(activity, offer) == true
    }

    /**
     * Restore: every voice subscription the store account holds and has
     * paid for, posted again as a restore whatever was posted before.
     * True when RevenueCat then says [customer] has `pro`.
     */
    suspend fun restore(): Boolean = work.withLock {
        refreshing(restore = true)
        cache.period(customer, now()) != null
    }

    private suspend fun refreshing(restore: Boolean = false) {
        val revenueCat = revenueCat ?: return publish()
        val store = store ?: return publish()
        if (!settle()) return publish()
        val customer = customer
        mutableProblem.value = null
        monthly = when (val answer = revenueCat.offerings(customer)) {
            is Answer.Ok -> RevenueCat.monthly(answer.body)?.let { (product, plan) -> store.monthly(product, plan) }
                .also { if (it == null) mutableProblem.value = Problem.NoProduct }
            else -> null.also { trouble(answer) }
        }
        val product = monthly?.product
        if (product != null) {
            val owned = store.owned()
            if (owned == null) mutableProblem.value = Problem.Unreached
            for (purchase in owned.orEmpty()) {
                if (product !in purchase.products || !purchase.purchased) continue
                if (!restore && hash(purchase.token) in posted()) {
                    if (!purchase.acknowledged) store.acknowledge(purchase.token)
                    continue
                }
                post(revenueCat, store, purchase, product, restore)
            }
            unconfirmed = owned.orEmpty().any { product in it.products && it.purchased }
        }
        when (val answer = revenueCat.subscriber(customer)) {
            is Answer.Ok -> if (VoicePass.answered(answer.body)) cache.save(customer, VoicePass.from(answer.body), now())
            else -> trouble(answer)
        }
        publish()
    }

    /** What the store sent after a buy, or a pending purchase now paid for: posted, and acknowledged once taken. */
    private suspend fun bought(purchases: List<StorePurchase>) = work.withLock {
        val revenueCat = revenueCat ?: return@withLock
        val store = store ?: return@withLock
        val product = monthly?.product ?: return@withLock
        if (!settle()) return@withLock publish()
        for (purchase in purchases) {
            if (product in purchase.products && purchase.purchased) post(revenueCat, store, purchase, product, restore = false)
        }
        publish()
    }

    private suspend fun post(revenueCat: RevenueCat, store: VoiceStore, purchase: StorePurchase, product: String, restore: Boolean) {
        val customer = customer
        val answer = revenueCat.post(RevenueCat.Receipt(customer, purchase.token, product, monthly?.basePlan, restore))
        if (answer !is Answer.Ok) return trouble(answer)
        preferences.edit()
            .putStringSet(POSTED, posted() + hash(purchase.token))
            .apply { if (preferences.getString(CUSTOMER, null) == null) putBoolean(POSTED_BY_INSTALL, true) }
            .apply()
        if (!purchase.acknowledged) store.acknowledge(purchase.token)
        if (VoicePass.answered(answer.body)) cache.save(customer, VoicePass.from(answer.body), now())
    }

    /**
     * Brings [customer] to the signed-in account. What the install bought is
     * merged into it first (`identify`); until that is done the install
     * stays the customer, so nothing it bought is posted under the account.
     * False while it isn't.
     */
    private suspend fun settle(): Boolean {
        val relay = relay ?: return true
        if (preferences.getString(CUSTOMER, null) == relay) return true
        if (preferences.getBoolean(POSTED_BY_INSTALL, false) && preferences.getString(CUSTOMER, null) == null) {
            val revenueCat = revenueCat ?: return false
            val answer = revenueCat.identify(install, relay)
            if (answer !is Answer.Ok) {
                trouble(answer)
                return false
            }
            // Merged: the install's id is the account's from now on, never this install's again.
            fresh()
        }
        preferences.edit().putString(CUSTOMER, relay).remove(POSTED_BY_INSTALL).apply()
        return true
    }

    private fun publish() {
        mutableOffer.value = when {
            period() != null -> CallOffer.Subscribed
            unconfirmed -> CallOffer.Unavailable.also { mutableProblem.value = Problem.Unconfirmed }
            else -> monthly?.let { CallOffer.OnSale(it.price) } ?: CallOffer.Unavailable
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

    /** A new anonymous install customer, as RevenueCat's SDK makes them. */
    private fun fresh(): String {
        val id = ANONYMOUS + UUID.randomUUID().toString().replace("-", "").lowercase()
        preferences.edit().putString(INSTALL, id).apply()
        return id
    }

    companion object {
        const val PREFS_NAME = "voice-subscription"
        const val ANONYMOUS = "\$RCAnonymousID:"
        private const val INSTALL = "install"
        private const val CUSTOMER = "customer"
        private const val POSTED = "posted"
        private const val POSTED_BY_INSTALL = "posted-by-install"

        private fun hash(token: String) = MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
