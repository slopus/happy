package com.slopus.happy.call

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.net.HappyJson
import com.slopus.happy.payments.RevenueCat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/** RevenueCat's `pro` as voice reads it ([VoicePass]), the month of hours it gives, and how long its word is kept. */
@RunWith(AndroidJUnit4::class)
class VoicePassTest {
    private val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("voice-pass-test", Context.MODE_PRIVATE)
    private val cache = VoicePassCache(preferences)
    private fun ms(text: String) = Instant.parse(text).toEpochMilli()

    @Before fun clear() { preferences.edit().clear().commit() }

    /** RevenueCat's answer at [at], kept as if asked at device time [at] too. */
    private fun told(at: String, pro: String?, customer: String = "a") {
        cache.save(customer, VoicePass.from(subscriber(at, pro)), ms(at))
    }

    @Test
    fun aMonthlySubscriptionsMonthIsFromItsPurchase() {
        told("2026-11-04T10:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        assertEquals(VoicePeriod(ms("2026-10-20T08:00:00Z"), ms("2026-11-20T08:00:00Z")), cache.period("a", ms("2026-11-04T10:00:00Z")))
    }

    @Test
    fun expiredAtRevenueCatsOwnTimeIsNoAccess() {
        told("2026-11-21T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        assertNull(cache.period("a", ms("2026-11-21T00:00:00Z")))
    }

    @Test
    fun graceGivesNoNewMonth() {
        told("2026-11-19T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        val before = cache.period("a", ms("2026-11-19T00:00:00Z"))!!
        // The renewal failed: RevenueCat's expiry is the grace period's end; the purchase stays.
        told("2026-11-21T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-12-04T08:00:00Z", grace = "2026-12-04T08:00:00Z"))
        assertEquals(before, cache.period("a", ms("2026-11-21T00:00:00Z")))
    }

    @Test
    fun aYearlyProsGraceGivesNoNewMonthEither() {
        // Months from Jan 31: ..., Dec 31, Jan 31 (the renewal that failed). In grace, Dec 31's still runs.
        told("2027-02-05T00:00:00Z", pro("2026-01-31T00:00:00Z", "2027-02-20T00:00:00Z", grace = "2027-02-20T00:00:00Z"))
        assertEquals(ms("2026-12-31T00:00:00Z"), cache.period("a", ms("2027-02-05T00:00:00Z"))!!.start)
    }

    @Test
    fun aRenewalStartsANewMonth() {
        told("2026-11-19T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        cache.period("a", ms("2026-11-19T00:00:00Z"))
        told("2026-11-21T00:00:00Z", pro("2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z"))
        assertEquals(ms("2026-11-20T08:00:00Z"), cache.period("a", ms("2026-11-21T00:00:00Z"))!!.start)
    }

    @Test
    fun aProductChangedMidMonthStartsNoNewMonth() {
        told("2026-11-01T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        cache.period("a", ms("2026-11-01T00:00:00Z"))
        // Upgraded to yearly on Nov 2: a new purchase, 13 days into the month.
        told("2026-11-03T00:00:00Z", pro("2026-11-02T00:00:00Z", "2027-11-02T00:00:00Z"))
        assertEquals(ms("2026-10-20T08:00:00Z"), cache.period("a", ms("2026-11-03T00:00:00Z"))!!.start)
    }

    @Test
    fun aYearlyOrLifetimeProIsFiveHoursAMonthNotAYear() {
        told("2026-03-25T00:00:00Z", pro("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z"))
        // Each month from the purchase: Jan 31, Feb 28, Mar 31.
        assertEquals(VoicePeriod(ms("2026-02-28T00:00:00Z"), ms("2026-03-31T00:00:00Z")), cache.period("a", ms("2026-03-25T00:00:00Z")))
        told("2027-06-10T00:00:00Z", pro("2026-01-15T00:00:00Z", null), customer = "b")
        assertEquals(ms("2027-05-15T00:00:00Z"), cache.period("b", ms("2027-06-10T00:00:00Z"))!!.start)
    }

    @Test
    fun aRefundTakesProAwayOnTheNextAnswer() {
        told("2026-11-05T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-04T12:00:00Z"))
        assertNull(cache.period("a", ms("2026-11-05T00:00:00Z")))
        val dropped = subscriber("2026-11-05T00:00:00Z", null)
        assertTrue(VoicePass.answered(dropped))
        assertNull(VoicePass.from(dropped))
    }

    @Test
    fun aMalformedGrantIsNone() {
        assertNull(VoicePass.from(HappyJson.parseToJsonElement("""{"code":7225,"message":"Invalid API key"}""")))
        assertFalse(VoicePass.answered(HappyJson.parseToJsonElement("""{"subscriber":{}}""")))
        // expires_date missing is not a lifetime grant; only an explicit null is.
        assertNull(VoicePass.from(subscriber("2026-11-04T10:00:00Z", """"pro":{"purchase_date":"2026-10-20T08:00:00Z"}""")))
        assertNull(VoicePass.from(subscriber("2026-11-04T10:00:00Z", """"pro":{"purchase_date":"2026-10-20T08:00:00Z","expires_date":12}""")))
        assertNull(VoicePass.from(subscriber("2026-11-04T10:00:00Z", """"pro":{"purchase_date":"soon","expires_date":null}""")))
        assertNull(VoicePass.from(subscriber("2026-11-04T10:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z", grace = "later"))))
        assertNotNull(VoicePass.from(subscriber("2026-11-04T10:00:00Z", pro("2026-10-20T08:00:00Z", null))))
    }

    @Test
    fun theCacheIsKeptADayAtMostAndOnlyForItsCustomer() {
        val asked = ms("2026-11-04T10:00:00Z")
        // A reinstall: nothing kept, nothing granted until RevenueCat answers.
        assertNull(cache.period("a", asked))
        told("2026-11-04T10:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        assertNotNull(cache.period("a", asked + 3_600_000))
        assertNull(cache.period("b", asked))
        // A day on, or the clock put back: not known.
        assertNull(cache.period("a", asked + VoicePassCache.MAX_AGE_MILLIS + 1))
        assertNull(cache.period("a", asked - 1))
        assertFalse(cache.known("a", asked - 1))
        // RevenueCat's time moved on by the device's: past the expiry, gone, though within the day.
        cache.save("a", VoicePass.from(subscriber("2026-11-20T07:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))), asked)
        assertNotNull(cache.period("a", asked + 3_000_000))
        assertNull(cache.period("a", asked + 3_700_000))
    }

    @Test
    fun theCurrentOfferingsMonthlyPackageIsItsProductAndBasePlan() {
        val offerings = HappyJson.parseToJsonElement(
            """{"current_offering_id":"default","offerings":[
              {"identifier":"old","packages":[{"identifier":"${'$'}rc_monthly","platform_product_identifier":"old","platform_product_plan_identifier":"m"}]},
              {"identifier":"default","description":"","packages":[
                {"identifier":"${'$'}rc_annual","platform_product_identifier":"happy","platform_product_plan_identifier":"yearly"},
                {"identifier":"${'$'}rc_monthly","platform_product_identifier":"happy","platform_product_plan_identifier":"monthly"}]}]}""",
        )
        assertEquals("happy" to "monthly", RevenueCat.monthly(offerings))
        // A package without its base plan is a one-time product or a mistake: none.
        assertNull(RevenueCat.monthly(HappyJson.parseToJsonElement("""{"current_offering_id":"d","offerings":[{"identifier":"d","packages":[{"identifier":"${'$'}rc_monthly","platform_product_identifier":"happy"}]}]}""")))
        assertNull(RevenueCat.monthly(HappyJson.parseToJsonElement("""{"current_offering_id":null,"offerings":[]}""")))
    }

    @Test
    fun aSubscriberHasFiveHoursInTheirMonthAndANewMonthStartsAfresh() {
        var period: VoicePeriod? = VoicePeriod(1_000_000L, 2_000_000_000L)
        val allowance = CallAllowance(MemoryUsageStore(), period = { period })
        assertEquals(CallAllowance.PAID_MILLIS, allowance.remaining(1_000_000L))
        allowance.record("a", 1_000_000L, 1_000_000L + 4 * 3_600_000L)
        assertEquals(3_600_000L, allowance.remaining(1_000_000L + 4 * 3_600_000L))
        // The next month counts nothing from before it.
        period = VoicePeriod(1_000_000L + 4 * 3_600_000L, 2_000_000_000L)
        assertEquals(CallAllowance.PAID_MILLIS, allowance.remaining(1_000_000L + 4 * 3_600_000L))
        // Without pro, the free 20 minutes, already spent.
        period = null
        assertEquals(0L, allowance.remaining(1_000_000L + 4 * 3_600_000L))
    }

    companion object {
        fun pro(purchased: String, expires: String?, grace: String? = null, product: String = "happy") =
            """"pro":{"product_identifier":"$product","purchase_date":"$purchased","expires_date":${expires?.let { "\"$it\"" } ?: "null"},""" +
                """"grace_period_expires_date":${grace?.let { "\"$it\"" } ?: "null"}}"""

        fun subscriber(at: String, pro: String?) = HappyJson.parseToJsonElement(
            """{"request_date":"$at","request_date_ms":0,"subscriber":{"entitlements":{${pro.orEmpty()}},"subscriptions":{}}}""",
        )
    }
}
