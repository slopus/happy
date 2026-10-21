import Foundation
import HappyStore

/// The two renderable states of the same account snapshot. Their row models
/// contain only rendered fields; a settings acknowledgement does not change
/// these values or invalidate their drawing plans.
public struct HomeArchiveModels: Equatable, Sendable {
    public var hidden: HomeListModel
    public var shown: HomeListModel

    public func model(hidden: Bool) -> HomeListModel { hidden ? self.hidden : shown }

    public static func make(snapshot: HomeSnapshot, expandedProjects: Set<String>, draftSessionIds: Set<String>, clock: SessionList.Clock, unknownMachine: String, offline: [MachineChoice]? = nil) -> HomeArchiveModels? {
        var snapshot = snapshot
        snapshot.settings.pending["hideInactiveSessions"] = .bool(false)
        let choices = MachineChoice.collect(snapshot.machines.machines)
        let offline = offline ?? (!choices.isEmpty && !choices.contains(where: \.online) ? choices : nil)
        let shown = HomeListModel(SessionList(snapshot, clock: clock, unknownMachine: unknownMachine), offline: offline, expandedProjects: expandedProjects, draftSessionIds: draftSessionIds)
        guard let toggle = shown.rows.firstIndex(where: { row in
            switch row { case .flat(.archiveToggle), .project(.archiveToggle): true; default: false }
        }) else { return nil }
        var hidden = shown
        hidden.ids = Array(shown.ids.prefix(toggle + 1))
        hidden.rows = Array(shown.rows.prefix(toggle + 1))
        hidden.rows[toggle] = shown.grouped ? .project(.archiveToggle(hidden: true)) : .flat(.archiveToggle(hidden: true))
        return HomeArchiveModels(hidden: hidden, shown: shown)
    }
}

/// Only the fields needed to distinguish a server acknowledgement from an
/// older equal-valued snapshot during an A → B → A sequence.
public struct HomeArchiveSettings: Equatable, Sendable {
    public var hidden: Bool
    public var pending: Bool
    public var version: Int

    public init(_ settings: SettingsSnapshot) {
        hidden = AccountSettings(settings).hideArchivedSessions
        pending = settings.pending["hideInactiveSessions"] != nil
        version = settings.synced?.version ?? 0
    }
}

/// Account-scoped, ordered local persistence. Taps submit without a task hop;
/// one worker coalesces requests while a SQLite write is in flight. It never
/// waits for the network. Closing an account drains its final accepted write.
public final class ArchiveVisibilityWriter: @unchecked Sendable {
    public struct Intent: Equatable, Sendable {
        public var generation: UInt64
        public var hidden: Bool
    }
    public struct Receipt: Equatable, Sendable {
        public var intent: Intent
        /// Fresh synced version read by the worker immediately before writing.
        /// nil means the local write failed, not that it was acknowledged.
        public var baseline: Int?
        public var drained: Bool

        public func acknowledges(_ latest: Intent, settings: HomeArchiveSettings) -> Bool {
            guard intent == latest, drained, let baseline else { return false }
            return settings.version > baseline && !settings.pending && settings.hidden == latest.hidden
        }
    }

    private let lock = NSLock()
    private let persist: @Sendable (Bool) async throws -> Int
    private var generation: UInt64 = 0
    private var pending: Intent?
    private var worker: Task<Void, Never>?
    private var accepting = true
    private var finished = false
    private var latestReceipt: Receipt?
    private var subscribers: [UUID: AsyncStream<Receipt>.Continuation] = [:]

    public init(persist: @escaping @Sendable (Bool) async throws -> Int) { self.persist = persist }

    @discardableResult
    public func submit(hidden: Bool) -> Intent? {
        lock.withLock {
            guard accepting else { return nil }
            generation += 1
            let intent = Intent(generation: generation, hidden: hidden)
            pending = intent
            if worker == nil { worker = Task.detached(priority: .userInitiated) { [self] in await drain() } }
            return intent
        }
    }

    public func receipts() -> AsyncStream<Receipt> {
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let (receipt, closed) = lock.withLock {
                if !finished { subscribers[id] = continuation }
                // Live consumers subscribe before submitting a tap. Replaying
                // an old receipt outside the lock could overwrite a newer
                // receipt in this bufferingNewest stream. Only a fully closed
                // writer has a stable final value safe to replay.
                return (finished ? latestReceipt : nil, finished)
            }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                _ = self.lock.withLock { self.subscribers.removeValue(forKey: id) }
            }
            if let receipt { continuation.yield(receipt) }
            if closed { continuation.finish() }
        }
    }

    public func flush() async {
        while let task = lock.withLock({ worker }) { await task.value }
    }

    public func close() async {
        lock.withLock { accepting = false }
        await flush()
        let continuations = lock.withLock {
            finished = true
            let values = Array(subscribers.values); subscribers = [:]; return values
        }
        for continuation in continuations { continuation.finish() }
    }

    private func drain() async {
        while let intent = lock.withLock({ () -> Intent? in
            guard let intent = pending else { worker = nil; return nil }
            pending = nil; return intent
        }) {
            let baseline = try? await persist(intent.hidden)
            let (receipt, continuations) = lock.withLock {
                let receipt = Receipt(intent: intent, baseline: baseline, drained: pending == nil)
                latestReceipt = receipt
                return (receipt, Array(subscribers.values))
            }
            for continuation in continuations { continuation.yield(receipt) }
        }
    }
}
