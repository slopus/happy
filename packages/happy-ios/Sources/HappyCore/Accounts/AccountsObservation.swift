import Foundation

/// Keeps one account-list subscription alive. Cancel or release the token
/// to stop delivery; it never takes over the coordinator's state callback.
public final class AccountsObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private let cancellation: @Sendable () -> Void

    init(cancellation: @escaping @Sendable () -> Void) {
        self.cancellation = cancellation
    }

    var isCancelled: Bool { lock.withLock { cancelled } }

    public func cancel() {
        let shouldCancel = lock.withLock {
            guard !cancelled else { return false }
            cancelled = true
            return true
        }
        if shouldCancel { cancellation() }
    }

    deinit { cancel() }
}

@MainActor
final class AccountsObserver {
    weak var observation: AccountsObservation?
    let handler: ([AccountSummary]) -> Void

    init(observation: AccountsObservation, handler: @escaping ([AccountSummary]) -> Void) {
        self.observation = observation
        self.handler = handler
    }
}
