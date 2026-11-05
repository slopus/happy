package com.slopus.happy.payments

import android.content.SharedPreferences
import com.slopus.happy.chat.obj
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * One month of the subscription's voice hours, from [start]; [end] is when
 * the next month's begin, null while a renewal is in a billing grace period
 * (they begin only if it succeeds).
 */
@Serializable
data class ProMonth(val start: Long, val end: Long?)

/**
 * RevenueCat's word on a customer's `pro` entitlement, from a subscriber
 * response (`GET /v1/subscribers/{id}`, `POST /v1/receipts`): its latest
 * purchase (`purchase_date`: a renewal is a new one) and when access ends
 * (`expires_date`, null for a lifetime grant), both the entitlement's; from
 * the subscription that grants it (`subscriptions[product_identifier]`, none
 * for a one-time product), when its paid period ends ([renews], its
 * `expires_date`) and until when a failed renewal keeps access ([graceUntil],
 * `grace_period_expires_date`); RevenueCat's own time when it answered
 * ([checkedAt], `request_date`); and the product itself ([product],
 * `product_identifier`; null in a pass kept before it was read), for its price.
 */
@Serializable
data class ProPass(val purchased: Long, val expires: Long?, val renews: Long?, val graceUntil: Long?, val checkedAt: Long, val product: String? = null) {
    /** Active at RevenueCat's [at]: the device's clock decides nothing here. */
    fun active(at: Long = checkedAt): Boolean = expires == null || expires > at

    /** In a billing grace period at [at]: the paid period over, the renewal failed, access kept until [graceUntil]. */
    fun inGrace(at: Long = checkedAt): Boolean = graceUntil != null && at < graceUntil && renews != null && renews <= at

    /**
     * The month of hours at RevenueCat's [at]: months run from the latest
     * purchase in calendar months (UTC), a monthly product's one per
     * renewal, a yearly or lifetime one's every month after its purchase.
     * In grace the month before still runs, with no new hours and no known
     * end. Null when not [active].
     */
    fun period(at: Long = checkedAt): ProMonth? {
        if (!active(at)) return null
        var months = 0L
        while (month(months + 1) <= at) months++
        if (inGrace(at)) return ProMonth(month(maxOf(0, months - 1)), null)
        return ProMonth(month(months), month(months + 1))
    }

    private fun month(n: Long): Long = Instant.ofEpochMilli(purchased).atOffset(ZoneOffset.UTC).plusMonths(n).toInstant().toEpochMilli()

    companion object {
        const val ENTITLEMENT = "pro"

        /**
         * The `pro` entitlement in a subscriber response; null where it has
         * none, the response isn't one, or the grant is malformed (a date
         * that isn't one, `expires_date` missing rather than null, no
         * product).
         */
        fun from(response: JsonElement): ProPass? {
            val checkedAt = date(response.obj?.get("request_date")) ?: return null
            val subscriber = response.obj?.get("subscriber").obj ?: return null
            val granted = subscriber["entitlements"].obj?.get(ENTITLEMENT).obj ?: return null
            val product = (granted["product_identifier"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            val purchased = date(granted["purchase_date"]) ?: return null
            val expires = when (val value = granted["expires_date"]) {
                JsonNull -> null
                else -> date(value) ?: return null
            }
            val subscription = subscriber["subscriptions"].obj?.get(product).obj
            val renews = optionalDate(subscription?.get("expires_date")) ?: return null
            val graceUntil = optionalDate(subscription?.get("grace_period_expires_date")) ?: return null
            return ProPass(purchased, expires, renews.value, graceUntil.value, checkedAt, product)
        }

        /** Whether [response] is a subscriber response at all, with `pro` or without. */
        fun answered(response: JsonElement): Boolean =
            date(response.obj?.get("request_date")) != null && response.obj?.get("subscriber").obj != null

        private class Optional(val value: Long?)

        /** Absent or null is a known nothing; a value that isn't a date is null (malformed). */
        private fun optionalDate(value: JsonElement?): Optional? = when (value) {
            null, JsonNull -> Optional(null)
            else -> date(value)?.let(::Optional)
        }

        private fun date(value: JsonElement?): Long? {
            val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            return runCatching { OffsetDateTime.parse(text).toInstant().toEpochMilli() }.getOrNull()
        }
    }
}

/**
 * The last [ProPass] RevenueCat gave a customer, and the device's clock
 * when it did. Used until RevenueCat says otherwise, only while it would
 * still be active at RevenueCat's time moved on by the device's, and never
 * longer than [maxAge] since it was asked: past that, or with the clock put
 * back, access is unknown and nothing is granted until RevenueCat answers.
 */
class ProPassCache(private val preferences: SharedPreferences, private val maxAge: Long = MAX_AGE_MILLIS) {
    @Serializable private data class Entry(val customer: String, val pass: ProPass?, val askedAt: Long)

    /** RevenueCat's answer for [customer] at device time [now]; a null [pass] is a customer without `pro`. */
    fun save(customer: String, pass: ProPass?, now: Long) {
        preferences.edit().putString(KEY, Json.encodeToString(Entry.serializer(), Entry(customer, pass, now))).apply()
    }

    /** The month whose hours [customer] has at device time [now]; null when it has none, or that isn't known. */
    fun period(customer: String, now: Long): ProMonth? {
        val entry = entry(customer, now) ?: return null
        val pass = entry.pass ?: return null
        return pass.period(pass.checkedAt + (now - entry.askedAt))
    }

    /** What RevenueCat last said of [customer]'s `pro` within [maxAge] of [now]; null without it, or when that isn't known. */
    fun pass(customer: String, now: Long): ProPass? = entry(customer, now)?.pass

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
