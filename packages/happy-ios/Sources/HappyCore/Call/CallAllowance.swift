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

    public func record(call id: String, from start: Double, to end: Double) {
        usage.record(call: id, from: start, to: end)
        usage.forget(before: end - window)
        store.save(usage)
    }
}
