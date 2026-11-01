import Foundation
import HappyWire

/// One thing a person did that the server or computer has yet to hear: a
/// chat read, a task archived, a name given. Applied on this phone at
/// once, kept in the account's database until it is answered
/// (docs/offline-first.md).
public struct Intent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case read
        case archive
        case unarchive
        case leave
        case delete
        case rename
        case answer
        /// A todo list's changes (`TodoOp`): one slot per todo for each.
        case todoCreate = "todo.create"
        case todoText = "todo.text"
        case todoStatus = "todo.status"
        case todoMove = "todo.move"

        /// A todo list's, sent by `TodoLibrary`.
        public var isTodo: Bool { [.todoCreate, .todoText, .todoStatus, .todoMove].contains(self) }

        /// The kinds that set one thing share it: a later one replaces an
        /// earlier one still waiting.
        var slot: String {
            switch self {
            case .unarchive: Kind.archive.rawValue
            default: rawValue
            }
        }
    }

    /// Sent as the route's mutation ID where it takes one; what an
    /// acknowledgement names.
    public var id: String
    public var kind: Kind
    /// The chat, task or session it is about.
    public var target: String
    /// What it carries: a name, answers, which list it leaves.
    public var value: JSONValue
    /// When it was asked for (ms); the order it is sent in.
    public var createdAt: Int64
    public var attempts: Int
    /// Not sent again before this (ms).
    public var nextAttemptAt: Int64

    public init(id: String = ClientID.make(), kind: Kind, target: String, value: JSONValue = .null, createdAt: Int64, attempts: Int = 0, nextAttemptAt: Int64 = 0) {
        self.id = id
        self.kind = kind
        self.target = target
        self.value = value
        self.createdAt = createdAt
        self.attempts = attempts
        self.nextAttemptAt = nextAttemptAt
    }

    /// One row per slot.
    public var slot: String { "\(kind.slot)|\(target)" }
}

/// What a delivery throws when the other side said no for good: the intent
/// is dropped and its overlay goes, so the server's state shows again.
public struct IntentRefusal: Error, Equatable, Sendable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
}

/// Where an account keeps its intents: the same database as the state they
/// change, so the two commit together.
public protocol IntentStorage: Sendable {
    /// Every intent kept, in no particular order.
    func intents() async throws -> [Intent]
    /// Writes `intent`, replacing whatever its slot held.
    func saveIntent(_ intent: Intent) async throws
    /// Writes a delivery attempt back, only if `intent.id` still holds its slot.
    func updateIntent(_ intent: Intent) async throws
    /// Removes the intent with this ID, and nothing newer in its slot.
    func removeIntent(id: String) async throws
}

