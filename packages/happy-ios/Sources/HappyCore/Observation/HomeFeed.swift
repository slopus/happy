import HappyStore

/// One per account. Fetching and de-duplication run on the store's background
/// observation queue; subscribers decide where to consume the resulting value.
public final class HomeFeed: Sendable {
    private let store: LocalStore
    private let scope = AccountFeedScope()

    public init(store: LocalStore) { self.store = store }

    /// The current disk snapshot first, then each distinct snapshot. The
    /// producer runs off main; callers must also derive UI models off main.
    public func snapshots() -> AsyncStream<HomeSnapshot> { scope.snapshots { [store] in store.homeSnapshots() } }
    /// The snapshot the account's subscribers were last handed, at once and
    /// without a read; nil while none listen. A screen draws its first
    /// frame from it, and its own subscription then confirms it.
    public var latest: HomeSnapshot? { store.latestHomeSnapshot }
    /// Nonempty drafts, independently observed from home's session rows.
    public func draftSessions() -> AsyncStream<Set<String>> { scope.snapshots { [store] in store.draftSessionIdsSnapshots() } }
    func stop() { scope.stop() }
}

public final class SettingsFeed: Sendable {
    private let store: LocalStore
    private let scope = AccountFeedScope()

    public init(store: LocalStore) { self.store = store }
    public func snapshots() -> AsyncStream<SettingsSnapshot> { scope.snapshots { [store] in store.settingsSnapshots() } }
    func stop() { scope.stop() }
}

public final class MachinesFeed: Sendable {
    private let store: LocalStore
    private let scope = AccountFeedScope()

    public init(store: LocalStore) { self.store = store }
    public func snapshots() -> AsyncStream<MachinesSnapshot> { scope.snapshots { [store] in store.machineSnapshots() } }
    func stop() { scope.stop() }
}