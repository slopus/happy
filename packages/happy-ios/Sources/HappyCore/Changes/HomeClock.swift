import Foundation
import HappyStore

/// When home's labels can read differently with no change in the store.
/// A stamp is the time for a day, then the weekday for a week, then the
/// date; a heading counts calendar days. Between those instants deriving
/// again gives the same rows, so nothing runs on a minute timer.
public enum HomeClockBoundary {
    private static let day: Int64 = 24 * 60 * 60 * 1000

    /// The next midnight, or the first session stamp to turn from a time
    /// into a weekday or from a weekday into a date, whichever comes first.
    /// A new year is a midnight.
    public static func next(after clock: SessionList.Clock, snapshot: HomeSnapshot) -> Date {
        let now = Int64(clock.now.timeIntervalSince1970 * 1000)
        let today = clock.calendar.startOfDay(for: clock.now)
        var next = clock.calendar.date(byAdding: .day, value: 1, to: today) ?? clock.now.addingTimeInterval(24 * 60 * 60)
        for session in snapshot.sessions {
            let at = session.lastActivityAt
            let age = now - at
            let flip: Int64? = age < day ? at + day : age < 7 * day ? at + 7 * day : nil
            if let flip {
                next = min(next, Date(timeIntervalSince1970: Double(flip) / 1000))
            }
        }
        return next
    }
}

/// Wakes a derivation once, off the main thread, at the latest deadline it
/// was given. A new deadline replaces the one waiting; `cancel` (or letting
/// it go) stops it for good.
public final class ClockWake: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: (deadline: Date, task: Task<Void, Never>)?
    private var cancelled = false
    private var action: (@Sendable () -> Void)?

    public init() {}

    deinit {
        waiting?.task.cancel()
    }

    /// What a deadline does when it comes.
    public func onWake(_ action: @escaping @Sendable () -> Void) {
        lock.withLock { self.action = action }
    }

    /// Wakes at `deadline`, unless it is already the one waiting; nil
    /// waits for nothing.
    public func schedule(_ deadline: Date?) {
        lock.withLock {
            guard !cancelled, waiting?.deadline != deadline else { return }
            waiting?.task.cancel()
            waiting = nil
            guard let deadline else { return }
            let task = Task.detached(priority: .utility) { [weak self] in
                let wait = deadline.timeIntervalSinceNow
                if wait > 0 {
                    do { try await Task.sleep(for: .seconds(wait)) } catch { return }
                }
                self?.fire(deadline)
            }
            waiting = (deadline, task)
        }
    }

    /// The deadline waiting, if any.
    public var deadline: Date? {
        lock.withLock { waiting?.deadline }
    }

    public func cancel() {
        lock.withLock {
            cancelled = true
            waiting?.task.cancel()
            waiting = nil
            action = nil
        }
    }

    private func fire(_ deadline: Date) {
        let action: (@Sendable () -> Void)? = lock.withLock {
            guard !cancelled, waiting?.deadline == deadline else { return nil }
            waiting = nil
            return self.action
        }
        action?()
    }
}

extension HomeDerivation {
    /// `derive` at one instant (the input's clock, or now), with `wake` set
    /// for the next instant a label can change, so home is derived again
    /// then even if the store never changes. The result is nil, and the
    /// main thread hears nothing, if no label did.
    public static func derive(_ input: Input, applied: Applied, wake: ClockWake) -> (output: HomeUpdate, state: Applied)? {
        var input = input
        let clock = input.clock ?? SessionList.Clock()
        input.clock = clock
        if let snapshot = input.snapshot {
            wake.schedule(HomeClockBoundary.next(after: clock, snapshot: snapshot))
        }
        return derive(input, applied: applied)
    }
}
