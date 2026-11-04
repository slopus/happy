package com.slopus.happy.call

import android.content.SharedPreferences
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * One month of the subscription's voice hours: [start] to [end] (never past
 * the entitlement's expiry). [key] names it, whatever later answers say of
 * the expiry, so its hours are counted against one key.
 */
data class VoicePeriod(val product: String, val start: Long, val end: Long?) {
    val key: String get() = "$product@$start"
}

/**
 * RevenueCat's word on a customer's `pro` entitlement, from a subscriber
 * response (`GET /v1/subscribers/{id}`, `POST /v1/receipts`): the product
 * that grants it, its latest purchase (a renewal is a new one), when it
 * expires (null: never) and RevenueCat's own time when it answered
 * ([checkedAt], its `request_date`).
 */
@Serializable
data class VoicePass(val product: String, val purchased: Long, val expires: Long?, val checkedAt: Long) {
    /** Active at RevenueCat's [at]: the device's clock decides nothing here. */
    fun active(at: Long = checkedAt): Boolean = expires == null || expires > at

    /**
     * The month whose hours count at RevenueCat's [at]. A monthly product's
     * is its purchase to its expiry: a renewal is a new purchase, and grace
     * moves the expiry (up to a month more on either store) but never the
     * purchase, so it never starts a new month. Anything longer, a year or
     * a lifetime, is cut into months from its purchase. Null when not
     * [active].
     */
    fun period(at: Long = checkedAt): VoicePeriod? {
        if (!active(at)) return null
        if (expires != null && expires - purchased <= MONTH_AND_GRACE_MILLIS) return VoicePeriod(product, purchased, expires)
        val purchase = Instant.ofEpochMilli(purchased).atOffset(ZoneOffset.UTC)
        fun month(n: Long) = purchase.plusMonths(n).toInstant().toEpochMilli()
        var months = 0L
        while (month(months + 1) <= at) months++
        return VoicePeriod(product, month(months), expires?.let { minOf(it, month(months + 1)) } ?: month(months + 1))
    }

    companion object {
        const val ENTITLEMENT = "pro"

        /** The longest a monthly subscription's entitlement runs: 31 days and the App Store's longest grace, 28. */
        private const val MONTH_AND_GRACE_MILLIS = 59 * 24 * 60 * 60 * 1000L

        /** The `pro` entitlement in a subscriber response; null where it has none, or the response isn't one. */
        fun from(response: JsonElement): VoicePass? {
            val checkedAt = date(response.obj?.get("request_date").str) ?: return null
            val granted = response.obj?.get("subscriber").obj?.get("entitlements").obj?.get(ENTITLEMENT).obj ?: return null
            val product = granted["product_identifier"].str ?: return null
            val purchased = date(granted["purchase_date"].str) ?: return null
            val expiresText = granted["expires_date"].str
            val expires = expiresText?.let { date(it) ?: return null }
            return VoicePass(product, purchased, expires, checkedAt)
        }

        /** Whether [response] is a subscriber response at all, with `pro` or without. */
        fun answered(response: JsonElement): Boolean =
            date(response.obj?.get("request_date").str) != null && response.obj?.get("subscriber").obj != null

        private fun date(text: String?): Long? = text?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
    }
}

/**
 * The last [VoicePass] RevenueCat gave a customer, and the device's clock
 * when it did. Used until RevenueCat says otherwise, only while it would
 * still be active at RevenueCat's time moved on by the device's, and never
 * longer than [maxAge] since it was asked: past that, or with the clock put
 * back, access is unknown and nothing is granted until RevenueCat answers.
 */
class VoicePassCache(private val preferences: SharedPreferences, private val maxAge: Long = MAX_AGE_MILLIS) {
    @Serializable private data class Entry(val customer: String, val pass: VoicePass?, val askedAt: Long)

    /** RevenueCat's answer for [customer] at device time [now]; a null [pass] is a customer without `pro`. */
    fun save(customer: String, pass: VoicePass?, now: Long) {
        preferences.edit().putString(KEY, Json.encodeToString(Entry.serializer(), Entry(customer, pass, now))).apply()
    }

    /** The month whose hours [customer] has at device time [now]; null when it has none, or that isn't known. */
    fun period(customer: String, now: Long): VoicePeriod? {
        val entry = entry(customer, now) ?: return null
        val pass = entry.pass ?: return null
        return pass.period(pass.checkedAt + (now - entry.askedAt))
    }

    /** Whether RevenueCat said, within [maxAge] of [now], whether [customer] has `pro`. */
    fun known(customer: String, now: Long): Boolean = entry(customer, now) != null

    fun clear() {
        preferences.edit().remove(KEY).apply()
    }

    private fun entry(customer: String, now: Long): Entry? {
        val entry = preferences.getString(KEY, null)
            ?.let { runCatching { Json.decodeFromString(Entry.serializer(), it) }.getOrNull() } ?: return null
        return entry.takeIf { it.customer == customer && now - it.askedAt in 0..maxAge }
    }

    companion object {
        private const val KEY = "pass"
        const val MAX_AGE_MILLIS = 24 * 60 * 60 * 1000L
    }
}
