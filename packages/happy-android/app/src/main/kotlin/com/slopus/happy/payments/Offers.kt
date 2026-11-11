package com.slopus.happy.payments

import android.app.Activity
import android.content.SharedPreferences
import com.slopus.happy.BuildConfig
import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.PaywallStep
import com.slopus.happy.analytics.PurchaseProduct
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * What the app's offer sheets sell: the subscription, RevenueCat's `pro`,
 * at the store's price ([Subscription]); nothing, where the build has no
 * RevenueCat key or the store or RevenueCat has no monthly product to sell;
 * or nothing because this customer has `pro` already.
 */
sealed interface Offer {
    data object Unavailable : Offer

    /** The monthly subscription, at [price] as the store words it. */
    data class OnSale(override val price: String) : Offer

    /** This customer has `pro`: 2 hours of voice a month, nothing to sell. */
    data object Subscribed : Offer

    /**
     * Debug builds' test screens only (`happy.call.offer`): the subscription
     * drawn as if it were on sale, its button a preview that charges and
     * grants nothing. Never in a release build ([Offers.offer]).
     */
    data class Preview(override val price: String) : Offer

    val onSale: Boolean get() = this is OnSale || this is Preview

    /** The price drawn, where something is on sale. */
    val price: String? get() = null

    companion object {
        /** The debug preview's price, standing in for the store's own. */
        const val PRICE = "$20"
    }
}

/**
 * Which offer sheet is up ([Offers.sheet]) and what it is for. One
 * subscription, one way to buy it; what the sheet says depends on where it
 * was opened.
 */
sealed interface OfferSheet {
    val offer: Offer

    /** The same sheet, offering [offer] now. */
    fun offering(offer: Offer): OfferSheet = when (this) {
        is Welcome -> copy(offer = offer)
        is Used -> copy(offer = offer)
        is Required -> copy(offer = offer)
    }

    /** Voice's welcome, before a first call: its "Start Voice Session" goes on to the call, for free. */
    data class Welcome(override val offer: Offer) : OfferSheet

    /** Voice's free time is used; when some is back on the wall clock, if that is known. Its start is greyed out. */
    data class Used(val freeAgain: Long?, override val offer: Offer) : OfferSheet

    /** The relay's voice is refused without the subscription: voice's sheet with no free way on. */
    data class Required(override val offer: Offer) : OfferSheet
}

/** How an offer sheet was closed. */
enum class OfferResult {
    /** The welcome's "Start Voice Session": go on, for free. */
    Start,

    /** `pro` came while it was up: bought or restored. */
    Pro,

    /** Closed by its ✕, back or a swipe, or another sheet was already up: nothing more. */
    Dismissed,
}

/** What the sheets' "Restore Purchases" found. */
enum class RestoreResult { Restored, NothingFound, Failed }

/**
 * Whether this device has seen voice's welcome (iOS `CallIntro`). It shows
 * once, on the first tap of a voice button while a subscription is on sale
 * (the agent's voice, or the relay's before a first call); from then on,
 * however it was closed, the button calls. Beside the device's free voice
 * time (`PreferencesCallUsageStore`).
 */
class CallIntro(private val preferences: SharedPreferences) {
    val due: Boolean get() = !preferences.getBoolean(KEY, false)

    /** Whether a tap of a voice button while [offer] is up shows the welcome, counted as seen; false when the button just calls. */
    fun welcomes(offer: Offer): Boolean {
        if (!offer.onSale || !due) return false
        seen()
        return true
    }

    /** Shown: the voice button calls from now on. */
    fun seen() {
        preferences.edit().putBoolean(KEY, true).apply()
    }

    /** Debug builds' test runs: the welcome is due again. */
    fun reset() {
        preferences.edit().remove(KEY).apply()
    }

    companion object {
        const val KEY = "call.intro.seen"
    }
}

/**
 * The app's offer sheets, one at a time, for everything that sells the
 * subscription: the agent's voice, the relay's voice, Support us. Shown by
 * the app's one host (`ui/payments/OfferHost`), bought and restored through
 * the one [Subscription]. Safe to call from any thread.
 */
