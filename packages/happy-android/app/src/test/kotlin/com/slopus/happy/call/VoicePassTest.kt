package com.slopus.happy.call

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.net.HappyJson
import com.slopus.happy.payments.RevenueCat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/** RevenueCat's `pro` as voice reads it ([VoicePass]), the month of hours it gives, and how long its word is kept. */
@RunWith(AndroidJUnit4::class)
class VoicePassTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private fun ms(text: String) = Instant.parse(text).toEpochMilli()

    @Test
    fun aMonthlySubscriptionIsOneMonthFromItsPurchaseToItsExpiry() {
        val pass = VoicePass.from(subscriber("2026-11-04T10:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z")))!!
        assertTrue(pass.active())
        val period = pass.period()!!
        assertEquals(ms("2026-10-20T08:00:00Z"), period.start)
        assertEquals(ms("2026-11-20T08:00:00Z"), period.end)
        assertEquals("happy_monthly@${ms("2026-10-20T08:00:00Z")}", period.key)
    }

    @Test
    fun expiredAtRevenueCatsOwnTimeIsNoAccessWhateverTheDeviceClockSays() {
        val pass = VoicePass.from(subscriber("2026-11-21T00:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z")))!!
        assertFalse(pass.active())
        assertNull(pass.period())
    }

    @Test
    fun graceMovesTheExpiryButNeverStartsANewMonth() {
        val before = VoicePass.from(subscriber("2026-11-19T00:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z")))!!
        // Billing trouble: RevenueCat extends the entitlement to the grace period's end; the purchase stays.
        val grace = VoicePass.from(subscriber("2026-11-21T00:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-27T08:00:00Z")))!!
        assertTrue(grace.active())
        assertEquals(before.period()!!.key, grace.period()!!.key)
    }

    @Test
    fun aRenewalIsANewPurchaseAndSoANewMonth() {
        val first = VoicePass.from(subscriber("2026-11-19T00:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z")))!!
        val renewed = VoicePass.from(subscriber("2026-11-21T00:00:00Z", pro("happy_monthly", "2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z")))!!
        assertNotEquals(first.period()!!.key, renewed.period()!!.key)
        assertEquals(ms("2026-11-20T08:00:00Z"), renewed.period()!!.start)
    }

    @Test
    fun aRefundTakesProAwayOnTheNextAnswer() {
        // Refunded: RevenueCat ends the entitlement at the refund, or drops it.
        val ended = VoicePass.from(subscriber("2026-11-05T00:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-04T12:00:00Z")))!!
        assertNull(ended.period())
        val subscriber = subscriber("2026-11-05T00:00:00Z", null)
        assertTrue(VoicePass.answered(subscriber))
        assertNull(VoicePass.from(subscriber))
    }

    @Test
    fun aYearlyOrLifetimeProIsFiveHoursAMonthNotAYear() {
        val yearly = VoicePass.from(subscriber("2026-03-25T00:00:00Z", pro("happy_yearly", "2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z")))!!
        val period = yearly.period()!!
        // Months from the purchase: Jan 31, Feb 28, Mar 31 (each from the purchase, so no drift).
        assertEquals(ms("2026-02-28T00:00:00Z"), period.start)
        assertEquals(ms("2026-03-31T00:00:00Z"), period.end)
        val lifetime = VoicePass.from(subscriber("2027-06-10T00:00:00Z", pro("happy_lifetime", "2026-01-15T00:00:00Z", null)))!!
        assertTrue(lifetime.active())
        assertEquals(ms("2027-05-15T00:00:00Z"), lifetime.period()!!.start)
        assertEquals(ms("2027-06-15T00:00:00Z"), lifetime.period()!!.end)
    }

    @Test
    fun anythingButASubscriberResponseIsNoPass() {
        assertNull(VoicePass.from(HappyJson.parseToJsonElement("""{"code":7225,"message":"Invalid API key"}""")))
        assertFalse(VoicePass.answered(HappyJson.parseToJsonElement("""{"subscriber":{}}""")))
        assertNull(VoicePass.from(subscriber("2026-11-04T10:00:00Z", """"pro":{"product_identifier":"p","purchase_date":"soon","expires_date":null}""")))
    }

    @Test
    fun theCacheIsKeptADayAtMostAndOnlyForItsCustomer() {
        val cache = VoicePassCache(context.getSharedPreferences("voice-pass-test", Context.MODE_PRIVATE))
        cache.clear()
        val pass = VoicePass.from(subscriber("2026-11-04T10:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z")))!!
        val asked = 1_000_000L
        // A reinstall: nothing kept, nothing granted until RevenueCat answers.
        assertNull(cache.period("a", asked))
        cache.save("a", pass, asked)
        assertNotNull(cache.period("a", asked + 3_600_000))
        assertNull(cache.period("b", asked))
        // A day on, or the clock put back: not known.
        assertNull(cache.period("a", asked + VoicePassCache.MAX_AGE_MILLIS + 1))
        assertNull(cache.period("a", asked - 1))
        assertFalse(cache.known("a", asked - 1))
        // RevenueCat's time moved on by the device's: past the expiry, gone, though within the day.
        val late = VoicePass.from(subscriber("2026-11-20T07:00:00Z", pro("happy_monthly", "2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z")))!!
        cache.save("a", late, asked)
        assertNotNull(cache.period("a", asked + 3_000_000))
        assertNull(cache.period("a", asked + 3_700_000))
        cache.clear()
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
        var period: VoicePeriod? = VoicePeriod("happy_monthly", 1_000_000L, 2_000_000_000L)
        val allowance = CallAllowance(MemoryUsageStore(), period = { period })
        assertEquals(CallAllowance.PAID_MILLIS, allowance.remaining(1_000_000L))
        allowance.record("a", 1_000_000L, 1_000_000L + 4 * 3_600_000L)
        assertEquals(3_600_000L, allowance.remaining(1_000_000L + 4 * 3_600_000L))
        // Free minutes don't add to it, and a call before the month counts nothing.
        period = VoicePeriod("happy_monthly", 1_000_000L + 4 * 3_600_000L, 2_000_000_000L)
        assertEquals(CallAllowance.PAID_MILLIS, allowance.remaining(1_000_000L + 4 * 3_600_000L))
        // Without pro, the free 20 minutes, already spent.
        period = null
        assertEquals(0L, allowance.remaining(1_000_000L + 4 * 3_600_000L))
    }

    companion object {
        fun pro(product: String, purchased: String, expires: String?) =
            """"pro":{"product_identifier":"$product","purchase_date":"$purchased","expires_date":${expires?.let { "\"$it\"" } ?: "null"}}"""

        fun subscriber(at: String, pro: String?) = HappyJson.parseToJsonElement(
            """{"request_date":"$at","request_date_ms":0,"subscriber":{"entitlements":{${pro.orEmpty()}},"subscriptions":{}}}""",
        )
    }
}
