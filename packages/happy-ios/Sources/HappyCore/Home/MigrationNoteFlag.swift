import Foundation

/// Whether PostHog's `direct-connection-migration-note` flag lets the Happy
/// CLI home show its migration card. Only the answer lives here, in memory
/// for this launch: asking PostHog is the analytics module's, for its
/// install id, so a build without that module never asks and never shows
/// the card.
///
/// The card shows only for a yes while something may ask. No ask allowed,
/// an opted-out person, a request on its way, a failure or no answer yet
/// all hide it, and nothing waits on it: startup, connections and pairing
/// never ask.
@MainActor
public final class MigrationNoteFlag {
    public nonisolated static let key = "direct-connection-migration-note"

    public static let shared = MigrationNoteFlag()

    /// Harnesses: the answer, and nothing asked.
    public var fixedAnswer: Bool?
    /// Whether the answer counts: set by whatever asks PostHog, while it
    /// may. Left false, as in a build without analytics, the card hides.
    public var isAnswering = false {
        didSet { if isAnswering != oldValue { notify() } }
    }
    /// PostHog's last answer this launch; nil before one.
    public private(set) var answer: Bool?

    private var observers: [UUID: () -> Void] = [:]

    public init() {}

    /// Whether the card may show; `optedOut`, the open account's own setting.
    public func isOn(optedOut: Bool) -> Bool {
        guard !optedOut else { return false }
        if let fixedAnswer { return fixedAnswer }
        return isAnswering && answer == true
    }

    public func observe(_ handler: @escaping () -> Void) -> AccountsObservation {
        let id = UUID()
        observers[id] = handler
        return AccountsObservation { [weak self] in
            Task { @MainActor [weak self] in _ = self?.observers.removeValue(forKey: id) }
        }
    }

    /// PostHog's answer; nil drops it.
    public func store(_ value: Bool?) {
        guard answer != value else { return }
        answer = value
        notify()
    }

    private func notify() {
        for observer in observers.values { observer() }
    }
}
