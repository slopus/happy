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
import java.util.concurrent.atomic.AtomicLong

/**
 * Voice's subscription: RevenueCat's `pro`, bought through the store
 * ([VoiceStore]) and told to RevenueCat's REST API ([RevenueCat]), without
 * its SDK. Whose it is: the Happy account's when one is signed in (by the
 * subject RevenueCat already knows it by), otherwise this install's own
 * anonymous customer. Signing in merges the install into the account
 * (`identify`) before the account is used; signing out starts a new install
 * customer, never the one an account was merged with.
 *
 * Access is only what RevenueCat says, kept a day at most ([VoicePassCache]).
 * Everything that asks RevenueCat or the store runs one at a time ([work]),
 * and each customer change starts a new [generation] at once: an answer
 * asked under an older one is dropped. A purchase belongs to the customer
 * who opened the store's sheet ([OWNER], kept until RevenueCat has it), is
 * acknowledged only once RevenueCat has taken it, and one left unfinished
 * is finished at the next launch or foreground. Restore posts every
 * subscription the store account holds, whatever is on sale now.
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

        /** The store holds a purchase RevenueCat hasn't taken yet: nothing to sell, nothing granted. */
        data object Unconfirmed : Problem
    }

    private val cache = VoicePassCache(preferences)
    private val work = Mutex()
    private val generation = AtomicLong()
    @Volatile private var relay: String? = null
    @Volatile private var told = false
    /** A customer change not yet settled: nothing is granted meanwhile. */
    @Volatile private var changing = false
    private var monthly: StoreOffer? = null
    private var unconfirmed = false

    private val mutableOffer = MutableStateFlow<CallOffer>(CallOffer.Unavailable)
    val offer: StateFlow<CallOffer> = mutableOffer.asStateFlow()
    private val mutableProblem = MutableStateFlow<Problem?>(if (revenueCat == null || store == null) Problem.Unconfigured else null)
    val problem: StateFlow<Problem?> = mutableProblem.asStateFlow()

    /** Whose subscription voice asks about now. */
    val customer: String get() = preferences.getString(CUSTOMER, null) ?: install

    /** The Happy account's subject when [customer] is one, null when it is this install's. */
    val account: String? get() = preferences.getString(CUSTOMER, null)

    private val install: String
        get() = preferences.getString(INSTALL, null) ?: fresh()

    init {
        publish()
        if (store != null) scope.launch { store.updates.collect { bought(it) } }
    }

    /** The month of 5 hours [customer] has now; null without `pro`, or when RevenueCat hasn't said within a day. */
    fun period(): VoicePeriod? = if (changing) null else cache.period(customer, now())

    /**
     * The Happy account signed in now, by its subject; null when none.
     * Whatever was being asked for the customer before is dropped at once.
     * Another account is switched to, never merged into; signing out starts
     * a new install customer.
     */
    fun relay(subject: String?) {
        if (told && relay == subject) return
        told = true
        relay = subject
        val asked = generation.incrementAndGet()
        changing = true
        mutableOffer.value = CallOffer.Unavailable
        scope.launch {
            work.withLock {
                if (subject == null && preferences.getString(CUSTOMER, null) != null) {
                    // Whatever the account was merged with stays the account's.
                    fresh()
                    preferences.edit().remove(CUSTOMER).remove(POSTED_BY_INSTALL).apply()
                }
                settle()
                if (asked == generation.get()) changing = false
                publish()
            }
        }
    }

    /** Launch and foreground: what's on sale, purchases left unfinished, and what RevenueCat says now. */
    fun refresh() {
        scope.launch { work.withLock { refreshing(restore = false) } }
    }

    /**
     * The store's purchase sheet for the monthly subscription, for the
     * customer it opens for: what comes of it is posted for them, whoever
     * is signed in by then.
     */
    suspend fun buy(activity: Activity): Boolean {
        val offer = work.withLock {
            val offer = monthly.takeIf { mutableOffer.value is CallOffer.OnSale } ?: return false
            preferences.edit().putString(OWNER, customer).commit()
            offer
        }
        return store?.buy(activity, offer) == true
    }

    /**
     * Restore: every subscription the store account holds and has paid
     * for, posted again as a restore with its own products, whatever is on
     * sale and whatever was posted before. True when RevenueCat then says
     * [customer] has `pro`.
     */
    suspend fun restore(): Boolean = work.withLock {
        val asked = generation.get()
        refreshing(restore = true)
        asked == generation.get() && cache.period(customer, now()) != null
    }

    private suspend fun refreshing(restore: Boolean) {
        val revenueCat = revenueCat ?: return publish()
        val store = store ?: return publish()
        if (!settle()) return publish()
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
        val owned = store.owned()
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
            if (!post(revenueCat, store, purchase, restore, asked)) unfinished = true
        }
        if (owned != null) unconfirmed = unfinished
        val answer = revenueCat.subscriber(customer)
        if (asked != generation.get()) return
        when (answer) {
            is Answer.Ok -> if (VoicePass.answered(answer.body)) cache.save(customer, VoicePass.from(answer.body), now())
            else -> trouble(answer)
        }
        publish()
    }

    /** What the store sent after a buy, or a pending purchase now paid for: posted for its owner, and acknowledged once taken. */
    private suspend fun bought(purchases: List<StorePurchase>) = work.withLock {
        val revenueCat = revenueCat ?: return@withLock
        val store = store ?: return@withLock
        settle()
        val asked = generation.get()
        for (purchase in purchases) {
            if (purchase.purchased && !post(revenueCat, store, purchase, restore = false, asked)) unconfirmed = true
        }
        if (asked == generation.get()) publish()
    }

    /**
     * Posts [purchase] for the customer who bought it (restoring, for the
     * customer now), acknowledges it once RevenueCat has it, and keeps
     * RevenueCat's answer only for the customer of generation [asked].
     */
    private suspend fun post(revenueCat: RevenueCat, store: VoiceStore, purchase: StorePurchase, restore: Boolean, asked: Long): Boolean {
        val customer = customer
        val owner = if (restore) customer else preferences.getString(OWNER, null) ?: customer
        val basePlan = monthly?.takeIf { it.product in purchase.products }?.basePlan
        val answer = revenueCat.post(RevenueCat.Receipt(owner, purchase.token, purchase.products, basePlan, restore))
        if (answer !is Answer.Ok) {
            trouble(answer)
            return false
        }
        preferences.edit()
            .putStringSet(POSTED, posted() + hash(purchase.token))
            .remove(OWNER)
            .apply { if (owner == install && preferences.getString(CUSTOMER, null) == null) putBoolean(POSTED_BY_INSTALL, true) }
            .apply()
        if (!purchase.acknowledged) store.acknowledge(purchase.token)
        if (owner == customer && asked == generation.get() && VoicePass.answered(answer.body)) cache.save(customer, VoicePass.from(answer.body), now())
        return true
    }

    /**
     * Brings [customer] to the signed-in account. What the install bought is
     * merged into it first (`identify`); until that is done the install
     * stays the customer, so nothing is posted under the account in its
     * name. False while it isn't.
     */
    private suspend fun settle(): Boolean {
        val relay = relay ?: return true
        if (preferences.getString(CUSTOMER, null) == relay) return true
        if (preferences.getString(CUSTOMER, null) == null && preferences.getBoolean(POSTED_BY_INSTALL, false)) {
            val revenueCat = revenueCat ?: return false
            val asked = generation.get()
            val answer = revenueCat.identify(install, relay)
            if (answer is Answer.Ok) {
                // Merged, whatever happened here meanwhile: the install's id is the account's from now on, never this install's again.
                fresh()
                preferences.edit().remove(POSTED_BY_INSTALL).apply()
            }
            if (asked != generation.get()) return false
            if (answer !is Answer.Ok) {
                trouble(answer)
                return false
            }
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
        private const val OWNER = "owner"
        private const val POSTED = "posted"
        private const val POSTED_BY_INSTALL = "posted-by-install"

        private fun hash(token: String) = MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
