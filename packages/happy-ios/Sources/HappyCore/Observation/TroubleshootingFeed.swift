import Foundation
import HappyStore

public struct TroubleshootComputer: Equatable, Sendable {
    public var id: String
    public var name: String
    public var online: Bool

    public init(id: String, name: String, online: Bool) { self.id = id; self.name = name; self.online = online }
}

public struct TroubleshootState: Equatable, Sendable {
    public var computers: [TroubleshootComputer]
    public var aiPrompt: String

    public init(computers: [TroubleshootComputer], aiPrompt: String) { self.computers = computers; self.aiPrompt = aiPrompt }
}

/// One account-owned projection and SQL producer, independent of Home rows.
public final class TroubleshootingFeed: Sendable {
    private let scope = AccountFeedScope()
    private let hub: TroubleshootingStateHub

    public init(store: LocalStore) { hub = TroubleshootingStateHub(store: store) }
    public func snapshots() -> AsyncStream<TroubleshootState> { scope.snapshots { [hub] in hub.snapshots() } }
    func stop() async { scope.stop(); await hub.stop() }
    var computerDerivationCount: Int { get async { await hub.computerDerivationCount } }
}

private actor TroubleshootingStateHub {
    private let store: LocalStore
    private var subscribers: [UUID: AsyncStream<TroubleshootState>.Continuation] = [:]
    private var machines: [MachineRecord]?
    private var choices: [MachineChoice] = []
    private var published: TroubleshootState?
    private var task: Task<Void, Never>?
    private var retiring: [UUID: Task<Void, Never>] = [:]
    private var generation: UInt64 = 0
    private(set) var computerDerivationCount = 0

    init(store: LocalStore) { self.store = store }
    deinit { task?.cancel() }

    nonisolated func snapshots() -> AsyncStream<TroubleshootState> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let id = UUID()
            let registration = Task.detached { await self.subscribe(id, continuation) }
            continuation.onTermination = { _ in
                registration.cancel()
                Task { await self.remove(id) }
            }
        }
    }

    private func subscribe(_ id: UUID, _ continuation: AsyncStream<TroubleshootState>.Continuation) {
        guard !Task.isCancelled else { continuation.finish(); return }
        subscribers[id] = continuation
        if let published { continuation.yield(published) }
        guard task == nil else { return }
        let store = self.store
        let token = generation
        task = Task { [weak self] in
            for await value in store.troubleshootingSnapshots() {
                guard !Task.isCancelled else { break }
                await self?.receive(value, generation: token)
            }
            await self?.finish(generation: token)
        }
    }

    private func receive(_ value: TroubleshootingSnapshot, generation token: UInt64) {
        guard !Task.isCancelled, token == generation else { return }
        ThreadRules.assertOffMain()
        if machines != value.machines {
            machines = value.machines
            choices = MachineChoice.collect(value.machines)
            computerDerivationCount += 1
        }
        let next = TroubleshootState(computers: choices.map { .init(id: $0.id, name: $0.name, online: $0.online) },
                                     aiPrompt: OfflineTroubleshooting(choices: choices, recentSession: value.recentSession).aiPrompt)
        guard published != next else { return }
        published = next
        for subscriber in subscribers.values { subscriber.yield(next) }
    }

    private func remove(_ id: UUID) {
        guard subscribers.removeValue(forKey: id) != nil, subscribers.isEmpty else { return }
        reset()
    }

    private func finish(generation token: UInt64) {
        guard token == generation else { return }
        let continuations = Array(subscribers.values)
        subscribers.removeAll()
        reset()
        for continuation in continuations { continuation.finish() }
    }

    private func reset() {
        generation &+= 1
        if let task {
            let id = UUID()
            retiring[id] = task
            task.cancel()
            Task { [weak self] in
                await task.value
                await self?.forgetRetired(id)
            }
        }
        task = nil
        machines = nil
        choices = []
        published = nil
    }

    func stop() async {
        finish(generation: generation)
        let tasks = Array(retiring.values)
        retiring.removeAll()
        for task in tasks { task.cancel() }
        for task in tasks { await task.value }
    }

    private func forgetRetired(_ id: UUID) { retiring.removeValue(forKey: id) }
}