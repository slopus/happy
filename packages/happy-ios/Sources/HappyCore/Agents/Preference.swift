import Foundation

/// Whether a paired computer is a home of its own, V2, beside the
/// Happy account's session list: the profile chosen decides which shows.
/// Only in development and preview builds: a production build cannot reach
/// it, whatever is stored.
public struct Preference: Sendable {
    /// The filter's old V2 choice, read once to carry it over.
    public static let enabledKey = "home.filter"
    public static let agentConnectionKey = "agent-connection-active"
    public static let agentConnectionsKey = "agent-connection-enabled"

    public let variant: AppVariant
    /// UserDefaults is safe from any thread.
    private nonisolated(unsafe) let storage: UserDefaults

    public init(variant: AppVariant, storage: UserDefaults = .standard) {
        self.variant = variant
        self.storage = storage
    }

    /// A computer can be home at all.
    public var isAvailable: Bool { variant != .production }

    /// The Direct connection experiment: computers paired straight to this
    /// phone, each a home of its own. Off until the person turns it on in
    /// Settings, on this phone alone; never on in production.
    public var agentConnectionsEnabled: Bool {
        get { isAvailable && storage.bool(forKey: Self.agentConnectionsKey) }
        nonmutating set {
            guard isAvailable else { return }
            storage.set(newValue, forKey: Self.agentConnectionsKey)
        }
    }

    /// Paired computers are offered: production keeps its computer page;
    /// elsewhere, while the experiment is on.
    public var showsAgentConnections: Bool { !isAvailable || agentConnectionsEnabled }

    /// The Happy account's filter showed V2, before a computer was
    /// a home of its own: true once, so that launch opens the computer.
    /// Never true in production.
    public func takeFilterChoice() -> Bool {
        guard isAvailable, storage.object(forKey: Self.enabledKey) != nil else { return false }
        defer { storage.removeObject(forKey: Self.enabledKey) }
        return storage.bool(forKey: Self.enabledKey)
    }

    /// The paired computer V2 shows when a Happy account is the
    /// active one: the last one chosen.
    public var agentConnectionID: String? {
        get { isAvailable ? storage.string(forKey: Self.agentConnectionKey) : nil }
        nonmutating set {
            guard isAvailable else { return }
            storage.set(newValue, forKey: Self.agentConnectionKey)
        }
    }
}
