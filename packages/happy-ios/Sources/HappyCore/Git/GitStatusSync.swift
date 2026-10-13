import Foundation
import HappyStore

/// One instance per account. Shares refreshes between sessions in the same checkout.
public actor GitStatusSync {
    let actions: SessionActions
    let store: LocalStore
    public init(actions: SessionActions, store: LocalStore) { self.actions = actions; self.store = store }
    /// Ports gitStatusSync.getSync: immediate snapshot followed by refresh results.
    public func observe(sessionId: String) -> AsyncStream<GitStatus?> { AsyncStream { $0.yield(nil); $0.finish() } }
    /// Ports gitStatusSync.getSync/session refresh and gitStatusFiles.getGitStatusFiles.
    @discardableResult public func refresh(sessionId: String) async -> GitStatus? { nil }
    /// Ports gitStatusSync.invalidate (300ms debounce).
    public func invalidate(sessionId: String) {}
    /// Ports gitStatusSync.stop.
    public func stop(sessionId: String) {}
    /// Ports gitStatusSync.clearForSession.
    public func clearForSession(sessionId: String) {}
    /// Stops all account refreshes on account switch.
    public func stop() {}
}