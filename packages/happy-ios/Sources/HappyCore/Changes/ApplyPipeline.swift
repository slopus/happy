import Dispatch
import Foundation

/// What an `ApplyPipeline` has done, for the exact-count tests and the
/// debug apply log.
public struct ApplyCounters: Equatable, Sendable {
    /// Updates that started the background worker.
    public var wakeups = 0
    /// Inputs taken and derived.
    public var derivations = 0
    /// Derivations that changed nothing on screen.
    public var unchanged = 0
    /// Results dropped for a newer input before they applied.
    public var superseded = 0
    /// Results the screen applied.
    public var applies = 0
    /// Results the screen refused (it had moved on, say to a new width).
    public var rejected = 0
    /// Time spent applying, on the main thread.
    public var mainMilliseconds: Double = 0
    /// The longest single apply.
    public var longestApplyMilliseconds: Double = 0

    public init() {}
}

/// Keeps an `ApplyPipeline` (and the feeds it follows) running until it is
/// cancelled or released.
public final class ApplyObservation: Sendable {
    private let stop: @Sendable () -> Void
    private let read: @Sendable () -> ApplyCounters

    public init(stop: @escaping @Sendable () -> Void, counts: @escaping @Sendable () -> ApplyCounters) {
        self.stop = stop
        self.read = counts
    }

    public func cancel() { stop() }

    /// The pipeline's counters so far.
    public var counts: ApplyCounters { read() }

    deinit { stop() }
}

/// Works out what a screen shows off the main thread, and applies it on the
/// main actor one result at a time (AGENTS.md rule 8):
///   - `derive` runs on a background task with the newest input and the
///     state the screen applied last. It returns nil when nothing the
///     screen renders changed, and then the main thread hears nothing;
///   - `apply` runs on the main actor and says whether it took the result.
///     Only then does the state move on, so every diff is against what is
///     on screen, never against a result that was dropped;
///   - inputs that arrive while a result is being worked out are merged
///     into one, so a burst costs one more derivation and one more apply;
///   - a result that is about to apply while a newer input already waits
///     is dropped for the newer one, but never twice in a row, so a steady
///     stream still reaches the screen;
///   - an apply starts at least `minimumInterval` (a 60 Hz frame by
///     default) after the previous one finished, refused or not. The wait
///     is spent before deriving, so whatever arrives meanwhile is merged
///     into the next result. This is wall-clock spacing, not the display's
///     frame clock.
///
/// The input is a value the feeds and the screen both write to: a feed sets
/// its snapshot, the screen the things it decides on the main thread (a
/// width, a theme, what the reader opened).
public final class ApplyPipeline<Input: Sendable, State: Sendable, Output: Sendable>: @unchecked Sendable {
    public typealias Derive = @Sendable (_ input: Input, _ applied: State) -> (output: Output, state: State)?
    public typealias Apply = @MainActor @Sendable (_ output: Output) -> Bool

    private enum Outcome {
        case applied
        case refused
        case superseded
        case cancelled
    }

    private let lock = NSLock()
    private var input: Input
    private var state: State
    private var dirty = false
    private var running = false
    private var cancelled = false
    private var lastSuperseded = false
    private var counters = ApplyCounters()
    private var feeds: [Task<Void, Never>] = []
    private let derive: Derive
    private let apply: Apply
    private let priority: TaskPriority
    private let minimumInterval: Duration
    /// When the last apply finished.
    private var lastApply: ContinuousClock.Instant?

    /// One 60 Hz frame.
    public static var frame: Duration { .nanoseconds(16_666_667) }

    public init(
        input: Input,
        state: State,
        priority: TaskPriority = .userInitiated,
        minimumInterval: Duration = ApplyPipeline.frame,
        derive: @escaping Derive,
        apply: @escaping Apply
    ) {
        self.input = input
        self.state = state
        self.priority = priority
        self.minimumInterval = minimumInterval
        self.derive = derive
        self.apply = apply
    }

    deinit {
        for feed in feeds { feed.cancel() }
    }

    /// Changes the input and makes sure a derivation follows.
    public func update(_ change: (inout Input) -> Void) {
        update(ifChanged: { input in change(&input); return true })
    }