/// The account's actions on their way: one implementation of the rules
/// in docs/offline-first.md for both account kinds. Kept in `storage`,
/// published to whoever lays them over what they show, and delivered
/// oldest first through `deliver` while the owner says the account is
/// reachable. A transient failure waits 1, 2, 4 … 30 s and lets the
/// rest go meanwhile; an `IntentRefusal` drops the intent.
public actor IntentOutbox {
    public typealias Deliver = @Sendable (Intent) async throws -> Void

    public struct Rejection: Equatable, Sendable {
        public let intent: Intent
        public let reason: String
        /// Whether someone waiting on it (`verdict`) was told: a screen
        /// that said it already need not again.
        public let heard: Bool
    }

    /// What became of an intent.
    public enum Verdict: Equatable, Sendable {
        case taken
        case refused(String)
        /// Still on its way when the wait ran out: it stands, and goes later.
        case waiting
    }

    private let storage: IntentStorage
    private let now: @Sendable () -> Int64
    private let sleep: InvalidateSync.Sleep
    private var kept: [Intent]?
    private var deliver: Deliver?
    private var online = false
    private var runner: Task<Void, Never>?
    private var waking: Task<Void, Never>?
    private var again = false
    private var listeners: [UUID: AsyncStream<[Intent]>.Continuation] = [:]
    private var rejectionListeners: [UUID: AsyncStream<Rejection>.Continuation] = [:]
    private var waiters: [String: [(token: UUID, continuation: CheckedContinuation<Verdict, Never>)]] = [:]
    /// On their way now, so no other send starts them again.
    private var inFlight: Set<String> = []
    /// Delivered, for tests.
    public private(set) var delivered: [Intent] = []

    public init(storage: IntentStorage, deliver: Deliver? = nil, now: @escaping @Sendable () -> Int64 = IntentOutbox.clock, sleep: @escaping InvalidateSync.Sleep = InvalidateSync.taskSleep) {
        self.storage = storage
        self.deliver = deliver
        self.now = now
        self.sleep = sleep
    }

    /// Milliseconds since 1970.
    public static let clock: @Sendable () -> Int64 = { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

    // MARK: Reading

    /// What is waiting, oldest first.
    public func pending() async -> [Intent] {
        if let kept { return kept }
        let read = ((try? await storage.intents()) ?? []).sorted(by: Self.order)
        if kept == nil { kept = read }
        return kept ?? read
    }

    private static func order(_ a: Intent, _ b: Intent) -> Bool {
        a.createdAt != b.createdAt ? a.createdAt < b.createdAt : a.id < b.id
    }

    /// The pending list now and after every change.
    public func changes() async -> AsyncStream<[Intent]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: [Intent].self, bufferingPolicy: .bufferingNewest(1))
        listeners[id] = continuation
        continuation.yield(await pending())
        continuation.onTermination = { [weak self] _ in Task { await self?.removeListener(id) } }
        return stream
    }

    /// Each refusal, as it comes, for a notice.
    public func rejections() -> AsyncStream<Rejection> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: Rejection.self)
        rejectionListeners[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeRejectionListener(id) } }
        return stream
    }

    private func removeListener(_ id: UUID) { listeners[id] = nil }
    private func removeRejectionListener(_ id: UUID) { rejectionListeners[id] = nil }

    private func publish() {
        guard let kept else { return }
        for listener in listeners.values { listener.yield(kept) }
    }

    // MARK: Asking

    /// Keeps an action and publishes it, replacing what its slot held;
    /// then sends it when it can. Throws only when it could not be kept,
    /// and then nothing is shown.
    @discardableResult
    public func enqueue(_ kind: Intent.Kind, target: String, value: JSONValue = .null) async throws -> Intent {
        let before = await pending()
        let intent = Intent(kind: kind, target: target, value: value, createdAt: max(now(), (before.last?.createdAt ?? 0) + 1))
        try await storage.saveIntent(intent)
        // Read again: another enqueue may have landed while this one was
        // being kept, and writing back the list from before would lose it.
        var list = await pending()
        if let replaced = list.first(where: { $0.slot == intent.slot }) { finish(replaced.id, .taken) }
        list.removeAll { $0.slot == intent.slot }
        list.append(intent)
        kept = list
        publish()
        kick()
        return intent
    }

    /// Whether `id` was taken (true) or refused (false); at once for one
    /// no longer waiting, or replaced by a later one (true).
    public func outcome(_ id: String) async -> Bool {
        if case .refused = await verdict(id) { return false }
        return true
    }

    /// What became of `id`: taken (or replaced by a later one), refused
    /// and why, or, after `limit`, still waiting.
    public func verdict(_ id: String, within limit: Duration? = nil) async -> Verdict {
        guard await pending().contains(where: { $0.id == id }) else { return .taken }
        let token = UUID()
        let sleep = sleep
        return await withCheckedContinuation { continuation in
            waiters[id, default: []].append((token, continuation))
            if let limit {
                Task {
                    try? await sleep(limit)
                    self.expire(id, token)
                }
            }
        }
    }

    private func expire(_ id: String, _ token: UUID) {
        guard let index = waiters[id]?.firstIndex(where: { $0.token == token }) else { return }
        waiters[id]?.remove(at: index).continuation.resume(returning: .waiting)
        if waiters[id]?.isEmpty == true { waiters[id] = nil }
    }

    /// Tells whoever waits on `id`; whether anyone did.
    @discardableResult
    private func finish(_ id: String, _ verdict: Verdict) -> Bool {
        let waiting = waiters.removeValue(forKey: id) ?? []
        for waiter in waiting { waiter.continuation.resume(returning: verdict) }
        return !waiting.isEmpty
    }

    // MARK: Delivery

    /// How intents go out; set once by the account.
    public func setDeliver(_ deliver: @escaping Deliver) {
        self.deliver = deliver
        kick()
    }

    /// Whether the account is reachable now. Off stops at once; what was
    /// on its way is sent again under the same ID.
    public func setOnline(_ online: Bool) {
        guard online != self.online else { return }
        self.online = online
        if online {
            kick()
        } else {
            runner?.cancel()
            runner = nil
            waking?.cancel()
            waking = nil
        }
    }

    /// Sends what is due now, at once: a reconnect, a new intent.
    public func kick() {
        again = true
        guard online, deliver != nil, runner == nil else { return }
        waking?.cancel()
        waking = nil
        runner = Task { await self.run() }
    }

    private func run() async {
        defer { runner = nil }
        while online, !Task.isCancelled, let deliver {
            again = false
            let list = await pending()
            let time = now()
            guard let next = list.first(where: { $0.nextAttemptAt <= time && !inFlight.contains($0.id) }) else {
                if again { continue }
                // Back when the first one waiting is due.
                if let due = list.map(\.nextAttemptAt).min() {
                    let sleep = sleep
                    waking = Task {
                        try? await sleep(.milliseconds(max(1, due - time)))
                        guard !Task.isCancelled else { return }
                        await self.wake()
                    }
                }
                return
            }
            await send(next, deliver)
        }
    }

    /// One try of `intent`: gone when taken or refused, else due again
    /// later. `told`: the caller hears the verdict itself.
    @discardableResult
    private func send(_ intent: Intent, _ deliver: Deliver, told: Bool = false) async -> Verdict {
        inFlight.insert(intent.id)
        defer { inFlight.remove(intent.id) }
        do {
            try await deliver(intent)
            try? await storage.removeIntent(id: intent.id)
            delivered.append(intent)
            drop(intent.id)
            finish(intent.id, .taken)
            return .taken
        } catch let refusal as IntentRefusal {
            try? await storage.removeIntent(id: intent.id)
            drop(intent.id)
            let heard = finish(intent.id, .refused(refusal.reason)) || told
            for listener in rejectionListeners.values { listener.yield(Rejection(intent: intent, reason: refusal.reason, heard: heard)) }
            return .refused(refusal.reason)
        } catch {
            var retry = intent
            retry.attempts += 1
            retry.nextAttemptAt = now() + Self.backoff(retry.attempts)
            try? await storage.updateIntent(retry)
            if let index = kept?.firstIndex(where: { $0.id == intent.id }) { kept?[index] = retry }
            return .waiting
        }
    }

    /// Tries `id` once now, whether or not the account is said to be
    /// reachable: a person waits on it (an answer to a question, an
    /// archive). Kept as it was if it doesn't go. `deliver` stands in for
    /// the account's own when it has none yet.
    @discardableResult
    public func attempt(_ id: String, through deliver: Deliver? = nil) async -> Verdict {
        guard let intent = await pending().first(where: { $0.id == id }) else { return .taken }
        guard let deliver = deliver ?? self.deliver else { return .waiting }
        // Already on its way: its answer, or the wait.
        if inFlight.contains(id) { return await verdict(id, within: .seconds(60)) }
        return await send(intent, deliver, told: true)
    }

    private func wake() {
        waking = nil
        kick()
    }

    private func drop(_ id: String) {
        guard let index = kept?.firstIndex(where: { $0.id == id }) else { return }
        kept?.remove(at: index)
        publish()
    }

    /// 1, 2, 4 … 30 seconds after the `attempts`th failure, in ms.
    public static func backoff(_ attempts: Int) -> Int64 {
        Int64(min(30, 1 << min(max(attempts - 1, 0), 5))) * 1000
    }

    /// Stops delivery and lets go of every listener: the account is going.
    public func close() {
        setOnline(false)
        for listener in listeners.values { listener.finish() }
        listeners = [:]
        for listener in rejectionListeners.values { listener.finish() }
        rejectionListeners = [:]
        for id in Array(waiters.keys) { finish(id, .waiting) }
    }
}

