import Foundation
import HappyWire

/// One month of the subscription's voice hours, from `start`; `end` is when
/// the next month's begin, nil while a renewal is in a billing grace period
/// (they begin only if it succeeds). Seconds since 1970.
public struct ProMonth: Codable, Equatable, Sendable {
    public var start: Double
    public var end: Double?

    public init(start: Double, end: Double?) {
        self.start = start
        self.end = end
    }

    /// The calendar month, in UTC, that `now` is in: a granted subscription's month (`Subscription.grantsPro`).
    public static func calendar(at now: Double) -> ProMonth {
        let month = ProPass.calendar.dateInterval(of: .month, for: Date(timeIntervalSince1970: now))
        return ProMonth(start: month?.start.timeIntervalSince1970 ?? now, end: month?.end.timeIntervalSince1970)
    }
}

/// RevenueCat's word on a customer's `pro` entitlement, from a subscriber
/// answer (`GET /v1/subscribers/{id}`, `POST /v1/receipts`), read as its
/// SDK reads it (`CustomerInfoResponse`): the entitlement's latest purchase
/// (`purchase_date`; a renewal is a new one) and when access ends
/// (`expires_date`, which RevenueCat moves to the grace period's end; null
/// for a lifetime grant); from the subscription that grants it
/// (`subscriptions[product_identifier]`, none for a one-time product), when
/// its paid period ends (`renews`, its `expires_date`) and until when a
/// failed renewal keeps access (`graceUntil`, `grace_period_expires_date`);
/// and RevenueCat's own time when it answered (`checkedAt`, `request_date`);
/// the product itself (`product`, `product_identifier`), for its price.
/// Any product granting `pro` counts, whatever is on sale.
public struct ProPass: Codable, Equatable, Sendable {
    public static let entitlement = "pro"

    public var purchased: Double
    public var expires: Double?
    public var renews: Double?
    public var graceUntil: Double?
    public var checkedAt: Double
    /// Nil in a pass kept before it was read.
    public var product: String?

    public init(purchased: Double, expires: Double?, renews: Double? = nil, graceUntil: Double? = nil, checkedAt: Double, product: String? = nil) {
        self.purchased = purchased
        self.expires = expires
        self.renews = renews
        self.graceUntil = graceUntil
        self.checkedAt = checkedAt
        self.product = product
    }

    /// Access at RevenueCat's time `at`: the device's clock alone decides nothing here.
    public func active(at: Double) -> Bool {
        expires.map { $0 > at } ?? true
    }

    /// In a billing grace period at `at`: the paid period over, the renewal
    /// failed, access kept until `graceUntil`. A grace date that has passed,
    /// or one ahead while the paid period still runs, is none.
    public func inGrace(at: Double) -> Bool {
        guard let graceUntil, let renews else { return false }
        return at < graceUntil && renews <= at
    }

    /// The month of hours at RevenueCat's `at`: calendar months (UTC) from
    /// the latest purchase, a monthly product's one per renewal, a yearly or
    /// lifetime one's every month after its purchase. In grace the month
    /// before still runs, with no new hours and no known end. Nil when not
    /// `active`. This is the meter's window, not access: access is `active`.
    public func month(at: Double) -> ProMonth? {
        guard active(at: at) else { return nil }
        var months = 0
        while let next = Self.month(months + 1, from: purchased), next <= at { months += 1 }
        if inGrace(at: at) { return ProMonth(start: Self.month(max(0, months - 1), from: purchased) ?? purchased, end: nil) }
        return ProMonth(start: Self.month(months, from: purchased) ?? purchased, end: Self.month(months + 1, from: purchased))
    }

    /// `purchase` and `n` calendar months, in UTC: Jan 31 → Feb 28 (29) → Mar 31 → Apr 30.
    static func month(_ n: Int, from purchase: Double) -> Double? {
        Self.calendar.date(byAdding: .month, value: n, to: Date(timeIntervalSince1970: purchase))?.timeIntervalSince1970
    }

    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// What a subscriber answer says about `pro`.
    public enum Answer: Equatable, Sendable {
        case pro(ProPass)
        /// No `pro`, or a grant that isn't well formed: nothing is granted.
        case none
    }

