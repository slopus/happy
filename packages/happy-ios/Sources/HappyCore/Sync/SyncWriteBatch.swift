import Foundation
import HappyStore

struct NoSyncCheckpoint: Sendable { }

enum MessageBatchItem: Sendable {
    case record(MessageRecord)
    case cursor(sessionId: String, through: Int)
}

/// Owned by one pull operation. A deadline task flushes completed downloads
/// while its owner is awaiting the next HTTP response. No DB transaction
/// spans an await, and old deadlines cannot flush a newer buffer.
actor SyncWriteBatch<Item: Sendable, Checkpoint: Sendable> {
    private let maximumRecords: Int
    private let maximumBytes: Int
    private let maximumDelay: Duration
    private let sleep: InvalidateSync.Sleep
    private let cost: @Sendable (Item) -> (records: Int, bytes: Int)
    private let commit: @Sendable ([Item], Checkpoint?) throws -> Void
    private var pending: [Item] = []
    private var records = 0
    private var bytes = 0
    private var deadline: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var failure: (any Error)?
    private var closed = false

    init(maximumRecords: Int, maximumBytes: Int, maximumDelay: Duration,
         sleep: @escaping InvalidateSync.Sleep,
         cost: @escaping @Sendable (Item) -> (records: Int, bytes: Int),
         commit: @escaping @Sendable ([Item], Checkpoint?) throws -> Void) {
        self.maximumRecords = max(1, maximumRecords)
        self.maximumBytes = max(1, maximumBytes)
        self.maximumDelay = max(.milliseconds(1), maximumDelay)
        self.sleep = sleep
        self.cost = cost
        self.commit = commit
    }

    deinit { deadline?.cancel() }

    func append(_ items: [Item]) throws {
        if let failure { throw failure }
        guard !closed else { throw CancellationError() }
        for item in items {
            let size = cost(item)
            if !pending.isEmpty && (records + size.records > maximumRecords || bytes + size.bytes > maximumBytes) {
                try flush()
            }
            pending.append(item)
            records += size.records
            bytes += size.bytes
            if size.records > maximumRecords || size.bytes > maximumBytes {
                // An indivisible oversized row is written immediately; it
                // never waits in the pending buffer for another response.
                try flush()
            }
        }
        if records >= maximumRecords || bytes >= maximumBytes { try flush() }
        else if !pending.isEmpty && deadline == nil { scheduleDeadline() }
    }

    func finish(_ checkpoint: Checkpoint? = nil) throws {
        closed = true
        if let failure { throw failure }
        try flush(checkpoint)
    }

    private func scheduleDeadline() {
        let token = generation
        let delay = maximumDelay
        let sleep = self.sleep
        deadline = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            guard !Task.isCancelled else { return }
            await self?.flushFromDeadline(token)
        }
    }

    private func flushFromDeadline(_ token: UInt64) {
        guard !closed, generation == token, !Task.isCancelled else { return }
        do { try flush() }
        catch { print("HappyStore sync batch deadline failed: \(error)") }
    }

    private func flush(_ checkpoint: Checkpoint? = nil) throws {
        deadline?.cancel()
        deadline = nil
        generation &+= 1
        guard !pending.isEmpty || checkpoint != nil else { return }
        let items = pending
        pending.removeAll(keepingCapacity: true)
        records = 0
        bytes = 0
        do { try commit(items, checkpoint) }
        catch { failure = error; throw error }
    }
}