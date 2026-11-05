import Foundation

/// Whether PostHog's `direct-connection-migration-note` flag lets the Happy
/// CLI home show its migration card. Only the answer lives here: asking
/// PostHog is the analytics module's, for its install id, so a build
/// without that module never asks and never shows the card.
///
/// The card shows only for a stored yes while something may ask. No ask
/// allowed, an opted-out person, a request on its way, a failure or no
/// answer yet all hide it, and nothing waits on it: startup, connections
/// and pairing never ask. The last answer is kept per account (its
/// `LocalSettings`).
@MainActor
public final class MigrationNoteFlag {
    public nonisolated static let key = "direct-connection-migration-note"

    public static let shared = MigrationNoteFlag()

    /// Harnesses: the answer, and nothing asked or stored.
    public var fixedAnswer: Bool?
    /// Whether a stored answer counts: set by whatever asks PostHog, while
    /// it may. Left false, as in a build without analytics, the card hides.
    public var isAnswering = false {
        didSet { if isAnswering != oldValue { notify() } }
    }

    private var observers: [UUID: () -> Void] = [:]

    public init() {}

    /// Whether the card may show for the account `settings` belong to.
    public func isOn(_ settings: LocalSettings, optedOut: Bool) -> Bool {
        guard !optedOut else { return false }
        if let fixedAnswer { return fixedAnswer }
        return isAnswering && settings.migrationNoteFlag == true
    }

    public func observe(_ handler: @escaping () -> Void) -> AccountsObservation {
        let id = UUID()
        observers[id] = handler
        return AccountsObservation { [weak self] in
            Task { @MainActor [weak self] in _ = self?.observers.removeValue(forKey: id) }
        }
    }

    /// The answer for the account `settings` belong to; nil drops it.
    public func store(_ value: Bool?, in settings: LocalSettings) {
        guard settings.migrationNoteFlag != value else { return }
        settings.migrationNoteFlag = value
        notify()
    }

    private func notify() {
        for observer in observers.values { observer() }
    }
}