    /// `response` read as a subscriber answer; nil when it isn't one (no
    /// `request_date` or `subscriber`). A malformed grant (a date that isn't
    /// one, `expires_date` missing rather than null, no product) is `.none`.
    public static func answer(_ response: JSONValue) -> Answer? {
        guard let checkedAt = date(response["request_date"]), let subscriber = response["subscriber"], subscriber.objectValue != nil else { return nil }
        guard let granted = subscriber["entitlements"]?[entitlement], granted.objectValue != nil,
              let product = granted["product_identifier"]?.stringValue,
              let purchased = date(granted["purchase_date"]),
              let expires = optionalDate(granted["expires_date"], required: true) else { return Answer.none }
        // Grace lives on the subscription the entitlement names, never on the entitlement.
        let subscription = subscriber["subscriptions"]?[product]
        guard let renews = optionalDate(subscription?["expires_date"]),
              let graceUntil = optionalDate(subscription?["grace_period_expires_date"]) else { return Answer.none }
        return .pro(ProPass(purchased: purchased, expires: expires.value, renews: renews.value, graceUntil: graceUntil.value, checkedAt: checkedAt, product: product))
    }

    private struct Optional {
        var value: Double?
    }

    /// Null (or absent, unless `required`) is a known nothing; anything but a date is malformed (nil).
    private static func optionalDate(_ value: JSONValue?, required: Bool = false) -> Optional? {
        switch value {
        case nil: required ? nil : Optional(value: nil)
        case .null?: Optional(value: nil)
        case let value?: date(value).map { Optional(value: $0) }
        }
    }

    static func date(_ value: JSONValue?) -> Double? {
        guard let text = value?.stringValue else { return nil }
        if let date = try? Date(text, strategy: .iso8601) { return date.timeIntervalSince1970 }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date.timeIntervalSince1970 }
        return nil
    }
}

/// The last word RevenueCat gave about a customer's `pro`, and the device's
/// clock when it did. Used only while it would still be active at
/// RevenueCat's time moved on by the device's, and never longer than
/// `maxAge` since it was asked: past that, or with the clock put back,
/// access is unknown and nothing is granted until RevenueCat answers.
public struct ProPassCache: Sendable {
    public static let key = "subscription.pass"
    public static let maxAge: Double = 86_400

    private struct Entry: Codable {
        var customer: String
        var pass: ProPass?
        var askedAt: Double
    }

    private let store: any KeyValueStore
    private let maxAge: Double

    public init(store: any KeyValueStore, maxAge: Double = ProPassCache.maxAge) {
        self.store = store
        self.maxAge = maxAge
    }

    /// RevenueCat's answer for `customer` at device time `now`; a nil `pass` is a customer without `pro`.
    public func save(customer: String, pass: ProPass?, now: Double) {
        let entry = Entry(customer: customer, pass: pass, askedAt: now)
        store.set((try? JSONEncoder().encode(entry)).flatMap { String(data: $0, encoding: .utf8) }, forKey: Self.key)
    }

    /// The pass and RevenueCat's time for `customer` at device time `now`; nil when that isn't known.
    public func pass(customer: String, now: Double) -> (pass: ProPass?, at: Double)? {
        guard let text = store.string(forKey: Self.key),
              let entry = try? JSONDecoder().decode(Entry.self, from: Data(text.utf8)),
              entry.customer == customer, now >= entry.askedAt, now - entry.askedAt <= maxAge else { return nil }
        guard let pass = entry.pass else { return (nil, now) }
        return (pass, pass.checkedAt + (now - entry.askedAt))
    }

    /// Whether `customer` has `pro` at `now`, as RevenueCat said within `maxAge`.
    public func active(customer: String, now: Double) -> Bool {
        guard let known = pass(customer: customer, now: now), let pass = known.pass else { return false }
        return pass.active(at: known.at)
    }

    /// The month whose hours `customer` has at `now`; nil without `pro`, or when that isn't known.
    public func month(customer: String, now: Double) -> ProMonth? {
        guard let known = pass(customer: customer, now: now) else { return nil }
        return known.pass?.month(at: known.at)
    }

    public func clear() {
        store.set(nil, forKey: Self.key)
    }
}
