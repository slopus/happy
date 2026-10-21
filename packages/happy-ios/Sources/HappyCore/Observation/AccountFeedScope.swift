import Foundation

/// Cancels an account's subscribers when its session stops, even if a screen
/// still retains a feed. Starting a new AccountSession creates a new scope.
final class AccountFeedScope: @unchecked Sendable {
    private enum Entry { case pending; case running(@Sendable () -> Void) }
    private let lock = NSLock()
    private var stopped = false
    private var entries: [UUID: Entry] = [:]

    deinit { stop() }

    func snapshots<Value: Sendable>(_ makeStream: @escaping @Sendable () -> AsyncStream<Value>) -> AsyncStream<Value> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            guard let id = begin() else { continuation.finish(); return }
            let task = Task.detached { [weak self] in
                for await value in makeStream() {
                    guard !Task.isCancelled else { break }
                    continuation.yield(value)
                }
                continuation.finish()
                self?.cancel(id)
            }
            // The stream owns its scope even when built from a temporary
            // HomeFeed. Termination also cancels the forwarding iterator.
            continuation.onTermination = { [self] _ in task.cancel(); cancel(id) }
            attach(id) { task.cancel(); continuation.finish() }
        }
    }

    func stop() {
        let callbacks = lock.withLock {
            stopped = true
            let callbacks = entries.values.compactMap { entry -> (@Sendable () -> Void)? in
                if case .running(let callback) = entry { return callback }
                return nil
            }
            entries.removeAll()
            return callbacks
        }
        for callback in callbacks { callback() }
    }

    private func begin() -> UUID? {
        lock.withLock {
            guard !stopped else { return nil }
            let id = UUID()
            entries[id] = .pending
            return id
        }
    }

    private func attach(_ id: UUID, cancel: @escaping @Sendable () -> Void) {
        let cancelled = lock.withLock {
            guard entries[id] != nil else { return true }
            entries[id] = .running(cancel)
            return false
        }
        if cancelled { cancel() }
    }

    private func cancel(_ id: UUID) {
        let entry = lock.withLock { entries.removeValue(forKey: id) }
        if case .running(let callback) = entry { callback() }
    }
}