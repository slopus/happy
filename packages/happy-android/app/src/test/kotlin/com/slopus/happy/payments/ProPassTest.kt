package com.slopus.happy.payments

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.call.CallAllowance
import com.slopus.happy.call.MemoryUsageStore
import com.slopus.happy.net.HappyJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/** RevenueCat's `pro` as voice reads it ([ProPass]), the month of hours it gives, and how long its word is kept. */
@RunWith(AndroidJUnit4::class)
class ProPassTest {
    private val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("voice-pass-test", Context.MODE_PRIVATE)
    private val cache = ProPassCache(preferences)
    private fun ms(text: String) = Instant.parse(text).toEpochMilli()

    @Before fun clear() { preferences.edit().clear().commit() }

    /** RevenueCat's answer at [at], kept as if asked at device time [at] too. */
    private fun told(at: String, pro: Grant?, customer: String = "a") {
        cache.save(customer, ProPass.from(subscriber(at, pro)), ms(at))
    }

    @Test
    fun aMonthlySubscriptionsMonthIsFromItsPurchase() {
        told("2026-11-04T10:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        assertEquals(ProMonth(ms("2026-10-20T08:00:00Z"), ms("2026-11-20T08:00:00Z")), cache.period("a", ms("2026-11-04T10:00:00Z")))
    }

    @Test
    fun expiredAtRevenueCatsOwnTimeIsNoAccess() {
        told("2026-11-21T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        assertNull(cache.period("a", ms("2026-11-21T00:00:00Z")))
    }

    /**
     * A renewal that failed, as RevenueCat answers it: the entitlement's
     * expiry moved to the grace period's end, the subscription's paid period
     * over, its `grace_period_expires_date` ahead. The month before runs on,
     * with no new hours and no end to promise.
     */
    @Test
    fun graceGivesNoNewMonthAndPromisesNoEnd() {
        told("2026-11-19T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        val before = cache.period("a", ms("2026-11-19T00:00:00Z"))!!
        told("2026-11-21T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-12-04T08:00:00Z", renews = "2026-11-20T08:00:00Z", grace = "2026-12-04T08:00:00Z"))
        assertEquals(ProMonth(before.start, null), cache.period("a", ms("2026-11-21T00:00:00Z")))
        // The same answer, a day of device time on: still grace, still that month.
        assertEquals(ProMonth(before.start, null), cache.period("a", ms("2026-11-21T20:00:00Z")))
    }

    /** Grace only on the subscription: a grace date in the entitlement, where RevenueCat's SDK never reads one, changes nothing. */
    @Test
    fun graceIsTheSubscriptionsNotTheEntitlements() {
        val answer = HappyJson.parseToJsonElement(
            """{"request_date":"2026-11-21T00:00:00Z","subscriber":{"entitlements":{"pro":{"expires_date":"2026-12-20T08:00:00Z",
              "grace_period_expires_date":"2026-12-04T08:00:00Z","product_identifier":"happy","purchase_date":"2026-11-20T08:00:00Z"}},
              "subscriptions":{"happy":${subscription("2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z", null)}}}}""",
        )
        val pass = ProPass.from(answer)!!
        assertFalse(pass.inGrace())
        assertEquals(ProMonth(ms("2026-11-20T08:00:00Z"), ms("2026-12-20T08:00:00Z")), pass.period())
    }

    /** A grace date that has passed, or one beside a paid period still running, is no grace. */
    @Test
    fun aPastOrIdleGraceDateIsNoGrace() {
        // Renewed after a grace period: the old grace date stays on the subscription, in the past.
        val renewed = ProPass.from(subscriber("2026-12-10T00:00:00Z", pro("2026-12-03T08:00:00Z", "2027-01-03T08:00:00Z", grace = "2026-12-04T08:00:00Z")))!!
        assertFalse(renewed.inGrace())
        assertEquals(ms("2026-12-03T08:00:00Z"), renewed.period()!!.start)
        // A grace date ahead while the paid period still runs: not in grace yet.
        val ahead = ProPass.from(subscriber("2026-11-10T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z", grace = "2026-12-04T08:00:00Z")))!!
        assertFalse(ahead.inGrace())
        assertEquals(ProMonth(ms("2026-10-20T08:00:00Z"), ms("2026-11-20T08:00:00Z")), ahead.period())
        // Moved on by the device's clock past the paid period, within the day: grace begins then.
        assertTrue(ahead.inGrace(ms("2026-11-20T09:00:00Z")))
    }

    @Test
    fun aYearlyProsGraceGivesNoNewMonthEither() {
        // Months from Jan 31: ..., Dec 31, Jan 31 (the renewal that failed). In grace, Dec 31's still runs.
        told("2027-02-05T00:00:00Z", pro("2026-01-31T00:00:00Z", "2027-02-20T00:00:00Z", renews = "2027-01-31T00:00:00Z", grace = "2027-02-20T00:00:00Z"))
        assertEquals(ProMonth(ms("2026-12-31T00:00:00Z"), null), cache.period("a", ms("2027-02-05T00:00:00Z")))
    }

    @Test
    fun aRenewalStartsANewMonthOnItsOwnDate() {
        told("2026-11-19T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        told("2026-11-21T00:00:00Z", pro("2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z"))
        assertEquals(ProMonth(ms("2026-11-20T08:00:00Z"), ms("2026-12-20T08:00:00Z")), cache.period("a", ms("2026-11-21T00:00:00Z")))
        // A store that renews a little early: the month is the renewal's, never one already over.
        told("2026-12-20T09:00:00Z", pro("2026-12-20T07:59:00Z", "2027-01-20T07:59:00Z"))
        val month = cache.period("a", ms("2026-12-20T09:00:00Z"))!!
        assertEquals(ms("2026-12-20T07:59:00Z"), month.start)
        assertTrue(month.end!! > ms("2026-12-20T09:00:00Z"))
    }

    @Test
    fun monthsEndOnTheSameDayOrTheMonthsLast() {
        // Bought Jan 31 in a leap year: Feb 29, Mar 31, Apr 30.
        val pass = ProPass.from(subscriber("2028-04-15T00:00:00Z", pro("2028-01-31T12:00:00Z", "2029-01-31T12:00:00Z", product = "happy_yearly")))!!
        assertEquals(ProMonth(ms("2028-03-31T12:00:00Z"), ms("2028-04-30T12:00:00Z")), pass.period())
        assertEquals(ProMonth(ms("2028-01-31T12:00:00Z"), ms("2028-02-29T12:00:00Z")), pass.period(ms("2028-02-10T00:00:00Z")))
        assertEquals(ProMonth(ms("2028-02-29T12:00:00Z"), ms("2028-03-31T12:00:00Z")), pass.period(ms("2028-03-01T00:00:00Z")))
        // A month's own last instant is still that month.
        assertEquals(ms("2028-02-29T12:00:00Z"), pass.period(ms("2028-03-31T11:59:59Z"))!!.start)
    }

    @Test
    fun aYearlyOrLifetimeProIsFiveHoursAMonthNotAYear() {
        told("2026-03-25T00:00:00Z", pro("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z", product = "happy_yearly"))
        // Each month from the purchase: Jan 31, Feb 28, Mar 31.
        assertEquals(ProMonth(ms("2026-02-28T00:00:00Z"), ms("2026-03-31T00:00:00Z")), cache.period("a", ms("2026-03-25T00:00:00Z")))
        // A lifetime grant: a one-time product, no subscription, no expiry.
        cache.save("b", ProPass.from(lifetime("2027-06-10T00:00:00Z", "2026-01-15T00:00:00Z")), ms("2027-06-10T00:00:00Z"))
        assertEquals(ms("2027-05-15T00:00:00Z"), cache.period("b", ms("2027-06-10T00:00:00Z"))!!.start)
    }

    @Test
    fun aRefundTakesProAwayOnTheNextAnswer() {
        told("2026-11-05T00:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-04T12:00:00Z"))
        assertNull(cache.period("a", ms("2026-11-05T00:00:00Z")))
        val dropped = subscriber("2026-11-05T00:00:00Z", null)
        assertTrue(ProPass.answered(dropped))
        assertNull(ProPass.from(dropped))
    }

    @Test
    fun aMalformedGrantIsNone() {
        fun with(entitlement: String, subscriptions: String = "") = HappyJson.parseToJsonElement(
            """{"request_date":"2026-11-04T10:00:00Z","subscriber":{"entitlements":{"pro":$entitlement},"subscriptions":{$subscriptions}}}""",
        )
        assertNull(ProPass.from(HappyJson.parseToJsonElement("""{"code":7225,"message":"Invalid API key"}""")))
        assertFalse(ProPass.answered(HappyJson.parseToJsonElement("""{"subscriber":{}}""")))
        // expires_date missing is not a lifetime grant; only an explicit null is.
        assertNull(ProPass.from(with("""{"product_identifier":"happy","purchase_date":"2026-10-20T08:00:00Z"}""")))
        assertNull(ProPass.from(with("""{"product_identifier":"happy","purchase_date":"2026-10-20T08:00:00Z","expires_date":12}""")))
        assertNull(ProPass.from(with("""{"product_identifier":"happy","purchase_date":"soon","expires_date":null}""")))
        assertNull(ProPass.from(with("""{"purchase_date":"2026-10-20T08:00:00Z","expires_date":null}""")))
        assertNull(ProPass.from(with(
            """{"product_identifier":"happy","purchase_date":"2026-10-20T08:00:00Z","expires_date":"2026-11-20T08:00:00Z"}""",
            """"happy":{"purchase_date":"2026-10-20T08:00:00Z","expires_date":"2026-11-20T08:00:00Z","grace_period_expires_date":"later"}""",
        )))
        assertNotNull(ProPass.from(lifetime("2026-11-04T10:00:00Z", "2026-10-20T08:00:00Z")))
    }

    /** The answer in full, as RevenueCat's v1 REST API gives it, read as it is. */
    @Test
    fun aFullSubscriberAnswerIsReadAsItIs() {
        val answer = HappyJson.parseToJsonElement(FULL)
        assertTrue(ProPass.answered(answer))
        val pass = ProPass.from(answer)!!
        assertEquals(ProPass(ms("2026-11-20T08:00:05Z"), ms("2026-12-20T08:00:05Z"), ms("2026-12-20T08:00:05Z"), null, ms("2026-11-25T13:14:15Z")), pass)
        assertFalse(pass.inGrace())
        assertEquals(ProMonth(ms("2026-11-20T08:00:05Z"), ms("2026-12-20T08:00:05Z")), pass.period())
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
        assertNull(cache.period("a", asked + ProPassCache.MAX_AGE_MILLIS + 1))
        assertNull(cache.period("a", asked - 1))
        assertFalse(cache.known("a", asked - 1))
        // RevenueCat's time moved on by the device's: past the expiry, gone, though within the day.
        cache.save("a", ProPass.from(subscriber("2026-11-20T07:00:00Z", pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))), asked)
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
        var period: ProMonth? = ProMonth(1_000_000L, 2_000_000_000L)
        val allowance = CallAllowance(MemoryUsageStore(), period = { period })
        assertEquals(CallAllowance.PAID_MILLIS, allowance.remaining(1_000_000L))
        allowance.record("a", 1_000_000L, 1_000_000L + 4 * 3_600_000L)
        assertEquals(3_600_000L, allowance.remaining(1_000_000L + 4 * 3_600_000L))
        // The next month counts nothing from before it.
        period = ProMonth(1_000_000L + 4 * 3_600_000L, 2_000_000_000L)
        assertEquals(CallAllowance.PAID_MILLIS, allowance.remaining(1_000_000L + 4 * 3_600_000L))
        // Without pro, the free 20 minutes, already spent.
        period = null
        assertEquals(0L, allowance.remaining(1_000_000L + 4 * 3_600_000L))
    }

