import Foundation
import GRDB

/// Shares the database producer and a cached, projected value. Projection
/// and equality run on this actor, never on a subscribing UI actor.
actor SnapshotHub<Value: Equatable & Sendable> {
    private let observation: SharedValueObservation<Value>
    private let project: @Sendable (Value) -> Value
    private var subscribers: [UUID: AsyncStream<Value>.Continuation] = [:]
    private var raw: Value?
    private var published: Value?
    private var task: Task<Void, Never>?

    init(observation: SharedValueObservation<Value>, project: @escaping @Sendable (Value) -> Value) {
        self.observation = observation
        self.project = project
    }

    deinit { task?.cancel() }

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
        task = Task { [weak self] in
            do {
                for try await value in observation.values() {
                    guard !Task.isCancelled else { break }
                    await self?.receive(value)
                }
            } catch {
                guard !Task.isCancelled else { return }
                // The public stream is nonthrowing; make a stopped producer
                // diagnosable, then allow a new subscription to restart it.
                print("HappyStore snapshot observation stopped: \(error)")
                await self?.finish()
            }
        }
    }

    private func receive(_ value: Value) {
        guard !Task.isCancelled else { return }
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
        subscribers.removeValue(forKey: id)
        if subscribers.isEmpty {
            task?.cancel()
            task = nil
            raw = nil
            published = nil
        }
    }

    private func finish() {
        let continuations = Array(subscribers.values)
        subscribers.removeAll()
        task = nil
        raw = nil
        published = nil
        for continuation in continuations { continuation.finish() }
    }
}