import Foundation

/// When the network was last used anyway. A periodic request that may go a
/// little early (a renewal, a refresh) waits for the next time traffic is
/// already moving, such as the computer's heartbeat on the event stream, so
/// it rides that burst instead of waking the radio on its own.
public final class RadioWake: @unchecked Sendable {
    public static let shared = RadioWake()

    private let lock = NSLock()
    private var last: ContinuousClock.Instant?
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    /// Bytes just came in or went out.
    public func noted() {
        let woken: [CheckedContinuation<Void, Never>] = lock.withLock {
            last = .now
            defer { waiters.removeAll() }
            return Array(waiters.values)
        }
        for waiter in woken { waiter.resume() }
    }

    /// Returns `earliest` from now if the network was used within the last
    /// second, else at the first use after that, and at `latest` at the most.
    /// Throws when cancelled.
    public func next(after earliest: Duration, by latest: Duration) async throws {
        try await Task.sleep(for: earliest)
        let since = ContinuousClock.now - .seconds(1)
        let remaining = latest - earliest
        guard remaining > .zero else { return }
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await Task.sleep(for: remaining) }
            group.addTask { [self] in await use(since: since) }
            _ = try await group.next()
            group.cancelAll()
        }
        try Task.checkCancellation()
    }

    /// Returns at once if the network was used after `since`, else at the
    /// next use. Looking and waiting are one step under the lock, so a use
    /// in between isn't missed.
    private func use(since: ContinuousClock.Instant) async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let now = lock.withLock { () -> Bool in
                    if Task.isCancelled || last.map({ $0 >= since }) == true { return true }
                    waiters[id] = continuation
                    return false
                }
                if now { continuation.resume() }
            }
        } onCancel: {
            let waiter = lock.withLock { waiters.removeValue(forKey: id) }
            waiter?.resume()
        }
    }
}
