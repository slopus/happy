import Foundation

/// The agent connection chosen last, kept on this phone and opened at
/// launch, in every build. `isAvailable` still keeps production off the
/// few relay screens that hand over to agent settings.
public struct Preference: Sendable {
    /// The filter's old V2 choice, read once to carry it over.
    public static let enabledKey = "home.filter"
    public static let agentConnectionKey = "agent-connection-active"

    public let variant: AppVariant
    /// UserDefaults is safe from any thread.
    private nonisolated(unsafe) let storage: UserDefaults

    public init(variant: AppVariant, storage: UserDefaults = .standard) {
        self.variant = variant
        self.storage = storage
    }

    /// A computer can be home at all.
    public var isAvailable: Bool { variant != .production }

    /// The Happy account's filter showed V2, before a computer was
    /// a home of its own: true once, so that launch opens the computer.
    /// Never true in production.
    public func takeFilterChoice() -> Bool {
        guard isAvailable, storage.object(forKey: Self.enabledKey) != nil else { return false }
        defer { storage.removeObject(forKey: Self.enabledKey) }
        return storage.bool(forKey: Self.enabledKey)
    }

    /// The agent connection shown when a Happy account is the active one:
    /// the last one chosen.
    public var agentConnectionID: String? {
        get { storage.string(forKey: Self.agentConnectionKey) }
        nonmutating set { storage.set(newValue, forKey: Self.agentConnectionKey) }
    }
}