/// Intents kept in memory only: tests, and accounts with no folder.
public actor MemoryIntentStorage: IntentStorage {
    private var rows: [String: Intent] = [:]

    public init() {}

    public func intents() -> [Intent] { Array(rows.values) }
    public func saveIntent(_ intent: Intent) { rows[intent.slot] = intent }
    public func updateIntent(_ intent: Intent) {
        guard rows[intent.slot]?.id == intent.id else { return }
        rows[intent.slot] = intent
    }
    public func removeIntent(id: String) {
        guard let slot = rows.first(where: { $0.value.id == id })?.key else { return }
        rows[slot] = nil
    }
}

/// How each account lays its pending intents over what it shows.
public struct IntentOverlay: Equatable, Sendable {
    /// Chats read here that the other side may still call unread.
    public var read: Set<String> = []
    /// Things leaving the list (archived, left, deleted), by target.
    public var removed: Set<String> = []
    /// Things brought back from the archive.
    public var restored: Set<String> = []
    /// Names given here, by target.
    public var titles: [String: String] = [:]
    /// Answers given here, by question ID.
    public var answers: [String: JSONValue] = [:]

    public init() {}

    public init(_ intents: [Intent]) {
        for intent in intents {
            switch intent.kind {
            case .read: read.insert(intent.target)
            case .archive, .leave, .delete: removed.insert(intent.target)
            case .unarchive: restored.insert(intent.target)
            case .rename: if let title = intent.value["title"]?.stringValue ?? intent.value.stringValue { titles[intent.target] = title }
            case .answer: answers[intent.target] = intent.value
            case .todoCreate, .todoText, .todoStatus, .todoMove: break
            }
        }
    }

    public var isEmpty: Bool { self == IntentOverlay() }

    /// An agent account's home rows as this phone's pending actions leave
    /// them: a chat read here has no dot, a task archived or left is gone
    /// with what nests under it, a task or bot renamed wears its new name.
    public func apply(_ rows: [Row]) -> [Row] {
        guard !isEmpty else { return rows }
        var result: [Row] = []
        result.reserveCapacity(rows.count)
        var skippingBelow: Int?
        for var row in rows {
            if let depth = skippingBelow {
                if row.depth > depth && row.kind != .separator { continue }
                skippingBelow = nil
            }
            if row.targetId.map(removed.contains) == true || (row.kind == .session && row.agentId.map(removed.contains) == true) {
                skippingBelow = row.depth
                continue
            }
            if let agentId = row.agentId, read.contains(agentId) {
                row.unread = false
                row.isNew = false
            }
            if let targetId = row.targetId, let title = titles[targetId] {
                row.label = title
                row.titled = true
            }
            result.append(row)
        }
        return result
    }
}
