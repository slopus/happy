import HappyStore

/// One per account: a session's own screens follow its record, computer,
/// settings and composer here. Fetching and comparing run off the main
/// thread; every stream ends when the account stops.
public final class SessionDetailFeed: Sendable {
    private let store: LocalStore
    private let scope = AccountFeedScope()

    public init(store: LocalStore) { self.store = store }

    /// The current snapshot first, then each distinct one.
    public func snapshots(
        sessionId: String,
        onError: @escaping @Sendable (SessionDetailFailure) -> Void = { _ in }
    ) -> AsyncStream<SessionDetailSnapshot> {
        scope.snapshots { [store] in store.sessionDetailSnapshots(sessionId: sessionId, onError: onError) }
    }

    /// The snapshot now, read off the main thread.
    public func current(sessionId: String) async -> SessionDetailSnapshot? {
        let store = self.store
        return await Task.detached(priority: .userInitiated) { try? store.sessionDetail(sessionId: sessionId) }.value
    }

    func stop() { scope.stop() }
}
