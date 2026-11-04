package com.slopus.happy.call

import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The voice time this device has spent on calls (iOS `CallUsage`): one span
 * per call, from the moment it connected to the moment it ended, or the last
 * time it was counted should the app die mid-call. Connecting and failed
 * calls spend nothing. Times are wall-clock milliseconds.
 */
@Serializable
data class CallUsage(val spans: List<Span> = emptyList()) {
    @Serializable
    data class Span(val id: String, val start: Long, val end: Long)

    /**
     * Milliseconds spent since [window] before [now]; a span across that
     * edge counts only the part after it. A span after [now] (the clock was
     * put back) counts whole: turning the clock back gives no time back.
     */
    fun used(now: Long, window: Long): Long = usedSince(now - window)

    /** Milliseconds spent since [from], counted as [used] counts them. */
    fun usedSince(from: Long): Long = spans.sumOf { maxOf(0L, it.end - maxOf(it.start, from)) }

    /** Counts a call up to [end]; the same call again only grows its span. */
    fun record(id: String, start: Long, end: Long): CallUsage {
        val index = spans.indexOfFirst { it.id == id }
        return if (index >= 0) {
            CallUsage(spans.toMutableList().also { it[index] = it[index].copy(end = maxOf(it[index].end, end)) })
        } else {
            CallUsage(spans + Span(id, start, maxOf(start, end)))
        }
    }

    /**
     * When, after [now], less than [free] is spent again, as the older calls
     * pass out of the [window]; rounded up to the second. Null when it never
     * is (a span after [now], from a clock put back, never passes out).
     */
    fun freeAgain(now: Long, free: Long, window: Long): Long? {
        if (used(now, window) < free) return now
        var low = now
        var high = now + window
        if (used(high, window) >= free) return null
        while (high - low > 1) {
            val middle = low + (high - low) / 2
            if (used(middle, window) < free) high = middle else low = middle
        }
        return (high + 999) / 1000 * 1000
    }

    fun forget(before: Long): CallUsage = CallUsage(spans.filter { it.end >= before })
}

interface CallUsageStore {
    fun load(): CallUsage
    fun save(usage: CallUsage)
}

/** This device's spans, kept across sign-outs: they count the device, not an account. */
class PreferencesCallUsageStore(private val preferences: SharedPreferences) : CallUsageStore {
    override fun load(): CallUsage = preferences.getString(KEY, null)
        ?.let { runCatching { Json.decodeFromString<CallUsage>(it) }.getOrNull() } ?: CallUsage()

    override fun save(usage: CallUsage) {
        preferences.edit().putString(KEY, Json.encodeToString(CallUsage.serializer(), usage)).apply()
    }

    companion object {
        const val PREFS_NAME = "call-usage"
        private const val KEY = "usage"
    }
}

/**
 * The voice time a device has on agent calls (iOS `CallAllowance`), counted
 * here: 20 free minutes in any 30 days, rolling, or, while the subscription
 * gives a [period], 5 hours in that billing period instead. Provisional, like
 * the public agent it goes with: nothing on a server counts or enforces it.
 * Not a number of calls, and no other cap. Used on the main thread.
 */
class CallAllowance(
    private val store: CallUsageStore,
    private val free: Long = FREE_MILLIS,
    private val window: Long = WINDOW_MILLIS,
    private val period: () -> VoicePeriod? = { null },
) {
    private var usage = store.load()

    fun remaining(now: Long): Long {
        period()?.let { return maxOf(0L, PAID_MILLIS - usage.usedSince(it.start)) }
        return maxOf(0L, free - usage.used(now, window))
    }

    /** When some time is back, once it has all been used: the free time's, or the period's end. */
    fun freeAgain(now: Long): Long? {
        period()?.let { return it.end }
        return usage.freeAgain(now, free, window)
    }

    fun record(id: String, start: Long, end: Long) {
        // Kept long enough for a whole billing period, the longest month and then some.
        usage = usage.record(id, start, end).forget(end - maxOf(window, KEEP_MILLIS))
        store.save(usage)
    }

    companion object {
        const val FREE_MILLIS = 20 * 60 * 1000L
        const val WINDOW_MILLIS = 30 * 24 * 60 * 60 * 1000L
        const val PAID_MILLIS = 5 * 60 * 60 * 1000L
        const val KEEP_MILLIS = 40 * 24 * 60 * 60 * 1000L
    }
}

/**
 * What voice's sheets offer: the subscription, RevenueCat's `pro`, at the
 * store's price ([VoiceSubscription]); nothing, where the build has no
 * RevenueCat key or the store or RevenueCat has no monthly product to sell;
 * or nothing because this customer has `pro` already.
 */
sealed interface CallOffer {
    data object Unavailable : CallOffer

    /** The monthly subscription, at [price] as the store words it. */
    data class OnSale(override val price: String) : CallOffer

    /** This customer has `pro`: 5 hours a month, nothing to sell. */
    data object Subscribed : CallOffer

    /**
     * Debug builds' test screens only (`happy.call.offer`): the subscription
     * drawn as if it were on sale, its button a preview that charges and
     * grants nothing. Never in a release build ([CallController.offer]).
     */
    data class Preview(override val price: String) : CallOffer

    val onSale: Boolean get() = this is OnSale || this is Preview

    /** The price drawn, where something is on sale. */
    val price: String? get() = null

    companion object {
        /** The debug preview's price, standing in for the store's own. */
        const val PRICE = "$20"
    }
}

/** Which of voice's sheets is up ([CallController.sheet]). */
sealed interface CallSheet {
    val offer: CallOffer

    /** The same sheet, offering [offer] now. */
    fun offering(offer: CallOffer): CallSheet = when (this) {
        is Welcome -> copy(offer = offer)
        is Used -> copy(offer = offer)
    }

    /** Before the first call. */
    data class Welcome(override val offer: CallOffer) : CallSheet

    /** The free time is used; when some is back on the wall clock, if that is known. */
    data class Used(val freeAgain: Long?, override val offer: CallOffer) : CallSheet
}

/**
 * Whether this device has seen voice's welcome (iOS `CallIntro`). It shows
 * once, on the first tap of the voice button while a subscription is on
 * sale; from then on, however it was closed, the button calls. Beside the
 * device's free time ([PreferencesCallUsageStore]).
 */
class CallIntro(private val preferences: SharedPreferences) {
    val due: Boolean get() = !preferences.getBoolean(KEY, false)

    /** The welcome to show for a tap of the voice button while [offer] is up, counted as seen; null when the button just calls. */
    fun welcome(offer: CallOffer): CallSheet.Welcome? {
        if (!offer.onSale || !due) return null
        seen()
        return CallSheet.Welcome(offer)
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
