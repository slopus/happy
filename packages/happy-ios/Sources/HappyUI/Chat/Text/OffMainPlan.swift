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
    private let make: @Sendable (Input, Plan?) -> Plan
    /// Asked only for what is new (`request`), so every input is made.
    /// Its state is the plan taken last.
    private lazy var pipeline = ApplyPipeline<Input?, Plan?, (input: Input, plan: Plan)>(
        input: nil,
        state: nil,
        derive: { [make] input, taken in
            input.map { input in
                let plan = make(input, taken)
                return ((input, plan), plan)
            }
        },
        apply: { [weak self] result in self?.take(result) ?? false }
    )

    /// `make` runs off the main thread.
    init(_ make: @escaping @Sendable (Input) -> Plan) {
        self.make = { input, _ in make(input) }
    }

    /// `make` runs off the main thread, handed the plan taken last (nil
    /// before the first), to keep what is still right in it.
    init(reusing make: @escaping @Sendable (Input, _ taken: Plan?) -> Plan) {
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

    /// Nothing asked for, or the plan for it is in: nothing on its way
    /// would change what is drawn (`ChatOpening`).
    var isSettled: Bool { requested == nil || isCurrent }

    /// Forgets the plan and what was asked, so nothing old is drawn when
    /// the view shows again (a bar that went away). A plan on its way is
    /// refused.
    func reset() {
        requested = nil
        applied = nil
    }

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

extension UITraitCollection {
    /// What a view's text is measured and drawn in: the person's text size
    /// where it follows it (`FollowsTextSize`), the designed size
    /// elsewhere, on this screen's pixels either way.
    @MainActor
    var measuredTextEnvironment: TextEnvironment {
        var text = TextEnvironment(self)
        if !self[FollowsTextSize.self] { text.scale = .standard }
        return text
    }
}
#endif
