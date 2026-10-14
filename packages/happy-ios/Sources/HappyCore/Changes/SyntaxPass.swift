import Foundation

/// One first-paint budget for the syntax colour a whole planning pass
/// starts (`DiffSyntax.revealMilliseconds`, happy-app's rows revealing
/// together). Plans made inside `run` share its deadline, however many
/// rows the pass measures, so a window of 46 diffs costs at most one
/// second of tokenizing, not one second each. Outside a pass a plan gets
/// a budget of its own, as before.
///
/// The deadline is never part of a row's input: a row planned in a later
/// pass with the same input is the same row, and is not measured again.
/// Like the service it gates, it is cooperative: a hunk started before it
/// runs to its end.
public enum SyntaxPass {
    /// The deadline of the pass running on this task or thread, if any.
    @TaskLocal public static var current: ContinuousClock.Instant?

    /// The pass's deadline, or a fresh budget from `now` outside a pass.
    public static func deadline(now: ContinuousClock.Instant = .now) -> ContinuousClock.Instant {
        current ?? now + .milliseconds(DiffSyntax.revealMilliseconds)
    }

    /// Runs `body` as one pass ending its colour work at `deadline`.
    public static func run<T>(until deadline: ContinuousClock.Instant, _ body: () throws -> T) rethrows -> T {
        try $current.withValue(deadline, operation: body)
    }

    /// Set while one row is measured: whether any of its colour was not
    /// ready and is being made in the background (`notePending`).
    final class PendingFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var raised = false
        var value: Bool { lock.withLock { raised } }
        func raise() { lock.withLock { raised = true } }
    }

    @TaskLocal static var pending: PendingFlag?

    /// Called by a colour service that answered plain for now: the row
    /// being measured is drawn again once the service signals.
    public static func notePending() {
        pending?.raise()
    }

    /// Runs `body` and says whether anything in it noted pending colour.
    public static func measuring<T>(_ body: () throws -> T) rethrows -> (value: T, pending: Bool) {
        let flag = PendingFlag()
        let value = try $pending.withValue(flag, operation: body)
        return (value, flag.value)
    }
}
