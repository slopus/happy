import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// RevenueCat's `pro` as the subscription reads it (`ProPass`), the month
/// of hours it gives, how long its word is kept, and the allowance it sets.
/// Answers are shaped as RevenueCat's v1 API gives them (`CustomerInfoResponse`).
@MainActor
final class ProPassTests: XCTestCase {
    private func s(_ text: String) -> Double { try! Date(text, strategy: .iso8601).timeIntervalSince1970 }

    private func told(_ cache: ProPassCache, at: String, _ pro: Grant?, customer: String = "a") {
        cache.save(customer: customer, pass: Self.pass(Self.subscriber(at, pro)), now: s(at))
    }

    func testAMonthlySubscriptionsMonthIsFromItsPurchase() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2026-11-04T10:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        XCTAssertEqual(cache.month(customer: "a", now: s("2026-11-04T10:00:00Z")), ProMonth(start: s("2026-10-20T08:00:00Z"), end: s("2026-11-20T08:00:00Z")))
        XCTAssertTrue(cache.active(customer: "a", now: s("2026-11-04T10:00:00Z")))
    }

    func testExpiredAtRevenueCatsOwnTimeIsNoAccess() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2026-11-21T00:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        XCTAssertNil(cache.month(customer: "a", now: s("2026-11-21T00:00:00Z")))
        XCTAssertFalse(cache.active(customer: "a", now: s("2026-11-21T00:00:00Z")))
    }

    /// A renewal that failed: the entitlement's expiry moved to the grace
    /// end, the subscription's paid period over, its grace date ahead. The
    /// month before runs on, with no new hours and no end to promise.
    func testGraceGivesNoNewMonthAndPromisesNoEnd() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2026-11-19T00:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        let before = cache.month(customer: "a", now: s("2026-11-19T00:00:00Z"))!
        told(cache, at: "2026-11-21T00:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-12-04T08:00:00Z", renews: "2026-11-20T08:00:00Z", grace: "2026-12-04T08:00:00Z"))
        XCTAssertEqual(cache.month(customer: "a", now: s("2026-11-21T00:00:00Z")), ProMonth(start: before.start, end: nil))
        XCTAssertEqual(cache.month(customer: "a", now: s("2026-11-21T20:00:00Z")), ProMonth(start: before.start, end: nil))
        XCTAssertTrue(cache.active(customer: "a", now: s("2026-11-21T20:00:00Z")))
    }

    /// A grace date on the entitlement, where the SDK never reads one, changes nothing.
    func testGraceIsTheSubscriptionsNotTheEntitlements() throws {
        let answer = try JSONValue.decode(Data("""
        {"request_date":"2026-11-21T00:00:00Z","subscriber":{"entitlements":{"pro":{"expires_date":"2026-12-20T08:00:00Z",
          "grace_period_expires_date":"2026-12-04T08:00:00Z","product_identifier":"happy","purchase_date":"2026-11-20T08:00:00Z"}},
          "subscriptions":{"happy":\(Self.subscription("2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z", nil))}}}
        """.utf8))
        let pass = try XCTUnwrap(Self.pass(answer))
        XCTAssertFalse(pass.inGrace(at: pass.checkedAt))
        XCTAssertEqual(pass.month(at: pass.checkedAt), ProMonth(start: s("2026-11-20T08:00:00Z"), end: s("2026-12-20T08:00:00Z")))
    }

    func testAPastOrIdleGraceDateIsNoGrace() throws {
        let renewed = try XCTUnwrap(Self.pass(Self.subscriber("2026-12-10T00:00:00Z", Self.pro("2026-12-03T08:00:00Z", "2027-01-03T08:00:00Z", grace: "2026-12-04T08:00:00Z"))))
        XCTAssertFalse(renewed.inGrace(at: renewed.checkedAt))
        XCTAssertEqual(renewed.month(at: renewed.checkedAt)?.start, s("2026-12-03T08:00:00Z"))
        let ahead = try XCTUnwrap(Self.pass(Self.subscriber("2026-11-10T00:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z", grace: "2026-12-04T08:00:00Z"))))
        XCTAssertFalse(ahead.inGrace(at: ahead.checkedAt))
        XCTAssertEqual(ahead.month(at: ahead.checkedAt), ProMonth(start: s("2026-10-20T08:00:00Z"), end: s("2026-11-20T08:00:00Z")))
        XCTAssertTrue(ahead.inGrace(at: s("2026-11-20T09:00:00Z")))
    }

    func testAYearlyProsGraceGivesNoNewMonthEither() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2027-02-05T00:00:00Z", Self.pro("2026-01-31T00:00:00Z", "2027-02-20T00:00:00Z", renews: "2027-01-31T00:00:00Z", grace: "2027-02-20T00:00:00Z"))
        XCTAssertEqual(cache.month(customer: "a", now: s("2027-02-05T00:00:00Z")), ProMonth(start: s("2026-12-31T00:00:00Z"), end: nil))
    }

    func testARenewalStartsANewMonthOnItsOwnDate() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2026-11-21T00:00:00Z", Self.pro("2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z"))
        XCTAssertEqual(cache.month(customer: "a", now: s("2026-11-21T00:00:00Z")), ProMonth(start: s("2026-11-20T08:00:00Z"), end: s("2026-12-20T08:00:00Z")))
        // Renewed a little early: the month is the renewal's, never one already over.
        told(cache, at: "2026-12-20T09:00:00Z", Self.pro("2026-12-20T07:59:00Z", "2027-01-20T07:59:00Z"))
        let month = cache.month(customer: "a", now: s("2026-12-20T09:00:00Z"))!
        XCTAssertEqual(month.start, s("2026-12-20T07:59:00Z"))
        XCTAssertGreaterThan(month.end!, s("2026-12-20T09:00:00Z"))
    }

    func testMonthsEndOnTheSameDayOrTheMonthsLast() throws {
        let pass = try XCTUnwrap(Self.pass(Self.subscriber("2028-04-15T00:00:00Z", Self.pro("2028-01-31T12:00:00Z", "2029-01-31T12:00:00Z", product: "happy_yearly"))))
        XCTAssertEqual(pass.month(at: pass.checkedAt), ProMonth(start: s("2028-03-31T12:00:00Z"), end: s("2028-04-30T12:00:00Z")))
        XCTAssertEqual(pass.month(at: s("2028-02-10T00:00:00Z")), ProMonth(start: s("2028-01-31T12:00:00Z"), end: s("2028-02-29T12:00:00Z")))
        XCTAssertEqual(pass.month(at: s("2028-03-01T00:00:00Z")), ProMonth(start: s("2028-02-29T12:00:00Z"), end: s("2028-03-31T12:00:00Z")))
        XCTAssertEqual(pass.month(at: s("2028-03-31T11:59:59Z"))?.start, s("2028-02-29T12:00:00Z"))
        // A 31-day month: its last second is still it, the next second the next month.
        let july = try XCTUnwrap(Self.pass(Self.subscriber("2026-07-15T00:00:00Z", Self.pro("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"))))
        XCTAssertEqual(july.month(at: s("2026-07-31T23:59:59Z")), ProMonth(start: s("2026-07-01T00:00:00Z"), end: s("2026-08-01T00:00:00Z")))
    }

    func testAYearlyOrLifetimeProIsFiveHoursAMonthNotAYear() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2026-03-25T00:00:00Z", Self.pro("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z", product: "happy_yearly"))
        XCTAssertEqual(cache.month(customer: "a", now: s("2026-03-25T00:00:00Z")), ProMonth(start: s("2026-02-28T00:00:00Z"), end: s("2026-03-31T00:00:00Z")))
        cache.save(customer: "b", pass: Self.pass(Self.lifetime("2027-06-10T00:00:00Z", "2026-01-15T00:00:00Z")), now: s("2027-06-10T00:00:00Z"))
        XCTAssertEqual(cache.month(customer: "b", now: s("2027-06-10T00:00:00Z"))?.start, s("2027-05-15T00:00:00Z"))
    }

    func testARefundTakesProAwayOnTheNextAnswer() throws {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        told(cache, at: "2026-11-05T00:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-04T12:00:00Z"))
        XCTAssertNil(cache.month(customer: "a", now: s("2026-11-05T00:00:00Z")))
        XCTAssertEqual(ProPass.answer(Self.subscriber("2026-11-05T00:00:00Z", nil)), ProPass.Answer.none)
    }

    func testAMalformedGrantIsNone() throws {
        func with(_ entitlement: String, _ subscriptions: String = "") throws -> ProPass.Answer? {
            ProPass.answer(try JSONValue.decode(Data("""
            {"request_date":"2026-11-04T10:00:00Z","subscriber":{"entitlements":{"pro":\(entitlement)},"subscriptions":{\(subscriptions)}}}
            """.utf8)))
        }
        XCTAssertNil(ProPass.answer(try JSONValue.decode(Data(#"{"code":7225,"message":"Invalid API key"}"#.utf8))))
        XCTAssertNil(ProPass.answer(try JSONValue.decode(Data(#"{"subscriber":{}}"#.utf8))))
        // expires_date missing is not a lifetime grant; only an explicit null is.
        XCTAssertEqual(try with(#"{"product_identifier":"happy","purchase_date":"2026-10-20T08:00:00Z"}"#), ProPass.Answer.none)
        XCTAssertEqual(try with(#"{"product_identifier":"happy","purchase_date":"2026-10-20T08:00:00Z","expires_date":12}"#), ProPass.Answer.none)
        XCTAssertEqual(try with(#"{"product_identifier":"happy","purchase_date":"soon","expires_date":null}"#), ProPass.Answer.none)
        XCTAssertEqual(try with(#"{"purchase_date":"2026-10-20T08:00:00Z","expires_date":null}"#), ProPass.Answer.none)
        XCTAssertEqual(try with(#"{"product_identifier":"happy","purchase_date":"2026-10-20T08:00:00Z","expires_date":"2026-11-20T08:00:00Z"}"#,
                                #""happy":{"purchase_date":"2026-10-20T08:00:00Z","expires_date":"2026-11-20T08:00:00Z","grace_period_expires_date":"later"}"#), ProPass.Answer.none)
        XCTAssertNotNil(Self.pass(Self.lifetime("2026-11-04T10:00:00Z", "2026-10-20T08:00:00Z")))
        // Milliseconds, as some answers carry them.
        XCTAssertEqual(ProPass.date(.string("2026-11-04T10:00:00.250Z")), s("2026-11-04T10:00:00Z") + 0.25)
    }

    func testAFullSubscriberAnswerIsReadAsItIs() throws {
        let pass = try XCTUnwrap(Self.pass(try JSONValue.decode(Data(Self.full.utf8))))
        XCTAssertEqual(pass, ProPass(purchased: s("2026-11-20T08:00:05Z"), expires: s("2026-12-20T08:00:05Z"), renews: s("2026-12-20T08:00:05Z"), graceUntil: nil, checkedAt: s("2026-11-25T13:14:15Z")))
        XCTAssertEqual(pass.month(at: pass.checkedAt), ProMonth(start: s("2026-11-20T08:00:05Z"), end: s("2026-12-20T08:00:05Z")))
    }

    func testTheCacheIsKeptADayAtMostAndOnlyForItsCustomer() {
        let cache = ProPassCache(store: InMemoryKeyValueStore())
        let asked = s("2026-11-04T10:00:00Z")
        XCTAssertNil(cache.month(customer: "a", now: asked))
        told(cache, at: "2026-11-04T10:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))
        XCTAssertNotNil(cache.month(customer: "a", now: asked + 3600))
        XCTAssertNil(cache.month(customer: "b", now: asked))
        // A day on, or the clock put back: not known.
        XCTAssertNil(cache.month(customer: "a", now: asked + ProPassCache.maxAge + 1))
        XCTAssertNil(cache.month(customer: "a", now: asked - 1))
        XCTAssertNil(cache.pass(customer: "a", now: asked - 1))
        // RevenueCat's time moved on by the device's: past the expiry, gone, though within the day.
        cache.save(customer: "a", pass: Self.pass(Self.subscriber("2026-11-20T07:00:00Z", Self.pro("2026-10-20T08:00:00Z", "2026-11-20T08:00:00Z"))), now: asked)
        XCTAssertTrue(cache.active(customer: "a", now: asked + 3000))
        XCTAssertFalse(cache.active(customer: "a", now: asked + 3700))
    }

    func testTheCurrentOfferingsMonthlyPackageIsItsAppStoreProduct() throws {
        let offerings = try JSONValue.decode(Data("""
        {"current_offering_id":"default","offerings":[
          {"identifier":"old","packages":[{"identifier":"$rc_monthly","platform_product_identifier":"old"}]},
          {"identifier":"default","description":"","packages":[
            {"identifier":"$rc_annual","platform_product_identifier":"happy_yearly"},
            {"identifier":"$rc_monthly","platform_product_identifier":"happy_monthly"}]}]}
        """.utf8))
        XCTAssertEqual(RevenueCatClient.monthlyProduct(offerings), "happy_monthly")
        XCTAssertNil(RevenueCatClient.monthlyProduct(try JSONValue.decode(Data(#"{"current_offering_id":null,"offerings":[]}"#.utf8))))
        XCTAssertNil(RevenueCatClient.monthlyProduct(try JSONValue.decode(Data(#"{"current_offering_id":"d","offerings":[{"identifier":"d","packages":[{"identifier":"$rc_annual","platform_product_identifier":"y"}]}]}"#.utf8))))
    }

    // MARK: The allowance

    func testASubscriberHasFiveHoursInTheirMonthReplacingTheFreeTime() {
        var month: ProMonth? = ProMonth(start: 1_000, end: 2_000_000_000)
        let allowance = CallAllowance(store: MemoryUsageStore(), period: { month })
        XCTAssertEqual(allowance.remaining(at: 1_000), CallAllowance.paidSeconds)
        allowance.record(call: "a", from: 1_000, to: 1_000 + 4 * 3600)
        XCTAssertEqual(allowance.remaining(at: 1_000 + 4 * 3600), 3600)
        // The next month counts nothing from before it.
        month = ProMonth(start: 1_000 + 4 * 3600, end: 2_000_000_000)
        XCTAssertEqual(allowance.remaining(at: 1_000 + 4 * 3600), CallAllowance.paidSeconds)
        // Without pro, the free 20 minutes, already spent; not on top of the paid hours.
        month = nil
        XCTAssertEqual(allowance.remaining(at: 1_000 + 4 * 3600), 0)
    }

    /// 5 hours spent on a month's first day; on day 45, in grace, that month
    /// still runs: no hours come back, and none are promised. The spans are
    /// kept for the paid month however long it runs, even through a moment
    /// nothing was known about pro.
    func testSpentHoursStayCountedThroughGraceAndUnknown() {
        let start = s("2026-07-01T00:00:00Z")
        var month: ProMonth? = ProMonth(start: start, end: s("2026-08-01T00:00:00Z"))
        let store = MemoryUsageStore()
        let allowance = CallAllowance(store: store, period: { month })
        allowance.record(call: "day1", from: start + 3600, to: start + 6 * 3600)
        XCTAssertEqual(allowance.remaining(at: start + 6 * 3600), 0)
        XCTAssertEqual(allowance.freeAgain(after: start + 6 * 3600), s("2026-08-01T00:00:00Z"))
        // Unknown for a while (offline past a day): a short free call is counted, nothing forgotten.
        month = nil
        allowance.record(call: "unknown", from: start + 40 * 86_400, to: start + 40 * 86_400 + 60)
        // Day 45, the renewal failed: grace keeps July's month, with no end.
        month = ProMonth(start: start, end: nil)
        let reopened = CallAllowance(store: store, period: { month })
        XCTAssertEqual(reopened.remaining(at: start + 45 * 86_400), 0)
        XCTAssertNil(reopened.freeAgain(after: start + 45 * 86_400))
        reopened.record(call: "day45", from: start + 45 * 86_400, to: start + 45 * 86_400 + 1)
        XCTAssertEqual(CallAllowance(store: store, period: { month }).remaining(at: start + 45 * 86_400), 0)
        // The renewal goes through: a new month, fresh hours.
        month = ProMonth(start: start + 46 * 86_400, end: start + 77 * 86_400)
        XCTAssertEqual(reopened.remaining(at: start + 46 * 86_400), CallAllowance.paidSeconds)
    }

    func testAnAnnualSliceIsFiveHoursPerMonth() throws {
        let pass = try XCTUnwrap(Self.pass(Self.subscriber("2026-03-25T00:00:00Z", Self.pro("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z", product: "happy_yearly"))))
        let at = pass.checkedAt
        let allowance = CallAllowance(store: MemoryUsageStore(), period: { pass.month(at: at) })
        // Spent in February's slice: none of it counts in March's.
        allowance.record(call: "feb", from: s("2026-02-10T00:00:00Z"), to: s("2026-02-10T05:00:00Z"))
        XCTAssertEqual(allowance.remaining(at: at), CallAllowance.paidSeconds)
        allowance.record(call: "mar", from: s("2026-03-20T00:00:00Z"), to: s("2026-03-20T01:00:00Z"))
        XCTAssertEqual(allowance.remaining(at: at), 4 * 3600)
    }

    // MARK: Fixtures

    struct Grant {
        var entitlement: String
        var subscription: String?
    }

    /// `pro` as a subscription grants it: the entitlement (`expires`, the
    /// grace end in grace) and the subscription it names (`renews`, `grace`).
    static func pro(_ purchased: String, _ expires: String?, renews: String? = nil, grace: String? = nil, product: String = "happy") -> Grant {
        Grant(entitlement: #""pro":{"expires_date":\#(json(expires)),"product_identifier":"\#(product)","purchase_date":"\#(purchased)"}"#,
              subscription: #""\#(product)":\#(subscription(purchased, renews ?? expires, grace))"#)
    }

    static func subscription(_ purchased: String, _ expires: String?, _ grace: String?) -> String {
        #"{"auto_resume_date":null,"billing_issues_detected_at":\#(json(grace.map { _ in purchased })),"expires_date":\#(json(expires)),"#
            + #""grace_period_expires_date":\#(json(grace)),"is_sandbox":true,"original_purchase_date":"\#(purchased)","ownership_type":"PURCHASED","#
            + #""period_type":"normal","purchase_date":"\#(purchased)","refunded_at":null,"store":"app_store","store_transaction_id":"2000000001","#
            + #""unsubscribe_detected_at":null}"#
    }

    static func subscriber(_ at: String, _ pro: Grant?) -> JSONValue {
        try! JSONValue.decode(Data((#"{"request_date":"\#(at)","request_date_ms":0,"subscriber":{"entitlements":{\#(pro?.entitlement ?? "")},"#
            + #""subscriptions":{\#(pro?.subscription ?? "")},"non_subscriptions":{}}}"#).utf8))
    }

    static func lifetime(_ at: String, _ purchased: String) -> JSONValue {
        try! JSONValue.decode(Data((#"{"request_date":"\#(at)","subscriber":{"entitlements":{"pro":{"expires_date":null,"product_identifier":"happy_lifetime","purchase_date":"\#(purchased)"}},"#
            + #""subscriptions":{},"non_subscriptions":{"happy_lifetime":[{"id":"1","is_sandbox":true,"purchase_date":"\#(purchased)","store":"app_store"}]}}}"#).utf8))
    }

    static func pass(_ answer: JSONValue) -> ProPass? {
        if case .pro(let pass) = ProPass.answer(answer) { return pass }
        return nil
    }

    private static func json(_ value: String?) -> String { value.map { "\"\($0)\"" } ?? "null" }

    /// A whole subscriber answer as RevenueCat's REST API v1 returns one: a
    /// renewal on Nov 20, an earlier product expired, a one-time purchase
    /// that grants nothing.
    static let full = """
    {
      "request_date":"2026-11-25T13:14:15Z","request_date_ms":1795439655000,
      "subscriber":{
        "entitlements":{"pro":{"expires_date":"2026-12-20T08:00:05Z","product_identifier":"happy","purchase_date":"2026-11-20T08:00:05Z"}},
        "first_seen":"2026-01-02T03:04:05Z","last_seen":"2026-11-25T13:00:00Z","management_url":"https://apps.apple.com/account/subscriptions",
        "non_subscriptions":{"tip":[{"id":"x","is_sandbox":false,"purchase_date":"2026-02-01T00:00:00Z","store":"app_store"}]},
        "original_app_user_id":"$RCAnonymousID:0123456789abcdef0123456789abcdef","original_application_version":"155","original_purchase_date":"2026-01-02T03:04:05Z",
        "other_purchases":{},"subscriber_attributes":{},
        "subscriptions":{
          "happy":{"auto_resume_date":null,"billing_issues_detected_at":null,"expires_date":"2026-12-20T08:00:05Z","grace_period_expires_date":null,
            "is_sandbox":false,"original_purchase_date":"2026-10-20T08:00:05Z","ownership_type":"PURCHASED","period_type":"normal",
            "purchase_date":"2026-11-20T08:00:05Z","refunded_at":null,"store":"app_store","store_transaction_id":"2000000003",
            "unsubscribe_detected_at":null,"price":{"amount":19.99,"currency":"USD"}},
          "happy_old":{"auto_resume_date":null,"billing_issues_detected_at":null,"expires_date":"2026-03-01T00:00:00Z","grace_period_expires_date":"2026-03-08T00:00:00Z",
            "is_sandbox":false,"original_purchase_date":"2026-02-01T00:00:00Z","ownership_type":"PURCHASED","period_type":"normal",
            "purchase_date":"2026-02-01T00:00:00Z","refunded_at":null,"store":"app_store","store_transaction_id":"2000000001","unsubscribe_detected_at":"2026-02-10T00:00:00Z"}
        }
      }
    }
    """
}