    private func update(ifChanged change: (inout Input) -> Bool) {
        let start: Bool = lock.withLock {
            guard !cancelled else { return false }
            guard change(&input) else { return false }
            dirty = true
            guard !running else { return false }
            running = true
            counters.wakeups += 1
            return true
        }
        if start {
            Task.detached(priority: priority) { [self] in await run() }
        }
    }

    /// Writes each value of `stream` into the input, off the main thread,
    /// until the pipeline is cancelled.
    public func follow<Value: Sendable>(_ stream: AsyncStream<Value>, _ assign: @escaping @Sendable (inout Input, Value) -> Void) {
        follow(ifChanged: stream) { input, value in assign(&input, value); return true }
    }

    /// Compares and assigns a feed value under the input lock. The closure
    /// must be cheap and pure: no I/O or re-entry. Return false without
    /// changing the input when its value is already current; that leaves
    /// the worker, dirty flag and applied state untouched.
    public func follow<Value: Sendable>(ifChanged stream: AsyncStream<Value>, _ assign: @escaping @Sendable (inout Input, Value) -> Bool) {
        let task = Task.detached(priority: priority) { [weak self] in
            for await value in stream {
                guard let self, !Task.isCancelled else { return }
                self.update(ifChanged: { assign(&$0, value) })
            }
        }
        let keep: Bool = lock.withLock {
            guard !cancelled else { return false }
            feeds.append(task)
            return true
        }
        if !keep { task.cancel() }
    }

    /// Stops deriving and applying; a derivation already running finishes
    /// but is never applied.
    public func cancel() {
        let tasks: [Task<Void, Never>] = lock.withLock {
            cancelled = true
            defer { feeds = [] }
            return feeds
        }
        for task in tasks { task.cancel() }
    }

    public var counts: ApplyCounters {
        lock.withLock { counters }
    }

    /// A token that keeps this pipeline alive, and cancels it when released.
    public var observation: ApplyObservation {
        ApplyObservation(stop: { self.cancel() }, counts: { self.counts })
    }

    /// The state the screen applied last.
    public var applied: State {
        lock.withLock { state }
    }

    private func run() async {
        while true {
            // Checked again on waking: a timer may fire a little early.
            while let wait = lock.withLock({ cancelled ? nil : lastApply.map { $0 + minimumInterval - ContinuousClock.now } }),
                  wait > .zero {
                do { try await Task.sleep(for: wait) } catch { break }
            }
            let next: (Input, State)? = lock.withLock {
                guard !cancelled, dirty else {
                    running = false
                    return nil
                }
                dirty = false
                return (input, state)
            }
            guard let (input, state) = next else { return }
            #if DEBUG
            dispatchPrecondition(condition: .notOnQueue(.main))
            #endif
            let result = derive(input, state)
            lock.withLock {
                counters.derivations += 1
                if result == nil { counters.unchanged += 1 }
            }
            guard let result else { continue }
            let (output, derived) = result
            _ = await MainActor.run { self.deliver(output, state: derived) }
        }
    }

    /// Applies `output` unless cancelled or superseded. An apply the screen
    /// takes moves the applied state to `state` in the same step that counts
    /// it, so `applied` and `counts` never disagree.
    @MainActor
    private func deliver(_ output: Output, state next: State) -> Outcome {
        let proceed: Outcome? = lock.withLock {
            if cancelled { return .cancelled }
            if dirty && !lastSuperseded {
                lastSuperseded = true
                counters.superseded += 1
                return .superseded
            }
            lastSuperseded = false
            return nil
        }
        if let proceed { return proceed }
        let start = ContinuousClock.now
        let took = apply(output)
        let end = ContinuousClock.now
        let elapsed = start.duration(to: end).milliseconds
        lock.withLock {
            // Paced from the end, so a slow apply still leaves the main
            // thread a whole interval before the next one.
            lastApply = end
            if took {
                state = next
                counters.applies += 1
            } else {
                counters.rejected += 1
            }
            counters.mainMilliseconds += elapsed
            counters.longestApplyMilliseconds = max(counters.longestApplyMilliseconds, elapsed)
        }
        return took ? .applied : .refused
    }
}

extension Duration {
    /// The duration in milliseconds, fractions included.
    public var milliseconds: Double {
        let parts = components
        return Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15
    }
}