    companion object {
        /**
         * `pro` as a subscription grants it: the entitlement ([expires],
         * moved to the grace period's end in grace) and the subscription
         * it names ([renews], its paid period's end; [grace]).
         */
        fun pro(purchased: String, expires: String?, grace: String? = null, product: String = "happy", renews: String? = expires) = Grant(
            """"pro":{"expires_date":${json(expires)},"product_identifier":"$product","purchase_date":"$purchased"}""",
            """"$product":${subscription(purchased, renews, grace)}""",
        )

        class Grant(val entitlement: String, val subscription: String?)

        fun subscription(purchased: String, expires: String?, grace: String?) =
            """{"auto_resume_date":null,"billing_issues_detected_at":${json(grace?.let { purchased })},"expires_date":${json(expires)},""" +
                """"grace_period_expires_date":${json(grace)},"is_sandbox":true,"original_purchase_date":"$purchased","ownership_type":"PURCHASED",""" +
                """"period_type":"normal","purchase_date":"$purchased","refunded_at":null,"store":"play_store","store_transaction_id":"GPA.1",""" +
                """"unsubscribe_detected_at":null,"product_plan_identifier":"monthly"}"""

        fun subscriber(at: String, pro: Grant?) = HappyJson.parseToJsonElement(
            """{"request_date":"$at","request_date_ms":0,"subscriber":{"entitlements":{${pro?.entitlement.orEmpty()}},""" +
                """"subscriptions":{${pro?.subscription.orEmpty()}},"non_subscriptions":{}}}""",
        )

        /** `pro` from a one-time product: no subscription, no expiry. */
        fun lifetime(at: String, purchased: String) = HappyJson.parseToJsonElement(
            """{"request_date":"$at","subscriber":{"entitlements":{"pro":{"expires_date":null,"product_identifier":"happy_lifetime","purchase_date":"$purchased"}},""" +
                """"subscriptions":{},"non_subscriptions":{"happy_lifetime":[{"id":"1","is_sandbox":true,"purchase_date":"$purchased","store":"play_store"}]}}}""",
        )

        private fun json(value: String?) = value?.let { "\"$it\"" } ?: "null"

        /**
         * A whole subscriber answer as RevenueCat's REST API v1 returns one
         * (field names as `CustomerInfoResponse` and
         * `SubscriptionInfoResponse` read them): a renewal on Nov 20, an
         * earlier monthly product expired, a one-time purchase that grants
         * nothing.
         */
        val FULL = """{
          "request_date":"2026-11-25T13:14:15Z","request_date_ms":1795439655000,
          "subscriber":{
            "entitlements":{"pro":{"expires_date":"2026-12-20T08:00:05Z","product_identifier":"happy","purchase_date":"2026-11-20T08:00:05Z"}},
            "first_seen":"2026-01-02T03:04:05Z","last_seen":"2026-11-25T13:00:00Z","management_url":"https://play.google.com/store/account/subscriptions",
            "non_subscriptions":{"tip":[{"id":"x","is_sandbox":false,"purchase_date":"2026-02-01T00:00:00Z","store":"play_store"}]},
            "original_app_user_id":"${'$'}RCAnonymousID:0123456789abcdef0123456789abcdef","original_application_version":null,"original_purchase_date":null,
            "other_purchases":{},"subscriber_attributes":{},
            "subscriptions":{
              "happy":{"auto_resume_date":null,"billing_issues_detected_at":null,"expires_date":"2026-12-20T08:00:05Z","grace_period_expires_date":null,
                "is_sandbox":false,"original_purchase_date":"2026-10-20T08:00:05Z","ownership_type":"PURCHASED","period_type":"normal",
                "purchase_date":"2026-11-20T08:00:05Z","refunded_at":null,"store":"play_store","store_transaction_id":"GPA.3333",
                "unsubscribe_detected_at":null,"product_plan_identifier":"monthly","price":{"amount":9.99,"currency":"EUR"}},
              "happy_old":{"auto_resume_date":null,"billing_issues_detected_at":null,"expires_date":"2026-03-01T00:00:00Z","grace_period_expires_date":"2026-03-08T00:00:00Z",
                "is_sandbox":false,"original_purchase_date":"2026-02-01T00:00:00Z","ownership_type":"PURCHASED","period_type":"normal",
                "purchase_date":"2026-02-01T00:00:00Z","refunded_at":null,"store":"play_store","store_transaction_id":"GPA.1111","unsubscribe_detected_at":"2026-02-10T00:00:00Z"}
            }
          }
        }"""
    }
}
