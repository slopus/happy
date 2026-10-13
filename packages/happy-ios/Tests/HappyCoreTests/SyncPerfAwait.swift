import Foundation

enum SyncPerfAwaitError: Error { case timedOut }

/// Bound stream waits so a lost observation is a failure instead of a hung CI.
func syncPerfNext<Value: Sendable>(_ stream: AsyncStream<Value>) async throws -> Value? {
    try await withThrowingTaskGroup(of: Value?.self) { group in
        group.addTask {
            var iterator = stream.makeAsyncIterator()
            return await iterator.next()
        }
        group.addTask {
            try await Task.sleep(for: .seconds(5))
            throw SyncPerfAwaitError.timedOut
        }
        defer { group.cancelAll() }
        return try await group.next() ?? nil
    }
}

func syncPerfWait(_ gate: Gate) async throws {
    let expired = PageCounter()
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask { await gate.wait() }
        group.addTask {
            try await Task.sleep(for: .seconds(5))
            expired.count = 1
            await gate.open() // Release the non-cancellable fake wait on timeout.
            throw SyncPerfAwaitError.timedOut
        }
        defer { group.cancelAll() }
        _ = try await group.next()
        if expired.count != 0 { throw SyncPerfAwaitError.timedOut }
    }
}