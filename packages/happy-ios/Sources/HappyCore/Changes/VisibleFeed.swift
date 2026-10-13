import Foundation

/// A screen's subscription to one account feed, held only while the screen
/// is on screen. `start` on appear follows the feed through an
/// `ApplyPipeline`; `stop` on disappear cancels it, and the feed ends its
/// SQL observation with its last subscriber, so nothing is read for a
/// screen nobody is looking at. Coming back subscribes again and reads the
/// database afresh rather than a value cached while the screen was away.
///
/// A value equal to the one applied last, before or after a gap, applies
/// nothing: the feed already publishes only changes, and the comparison
/// runs off the main thread.
@MainActor
public final class VisibleFeed<Value: Equatable & Sendable> {
    public typealias Apply = @MainActor @Sendable (_ value: Value) -> Bool

    private let apply: Apply
    private var observation: ApplyObservation?
    /// What the screen took last, across subscriptions.
    private var applied: Value?

    /// `apply` returns false to refuse a value (a screen that moved on to
    /// another account); a refused value is offered again by the next one.
    public init(apply: @escaping Apply) {
        self.apply = apply
    }

    public var isFollowing: Bool { observation != nil }

    /// The current subscription's counters.
    public var counts: ApplyCounters? { observation?.counts }

    /// Subscribes, unless already following. `snapshots` is only called
    /// to subscribe.
    public func start(_ snapshots: () -> AsyncStream<Value>) {
        guard observation == nil else { return }
        let pipeline = ApplyPipeline<Value?, Value?, Value>(
            input: nil,
            state: applied,
            derive: { value, applied in
                guard let value, value != applied else { return nil }
                return (value, value)
            },
            apply: { [weak self, apply] value in
                guard self != nil, apply(value) else { return false }
                self?.applied = value
                return true
            }
        )
        pipeline.follow(snapshots()) { $0 = $1 }
        observation = pipeline.observation
    }

    /// Cancels the subscription; a value already derived is not applied.
    public func stop() {
        observation?.cancel()
        observation = nil
    }
}
