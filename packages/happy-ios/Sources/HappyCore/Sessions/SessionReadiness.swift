import Foundation

/// sync.ts ensureSessionReady's user-visible refusal, copied verbatim.
public enum SessionReadinessError: LocalizedError, Equatable, Sendable {
    case notReady

    public var errorDescription: String? {
        "The message was not sent: this session has not finished syncing. Please try again."
    }
}

/// The bounded wait around the shared, indefinitely retrying sessions sync.
enum SessionReadiness {
    static func ensure(
        isReady: @escaping @Sendable () async throws -> Bool,
        refresh: @escaping @Sendable () async -> Void,
        sleep: @escaping InvalidateSync.Sleep
    ) async throws {
        for attempt in 0..<3 {
            try Task.checkCancellation()
            if try await isReady() { return }
            if attempt > 0 { try await sleep(.milliseconds(300 * attempt)) }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await refresh() }
                group.addTask { try? await sleep(.seconds(4)) }
                _ = await group.next()
                group.cancelAll()
            }
        }
        try Task.checkCancellation()
        guard try await isReady() else { throw SessionReadinessError.notReady }
    }
}
