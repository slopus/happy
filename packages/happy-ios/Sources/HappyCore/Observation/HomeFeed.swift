import HappyStore

/// One per account. Fetching and de-duplication run on the store's background
/// observation queue; subscribers decide where to consume the resulting value.
public final class HomeFeed: Sendable {
    private let store: LocalStore

    public init(store: LocalStore) { self.store = store }

    /// The current disk snapshot first, then each distinct snapshot. The
    /// producer runs off main; callers must also derive UI models off main.
    public func snapshots() -> AsyncStream<HomeSnapshot> { store.homeSnapshots() }
}

public final class SettingsFeed: Sendable {
    private let store: LocalStore

    public init(store: LocalStore) { self.store = store }
    public func snapshots() -> AsyncStream<SettingsSnapshot> { store.settingsSnapshots() }
}

public final class MachinesFeed: Sendable {
    private let store: LocalStore

    public init(store: LocalStore) { self.store = store }
    public func snapshots() -> AsyncStream<MachinesSnapshot> { store.machineSnapshots() }
}