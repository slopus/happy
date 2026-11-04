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

/** One month of the subscription's voice hours, [start] to [end]. */
@Serializable
data class ProMonth(val start: Long, val end: Long)

/**
 * RevenueCat's word on a customer's `pro` entitlement, from a subscriber
 * response (`GET /v1/subscribers/{id}`, `POST /v1/receipts`): its latest
 * purchase (`purchase_date`: a renewal is a new one), when access ends
 * (`expires_date`, which includes any grace period; null for a lifetime
 * grant), whether it is in a billing grace period, and RevenueCat's own
 * time when it answered ([checkedAt], `request_date`).
 */
@Serializable
data class ProPass(val purchased: Long, val expires: Long?, val grace: Boolean, val checkedAt: Long) {
    /** Active at RevenueCat's [at]: the device's clock decides nothing here. */
    fun active(at: Long = checkedAt): Boolean = expires == null || expires > at

    /**
     * The month of hours at RevenueCat's [at]: months run from the latest
     * purchase, a monthly product's one per renewal, a yearly or lifetime
     * one's every month after its purchase. A store renews on such a
     * month's start, so grace (at most 28 days, after a renewal that
     * failed) begins on one: in grace the month before it still runs, and
     * grace gives no new hours. Null when not [active].
     */
    fun period(at: Long = checkedAt): ProMonth? {
        if (!active(at)) return null
        var months = 0L
        while (month(months + 1) <= at) months++
        if (grace && months > 0) months--
        return ProMonth(month(months), month(months + 1))
    }

    private fun month(n: Long): Long = Instant.ofEpochMilli(purchased).atOffset(ZoneOffset.UTC).plusMonths(n).toInstant().toEpochMilli()

    companion object {
        const val ENTITLEMENT = "pro"

        /**
         * The `pro` entitlement in a subscriber response; null where it has
         * none, the response isn't one, or the grant is malformed (a date
         * that isn't one, `expires_date` missing rather than null).
         */
        fun from(response: JsonElement): ProPass? {
            val checkedAt = date(response.obj?.get("request_date")) ?: return null
            val granted = response.obj?.get("subscriber").obj?.get("entitlements").obj?.get(ENTITLEMENT).obj ?: return null
            val purchased = date(granted["purchase_date"]) ?: return null
            val expires = when (val value = granted["expires_date"]) {
                JsonNull -> null
                else -> date(value) ?: return null
            }
            val grace = when (val value = granted["grace_period_expires_date"]) {
                null, JsonNull -> false
                else -> date(value)?.let { true } ?: return null
            }
            return ProPass(purchased, expires, grace, checkedAt)
        }

        /** Whether [response] is a subscriber response at all, with `pro` or without. */
        fun answered(response: JsonElement): Boolean =
            date(response.obj?.get("request_date")) != null && response.obj?.get("subscriber").obj != null

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

    @Serializable private data class Month(val customer: String, val period: ProMonth)

    /** RevenueCat's answer for [customer] at device time [now]; a null [pass] is a customer without `pro`. */
    fun save(customer: String, pass: ProPass?, now: Long) {
        preferences.edit().putString(KEY, Json.encodeToString(Entry.serializer(), Entry(customer, pass, now))).apply()
    }

    /**
     * The month whose hours [customer] has at device time [now]; null when
     * it has none, or that isn't known. A purchase within 28 days of the
     * month already running (a product changed, or bought again) doesn't
     * start a new one: only a renewal's month does.
     */
    fun period(customer: String, now: Long): ProMonth? {
        val entry = entry(customer, now) ?: return null
        val pass = entry.pass ?: return null
        val period = pass.period(pass.checkedAt + (now - entry.askedAt)) ?: return null
        val running = month()?.takeIf { it.customer == customer }?.period
        if (running != null && period.start > running.start && period.start - running.start < MIN_MONTH_MILLIS) return running
        if (running != period) preferences.edit().putString(MONTH, Json.encodeToString(Month.serializer(), Month(customer, period))).apply()
        return period
    }

    /** Whether RevenueCat said, within [maxAge] of [now], whether [customer] has `pro`. */
    fun known(customer: String, now: Long): Boolean = entry(customer, now) != null

    fun clear() {
        preferences.edit().remove(KEY).remove(MONTH).apply()
    }

    private fun entry(customer: String, now: Long): Entry? {
        val entry = preferences.getString(KEY, null)
            ?.let { runCatching { Json.decodeFromString(Entry.serializer(), it) }.getOrNull() } ?: return null
        return entry.takeIf { it.customer == customer && now - it.askedAt in 0..maxAge }
    }

    private fun month(): Month? = preferences.getString(MONTH, null)?.let { runCatching { Json.decodeFromString(Month.serializer(), it) }.getOrNull() }

    companion object {
        private const val KEY = "pass"
        private const val MONTH = "month"
        const val MAX_AGE_MILLIS = 24 * 60 * 60 * 1000L

        /** The shortest month a store renews after. */
        private const val MIN_MONTH_MILLIS = 28 * 24 * 60 * 60 * 1000L
    }
}
