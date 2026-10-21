import Foundation
import GRDB

/// Shares the database producer and a cached, projected value. Projection
/// and equality run on this actor, never on a subscribing UI actor.
actor SnapshotHub<Value: Equatable & Sendable> {
    private let observation: SharedValueObservation<Value>
    private let project: @Sendable (Value) -> Value
    private var subscribers: [UUID: AsyncStream<Value>.Continuation] = [:]
    private var raw: Value?
    private var published: Value? {
        didSet { newest.value = published }
    }
    /// `published`, read at once from any thread.
    private let newest = Newest()
    private var task: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var retiring: [UUID: Task<Void, Never>] = [:]

    init(observation: SharedValueObservation<Value>, project: @escaping @Sendable (Value) -> Value) {
        self.observation = observation
        self.project = project
    }

    deinit { task?.cancel() }

    /// The value subscribers were last handed, or nil while none listen:
    /// what a screen draws first, before its own subscription answers.
    nonisolated var latest: Value? { newest.value }

    nonisolated func snapshots() -> AsyncStream<Value> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let id = UUID()
            let registration = Task.detached { await self.subscribe(id, continuation) }
            continuation.onTermination = { _ in
                registration.cancel()
                Task { await self.remove(id) }
            }
        }
    }

    private func subscribe(_ id: UUID, _ continuation: AsyncStream<Value>.Continuation) {
        guard !Task.isCancelled else { continuation.finish(); return }
        subscribers[id] = continuation
        if let published { continuation.yield(published) }
        guard task == nil else { return }
        let observation = self.observation
        let token = generation
        task = Task { [weak self] in
            do {
                for try await value in observation.valuesWithAsyncCallbacks() {
                    guard !Task.isCancelled else { break }
                    await self?.receive(value, generation: token)
                }
            } catch {
                guard !Task.isCancelled else { return }
                // The public stream is nonthrowing; make a stopped producer
                // diagnosable, then allow a new subscription to restart it.
                print("HappyStore snapshot observation stopped: \(error)")
                await self?.finish(generation: token)
            }
        }
    }

    private func receive(_ value: Value, generation token: UInt64) {
        guard !Task.isCancelled, token == generation else { return }
        raw = value
        refresh()
    }

    func refresh() {
        guard let raw else { return }
        let next = project(raw)
        guard next != published else { return }
        published = next
        for subscriber in subscribers.values { subscriber.yield(next) }
    }

    private func remove(_ id: UUID) {
        guard subscribers.removeValue(forKey: id) != nil else { return }
        if subscribers.isEmpty {
            generation &+= 1
            if let task { retire(task) }
            task = nil
            raw = nil
            published = nil
        }
    }

    private func finish(generation token: UInt64) {
        guard token == generation else { return }
        generation &+= 1
        let continuations = Array(subscribers.values)
        subscribers.removeAll()
        if let task { retire(task) }
        task = nil
        raw = nil
        published = nil
        for continuation in continuations { continuation.finish() }
    }

    /// Account stop waits for cancellation to reach the underlying shared
    /// GRDB producer. A new account scope then reads disk rather than a
    /// cached value whose final database callback is still queued.
    func stop() async {
        let oldTasks = Array(retiring.values) + (task.map { [$0] } ?? [])
        retiring.removeAll()
        generation &+= 1
        task = nil
        raw = nil
        published = nil
        let continuations = Array(subscribers.values)
        subscribers.removeAll()
        for continuation in continuations { continuation.finish() }
        for task in oldTasks { task.cancel() }
        for task in oldTasks { await task.value }
    }

    private func retire(_ task: Task<Void, Never>) {
        let id = UUID()
        retiring[id] = task
        task.cancel()
        Task { [weak self] in
            await task.value
            await self?.forgetRetired(id)
        }
    }

    private func forgetRetired(_ id: UUID) { retiring.removeValue(forKey: id) }

    private final class Newest: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Value?
        var value: Value? {
            get { lock.withLock { stored } }
            set { lock.withLock { stored = newValue } }
        }
    }
}