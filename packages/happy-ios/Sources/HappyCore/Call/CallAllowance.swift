import Foundation

/// The voice time this device has spent on calls: one span per call, from
/// the moment it connected to the moment it ended (or the last time it was
/// counted, should the app die mid-call). Connecting and failed calls
/// spend nothing.
public struct CallUsage: Codable, Equatable, Sendable {
    public struct Span: Codable, Equatable, Sendable {
        public var id: String
        public var start: Double
        public var end: Double
    }

    public var spans: [Span] = []

    public init(spans: [Span] = []) { self.spans = spans }

    /// Seconds spent since `window` seconds before `now`; a span across
    /// that edge counts only the part after it. A span after `now` (the
    /// clock was put back) counts whole: turning the clock back gives no
    /// time back.
    public func used(at now: Double, window: Double) -> Double {
        let from = now - window
        return spans.reduce(0) { $0 + max(0, $1.end - max($1.start, from)) }
    }

    /// Counts a call up to `end`; the same call again only grows its span.
    public mutating func record(call id: String, from start: Double, to end: Double) {
        if let index = spans.firstIndex(where: { $0.id == id }) {
            spans[index].end = max(spans[index].end, end)
        } else {
            spans.append(Span(id: id, start: start, end: max(start, end)))
        }
    }

    /// When, after `now`, less than `free` seconds are spent again, as the
    /// older calls pass out of the window; to the second. Nil when the
    /// window is never under it (a span after `now`, from a clock put back,
    /// never passes out).
    public func freeAgain(after now: Double, free: Double, window: Double) -> Double? {
        if used(at: now, window: window) < free { return now }
        var low = now
        var high = now + window
        guard used(at: high, window: window) < free else { return nil }
        while high - low > 1 {
            let middle = (low + high) / 2
            if used(at: middle, window: window) < free { high = middle } else { low = middle }
        }
        return high.rounded(.up)
    }

    public mutating func forget(before time: Double) {
        spans.removeAll { $0.end < time }
    }
}

public protocol CallUsageStore: Sendable {
    func load() -> CallUsage
    func save(_ usage: CallUsage)
}

/// This device's spans, in its defaults. Kept across sign-outs: they
/// count the device, not an account.
public struct DefaultsCallUsageStore: CallUsageStore {
    public static let key = "call.usage"
    public init() {}
    public func load() -> CallUsage {
        UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(CallUsage.self, from: $0) } ?? CallUsage()
    }
    public func save(_ usage: CallUsage) {
        UserDefaults.standard.set(try? JSONEncoder().encode(usage), forKey: Self.key)
    }
}

/// The free voice time a device has on agent calls: 20 minutes in any 30
/// days, rolling, counted here. Provisional, like the public agent it goes
/// with (`PublicAgentCallGrants`): there is no server to ask yet, and
/// nothing to buy that would lift it. Not a number of calls, and no other
/// cap.
@MainActor
public final class CallAllowance {
    public static let freeSeconds: Double = 20 * 60
    public static let window: Double = 30 * 86_400

    private let store: any CallUsageStore
    private let free: Double
    private let window: Double
    private var usage: CallUsage

    public init(store: any CallUsageStore = DefaultsCallUsageStore(), free: Double = CallAllowance.freeSeconds, window: Double = CallAllowance.window) {
        self.store = store
        self.free = free
        self.window = window
        usage = store.load()
    }

    public func remaining(at now: Double) -> Double {
        max(0, free - usage.used(at: now, window: window))
    }

    /// When some free time is back, once it has all been used.
    public func freeAgain(after now: Double) -> Double? {
        usage.freeAgain(after: now, free: free, window: window)
    }

    public func record(call id: String, from start: Double, to end: Double) {
        usage.record(call: id, from: start, to: end)
        usage.forget(before: end - window)
        store.save(usage)
    }
}


/// What the voice paywall can offer once the free time is used. Nothing
/// yet: the store's products, their prices and the subscription's
/// entitlement aren't chosen, so the paywall says so and sells nothing.
/// A purchase and a restore come with the products, never before.
public enum CallOffer: Equatable, Sendable {
    case unavailable
    /// Debug builds' test screens only (`HAPPY_CALL_OFFER=preview`): the
    /// subscription drawn as if it were on sale, its button a preview that
    /// charges and grants nothing. Never in a release build. `price` is
    /// what the sheet says: `CallOffer.price`, or what the run gives
    /// (`HAPPY_CALL_OFFER_PRICE`).
    case preview(price: String)

    /// The monthly price as approved, until the store's own localised one
    /// replaces it. It buys 5 hours of real-time voice a month.
    public static let price = "$20"

    public var onSale: Bool {
        if case .preview = self { true } else { false }
    }
}

/// Whether this device has seen voice's welcome. It shows once, on the
/// first tap of the voice button while a subscription is on sale; from then
/// on, however it was closed, the button calls. In the device's defaults,
/// beside its free time (`DefaultsCallUsageStore`).
public struct CallIntro {
    public static let key = "call.intro.seen"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var due: Bool { !defaults.bool(forKey: Self.key) }

    /// Whether a tap of the voice button while `offer` is up shows the
    /// welcome, counted as seen; false when the button just calls.
    public func welcomes(_ offer: CallOffer) -> Bool {
        guard offer.onSale, due else { return false }
        seen()
        return true
    }

    /// Shown: the voice button calls from now on.
    public func seen() {
        defaults.set(true, forKey: Self.key)
    }
}
