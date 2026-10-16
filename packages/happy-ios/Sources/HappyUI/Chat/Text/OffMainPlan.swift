#if canImport(UIKit)
import HappyCore
import UIKit

/// A view's text measured and laid out off the main thread (AGENTS.md rule
/// 8), as NoSessionsView's is: the view says on main what it shows, at what
/// size and text size (`Input`), a background task makes the plan, and only
/// a plan for the input asked for last is taken. Until the first is in
/// there is none; after a change the last one stays until the next is.
@MainActor
final class OffMainPlan<Input: Equatable & Sendable, Plan: Sendable> {
    /// Called on main once a plan is taken.
    var onApply: (() -> Void)?
    private(set) var requested: Input?
    private(set) var applied: (input: Input, plan: Plan)?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let make: @Sendable (Input) -> Plan
    private lazy var pipeline = ApplyPipeline<Input?, Input?, (input: Input, plan: Plan)>(
        input: nil,
        state: nil,
        derive: { [make] input, applied in
            guard let input, input != applied else { return nil }
            return ((input, make(input)), input)
        },
        apply: { [weak self] result in self?.take(result) ?? false }
    )

    /// `make` runs off the main thread.
    init(_ make: @escaping @Sendable (Input) -> Plan) {
        self.make = make
    }

    /// Asks for `input`'s plan, unless it is what was asked for last.
    func request(_ input: Input) {
        guard input != requested else { return }
        requested = input
        pipeline.update { $0 = input }
    }

    /// The plan taken last, whatever it was made for.
    var plan: Plan? { applied?.plan }

    /// The plan taken last if it was made for `input`.
    func plan(for input: Input) -> Plan? {
        applied.flatMap { $0.input == input ? $0.plan : nil }
    }

    /// Whether the plan for what was asked last is in.
    var isCurrent: Bool { requested != nil && applied?.input == requested }

    private func take(_ result: (input: Input, plan: Plan)) -> Bool {
        guard result.input == requested else { return false }
        applied = result
        onApply?()
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume() }
        return true
    }

    /// Returns once the plan for the input asked for last is taken (tests).
    func measured() async {
        guard requested != nil, !isCurrent else { return }
        await withCheckedContinuation { waiters.append($0) }
        if !isCurrent { await measured() }
    }
}
#endif