class Offers(
    private val scope: CoroutineScope,
    private val subscription: Subscription,
    val intro: CallIntro,
) {
    private val guard = Any()
    private val mutableSheet = MutableStateFlow<OfferSheet?>(null)
    /** The sheet that is up, if one is. */
    val sheet: StateFlow<OfferSheet?> = mutableSheet.asStateFlow()
    private var answer: CompletableDeferred<OfferResult>? = null
    private var proBefore = false

    /** Debug builds' test screens only: the subscription drawn as if on sale ([offer]). */
    private val testOffer = MutableStateFlow<Offer.Preview?>(null)

    /**
     * What the sheets offer ([Subscription.offer]). Debug builds draw the
     * subscription as if it were on sale for their test screens when asked
     * ([preview]), a preview that charges and grants nothing; a release
     * build never.
     */
    val offers: StateFlow<Offer> = combine(testOffer, subscription.offer) { test, offer -> test?.takeIf { BuildConfig.DEBUG } ?: offer }
        .stateIn(scope, SharingStarted.Eagerly, subscription.offer.value)
    val offer: Offer get() = offers.value

    /** What a subscriber pays a month, as the store words it, where that is known ([Subscription.subscribedPrice]). */
    val subscribedPrice: StateFlow<String?> = subscription.subscribedPrice

    /** The store holds a subscription RevenueCat hasn't confirmed yet. */
    val unconfirmed: StateFlow<Boolean> = subscription.problem.map { it == Subscription.Problem.Unconfirmed }
        .stateIn(scope, SharingStarted.Eagerly, false)

    init {
        // Bought or restored while a sheet is up: it has done its work. The used-up sheet waits for its caller, which knows whether there is time again.
        subscription.pro.filter { it }.onEach {
            if (!proBefore && sheet.value.let { it != null && it !is OfferSheet.Used }) close(OfferResult.Pro)
        }.launchIn(scope)
    }

    /**
     * Shows [sheet], unless one is up already, and answers how it was closed
     * ([OfferResult]). Cancelling the caller takes the sheet away.
     */
    suspend fun ask(sheet: OfferSheet): OfferResult {
        val waiting = synchronized(guard) {
            if (mutableSheet.value != null) return OfferResult.Dismissed
            proBefore = subscription.hasPro()
            CompletableDeferred<OfferResult>().also {
                answer = it
                mutableSheet.value = sheet
            }
        }
        // A sheet with the subscription for sale on it; Android sells that one product.
        if (sheet.offer is Offer.OnSale) Analytics.record(AnalyticsEvent.Paywall(PaywallStep.Presented, PurchaseProduct.Pro))
        try {
            return waiting.await()
        } finally {
            synchronized(guard) {
                if (answer === waiting) {
                    answer = null
                    mutableSheet.value = null
                }
            }
        }
    }

    /** [ask] for [sheet], answered to no one. */
    fun show(sheet: OfferSheet) {
        scope.launch { ask(sheet) }
    }

    /**
     * The relay's voice asking for the subscription (`VoicePaywall`): true
     * to go on. Refused without it (`voice_must_pay`), only once it is
     * bought or restored on the Required sheet; before a first call
     * (`voice_trial_eligible`), voice's welcome where one is due, its start
     * or a purchase going on and its close not.
     */
    suspend fun relayVoice(flow: String): Boolean = when (flow) {
        "voice_must_pay" -> ask(OfferSheet.Required(offer)) == OfferResult.Pro
        else -> !welcomes() || ask(OfferSheet.Welcome(offer)) != OfferResult.Dismissed
    }

    /** Whether a voice button's tap now shows voice's welcome first, counted as seen ([CallIntro]). */
    fun welcomes(): Boolean = intro.welcomes(offer)

    /** The welcome's "Start Voice Session". */
    fun start() {
        if (sheet.value is OfferSheet.Welcome) close(OfferResult.Start)
    }

    /** Closed by its ✕, back or a swipe; [OfferResult.Pro] if `pro` came while it was up. */
    fun dismiss() {
        close(if (!proBefore && subscription.hasPro()) OfferResult.Pro else OfferResult.Dismissed)
    }

    /** Whatever is up goes, answering [result]. */
    fun close(result: OfferResult = OfferResult.Dismissed) {
        val waiting = synchronized(guard) {
            mutableSheet.value = null
            answer.also { answer = null }
        }
        waiting?.complete(result)
    }

    /** The sheets' "Subscribe": the store's purchase sheet; false if it couldn't open. */
    suspend fun subscribe(activity: Activity): Boolean = subscription.buy(activity)

    /** The sheets' "Restore Purchases". */
    suspend fun restore(): RestoreResult = when {
        subscription.restore() -> RestoreResult.Restored
        subscription.problem.value.let { it != null && it != Subscription.Problem.NoProduct } -> RestoreResult.Failed
        else -> RestoreResult.NothingFound
    }

    /** Debug builds' test runs: draw the subscription as on sale at [price], or as it really is (null). */
    fun preview(price: String?) {
        testOffer.value = price?.let(Offer::Preview)
    }
}
