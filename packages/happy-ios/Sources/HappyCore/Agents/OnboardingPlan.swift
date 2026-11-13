import Foundation

/// What the onboarding flow shows next, worked out from the gates alone:
/// the first gate the person can see to now, in the server's order; once
/// none is left, whatever still holds them; else the finish. Every screen
/// replaces the last, and each is read again from the server's answer.
public struct OnboardingPlan: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        /// A screen for a gate the person can see to now.
        case gate(OnboardingGate)
        /// A gate this app can't show blocks the person: Update Happy.
        case update
        /// Gates that block the person that only someone else can see to,
        /// or that the server can't tell yet.
        case waiting([OnboardingGate])
        /// Nothing holds the person: finish (`completeOnboarding`).
        case finish
    }

    /// Nil once onboarding is complete.
    public var step: Step?
    /// How many gates the flow walks through, done ones included.
    public var count: Int
    /// How many of them are still the person's to see to.
    public var remaining: Int

    public init(_ onboarding: Onboarding) {
        // A gate is shown when this app knows it and the person can see to
        // it or is held by it; an optional one they can't act on never is.
        let shown = onboarding.gates.filter { $0.kind != .unknown && ($0.canComplete || $0.blocking) }
        let actionable = shown.filter { $0.isPending && Self.canAct(on: $0) }
        count = shown.count
        remaining = actionable.count
        guard !onboarding.completed else { step = nil; return }
        if let next = actionable.first { step = .gate(next); return }
        let held = onboarding.gates.filter(\.blocking)
        if held.contains(where: { $0.kind == .unknown && $0.canComplete && $0.status != .unavailable }) { step = .update; return }
        step = held.isEmpty ? .finish : .waiting(held)
    }

    /// A gate the person can see to on this phone now: theirs to complete,
    /// and one the server can tell. An unknown optional one is passed over
    /// on screen, never skipped: finishing skips it.
    static func canAct(on gate: OnboardingGate) -> Bool {
        gate.kind != .unknown && gate.canComplete && gate.status != .unavailable
    }

    /// How far along the flow is, from 0 to 1.
    public var progress: Double {
        count == 0 ? 1 : Double(count - remaining) / Double(count)
    }
}
