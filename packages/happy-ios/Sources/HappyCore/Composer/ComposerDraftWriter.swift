import Foundation
import GRDB
import HappyStore
import HappyWire

/// What the chat's composer reads from the store about its session.
public struct ComposerStoreValue: Equatable, Sendable {
    /// The unsent text; "" without a draft.
    public var draft: String
    /// The session's own picks (its composer state).
    public var picks: ComposerPicks
    /// Attachments whose upload the outbox gave up on.
    public var failedAttachments: Int

    public init(draft: String = "", picks: ComposerPicks = ComposerPicks(), failedAttachments: Int = 0) {
        self.draft = draft
        self.picks = picks
        self.failedAttachments = failedAttachments
    }

    /// Three lookups by session id. No session column is read, so presence
    /// and every other session write leave it alone.
    public static func fetch(_ db: Database, sessionId: String) throws -> ComposerStoreValue {
        let failed = OutboxRecord.filter(
            Column("sessionId") == sessionId
                && Column("kind") == OutboxRecord.Kind.file.rawValue
                && Column("state") == OutboxRecord.State.failed.rawValue
        )
        return ComposerStoreValue(
            draft: try DraftRecord.fetchOne(db, key: sessionId)?.text ?? "",
            picks: ComposerPicks(values: try ComposerStateRecord.fetchOne(db, key: sessionId)?.values),
            failedAttachments: try failed.fetchCount(db)
        )
    }
}

/// A read handed to the main thread.
public struct ComposerStoreDelivery: Equatable, Sendable {
    public var value: ComposerStoreValue
    /// The newest draft write (`ComposerDraftWriter.save`) the store held at
    /// the read. A failed write doesn't count. A read older than the composer's newest write says nothing about the
    /// draft: it may show text the composer has since replaced.
    public var generation: Int

    public init(value: ComposerStoreValue, generation: Int) {
        self.value = value
        self.generation = generation
    }
}

/// Where a composer's writer reads and writes: `OutboxSender` in the app.
/// Every call comes from the writer's background drain.
public protocol ComposerStorage: Sendable {
    func composerValue(sessionId: String) throws -> ComposerStoreValue
    func saveDraft(sessionId: String, text: String) throws
    /// The current value, then one after each commit to what it reads,
    /// produced off the main thread. It ends by throwing if the database
    /// observation fails.
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error>
}

/// One session's composer persistence, in order and off the main thread.
///
/// The composer hands over draft writes, sends and read requests on the
/// main thread; a single drain runs them in that order on a background task:
///   - consecutive writes collapse into the newest text;
///   - a send waits for the writes before it and holds back the writes
///     after it, so a Happy Agent send reads the stamp of the text it sends,
///     and typing during a send is written after the send's clear;
///   - reads move to the end of their run and are tagged with the newest
///     write the store holds (`ComposerStoreDelivery.generation`);
///   - the store observation only wakes the drain. A value the composer
///     already holds (its own write coming back) is dropped without a read;
///     anything else is read again in order and delivered only if it
///     differs from what the composer holds.
///
/// A write that fails stays unsaved: the generation doesn't move, so no
/// read can pass for a remote edit over the text it carries. It is tried
/// again on a timer (`retryDelays`, then no more until the next save), before
/// a send, at `settle()`, and replaced by any newer write. A send waits for
/// it: if it still fails, the send is refused with `UnsavedDraftError` and
/// nothing reaches the outbox, so a retry landing after an accepted send
/// can never bring the sent text back, and the send's clear always follows
/// the write it clears. Failed writes, reads and observations go to
/// `onFailure`. A failed observation is
/// started again while the writer is open, after `retryDelays` (the last
/// one repeating); its first value catches up on anything missed.
///
/// `close()` stops reads and deliveries. Writes and sends handed over
/// before or after it still run, so a teardown flush lands.
public final class ComposerDraftWriter: @unchecked Sendable {
    public typealias Deliver = @MainActor @Sendable (ComposerStoreDelivery) -> Void

    /// What failed, for the log.
    public struct Failure: Sendable {
        public enum Operation: Equatable, Sendable {
            case save
            case read
            case observation
        }

        public var operation: Operation
        public var error: any Error
    }

    /// A send refused because the draft before it couldn't be written.
    public struct UnsavedDraftError: Error {
        public var underlying: any Error
    }

    /// 250ms, 1s, 4s.
    public static let defaultRetryDelays: [Duration] = [.milliseconds(250), .seconds(1), .seconds(4)]

    private enum Command {
        case save(String, generation: Int)
        case read(forced: Bool, observed: ComposerStoreValue?)
        case send(OutgoingMessage, AsyncThrowingStream<String, any Error>.Continuation)
        case barrier(CheckedContinuation<Bool, Never>)
        case retry
    }

    public let sessionId: String
    private let storage: any ComposerStorage
    private let sending: any ChatSending
    private let retryDelays: [Duration]
    private let onFailure: @Sendable (Failure) -> Void

    private let lock = NSLock()
    // Guarded by `lock`.
    private var queue: [Command] = []
    private var draining = false
    private var closed = false
    private var deliver: Deliver?
    private var observation: Task<Void, Never>?

    // Touched only by the drain, which never runs twice at once.
    /// The newest write the store holds.
    private var settled = 0
    /// The newest write handed over that hasn't landed.
    private var unsaved: (text: String, generation: Int)?
    private var retries = 0
    private var retryScheduled = false
    /// What the composer holds: the last delivery, with each later saved
    /// write's text in place of its draft.
    private var held: ComposerStoreValue?

    public init(
        sessionId: String,
        storage: any ComposerStorage,
        sending: any ChatSending,
        retryDelays: [Duration] = ComposerDraftWriter.defaultRetryDelays,
        onFailure: @escaping @Sendable (Failure) -> Void = { _ in }
    ) {
        self.sessionId = sessionId
        self.storage = storage
        self.sending = sending
        self.retryDelays = retryDelays
        self.onFailure = onFailure
    }

    deinit {
        observation?.cancel()
    }

    /// Reads the draft the composer opens with, then follows the store.
    public func start(_ deliver: @escaping Deliver) {
        lock.withLock { self.deliver = deliver }
        // Queued first, so the observation's first value finds it read.
        enqueue(.read(forced: true, observed: nil))
        let task = Self.observe(storage, sessionId: sessionId, retryDelays: retryDelays, onFailure: onFailure) { [weak self] value in
            guard let self else { return false }
            self.observed(value)
            return true
        }
        let cancelled = lock.withLock {
            if !closed { observation = task }
            return closed
        }
        if cancelled { task.cancel() }
    }

    /// Follows the store until cancelled or `observed` returns false (the
    /// writer is gone), holding nothing between values. A failed
    /// observation is reported and started again after the next retry
    /// delay, the last one repeating.
    private static func observe(
        _ storage: any ComposerStorage,
        sessionId: String,
        retryDelays: [Duration],
        onFailure: @escaping @Sendable (Failure) -> Void,
        observed: @escaping @Sendable (ComposerStoreValue) -> Bool
    ) -> Task<Void, Never> {
        Task.detached(priority: .userInitiated) {
            var restarts = 0
            while !Task.isCancelled {
                do {
                    for try await value in storage.composerValues(sessionId: sessionId) {
                        guard observed(value) else { return }
                    }
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    onFailure(Failure(operation: .observation, error: error))
                    guard let delay = retryDelays.isEmpty ? nil : retryDelays[min(restarts, retryDelays.count - 1)] else { return }
                    try? await Task.sleep(for: delay)
                    restarts += 1
                }
            }
        }
    }

    /// The store observation's value. A value that lags behind a write
    /// queued before it costs one read and no delivery.
    func observed(_ value: ComposerStoreValue) {
        enqueue(.read(forced: false, observed: value))
    }

    /// A draft write, numbered by the composer (`ComposerDraftModel`).
    public func save(_ text: String, generation: Int) {
        enqueue(.save(text, generation: generation))
    }

    /// Reads and delivers the store's value even if nothing changed: an
    /// input method's composition ended over a deferred remote edit.
    public func refresh() {
        enqueue(.read(forced: true, observed: nil))
    }

    /// Queues a send behind every write handed over before it, at once, so
    /// a keystroke right after it is written after it. The task returns the
    /// message's local id.
    @discardableResult
    public func send(_ message: OutgoingMessage) -> Task<String, any Error> {
        let (result, continuation) = AsyncThrowingStream<String, any Error>.makeStream()
        enqueue(.send(message, continuation))
        return Task {
            for try await localId in result {
                return localId
            }
            throw CancellationError()
        }
    }

    /// Returns once everything handed over before it has run, after one
    /// more try at a write that failed. True only if every write handed
    /// over is on disk; false if the newest still isn't.
    @discardableResult
    public func settle() async -> Bool {
        await withCheckedContinuation { continuation in
            enqueue(.barrier(continuation))
        }
    }

    /// The composer is gone: no more reads or deliveries.
    public func close() {
        let task = lock.withLock {
            closed = true
            deliver = nil
            defer { observation = nil }
            return observation
        }
        task?.cancel()
    }

    // MARK: Drain

    private func enqueue(_ command: Command) {
        let start = lock.withLock {
            if closed, case .read = command { return false }
            queue.append(command)
            guard !draining else { return false }
            draining = true
            return true
        }
        if start {
            Task.detached(priority: .userInitiated) { await self.drain() }
        }
    }

    private func next() -> [Command]? {
        lock.withLock {
            guard !queue.isEmpty else {
                draining = false
                return nil
            }
            defer { queue.removeAll() }
            return queue
        }
    }

    private func drain() async {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        while let batch = next() {
            var run = Run()
            for command in batch {
                switch command {
                case .save(let text, let generation):
                    run.save = (text, generation)
                case .read(let forced, let observed):
                    // An observed value is checked where it was queued,
                    // against what the composer holds by then.
                    var holding = held
                    if let save = run.save { holding?.draft = save.text }
                    if forced || observed != holding {
                        run.read = (run.read ?? false) || forced
                    }
                case .retry:
                    retryScheduled = false
                    run.retry = true
                case .send(let message, let continuation):
                    await finish(run)
                    run = Run()
                    // One more try; a send never goes ahead of its draft.
                    if let error = commitUnsaved() {
                        continuation.finish(throwing: UnsavedDraftError(underlying: error))
                        continue
                    }
                    do {
                        continuation.yield(try await sending.send(message, sessionId: sessionId))
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: error)
                    }
                case .barrier(let continuation):
                    await finish(run)
                    run = Run()
                    continuation.resume(returning: commitUnsaved() == nil)
                }
            }
            await finish(run)
        }
    }

    /// The commands between two sends: only the newest write and one read
    /// (forced if any was) remain, the read after the write.
    private struct Run {
        var save: (text: String, generation: Int)?
        /// Whether the read is forced.
        var read: Bool?
        /// A retry timer fired.
        var retry = false
    }

    private func finish(_ run: Run) async {
        if let save = run.save {
            unsaved = save
            retries = 0
        }
        if run.save != nil || run.retry {
            commitUnsaved()
        }
        if let forced = run.read {
            await read(forced: forced)
        }
    }

    /// Writes the unsaved draft, if any. The error if it failed again.
    @discardableResult
    private func commitUnsaved() -> (any Error)? {
        guard let write = unsaved else { return nil }
        do {
            try storage.saveDraft(sessionId: sessionId, text: write.text)
        } catch {
            onFailure(Failure(operation: .save, error: error))
            scheduleRetry()
            return error
        }
        unsaved = nil
        retries = 0
        settled = write.generation
        held?.draft = write.text
        return nil
    }

    private func scheduleRetry() {
        guard !retryScheduled, retries < retryDelays.count else { return }
        retryScheduled = true
        let delay = retryDelays[retries]
        retries += 1
        Task.detached(priority: .utility) {
            try? await Task.sleep(for: delay)
            self.enqueue(.retry)
        }
    }

    private func read(forced: Bool) async {
        guard isOpen else { return }
        let value: ComposerStoreValue
        do {
            value = try storage.composerValue(sessionId: sessionId)
        } catch {
            onFailure(Failure(operation: .read, error: error))
            return
        }
        if !forced, value == held { return }
        held = value
        let delivery = ComposerStoreDelivery(value: value, generation: settled)
        // Checked again on the main thread, where the composer closes it.
        await MainActor.run {
            guard let deliver = self.lock.withLock({ self.closed ? nil : self.deliver }) else { return }
            deliver(delivery)
        }
    }

    private var isOpen: Bool {
        lock.withLock { !closed && deliver != nil }
    }
}

extension OutboxSender: ComposerStorage {
    private static let composerQueue = DispatchQueue(label: "HappyCore.composer", qos: .userInitiated)

    public func composerValue(sessionId: String) throws -> ComposerStoreValue {
        try store.writer.read { db in try ComposerStoreValue.fetch(db, sessionId: sessionId) }
    }

    public func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        let writer = store.writer
        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            // No removeDuplicates: a store that moves away and back between
            // two fetches must still wake the writer, which compares with
            // what the composer holds.
            let cancellable = ValueObservation
                .tracking { db in try ComposerStoreValue.fetch(db, sessionId: sessionId) }
                .start(
                    in: writer,
                    scheduling: .async(onQueue: Self.composerQueue),
                    onError: { continuation.finish(throwing: $0) },
                    onChange: { continuation.yield($0) }
                )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }
}

/// The composer's draft on the main thread: useDraft.ts's autosave
/// (`DraftAutosave`) over a store read and written off the main thread
/// (`ComposerDraftWriter`).
///
/// It numbers the writes it hands over (`generation`, never reset, not by a
/// send's clear either), so a read from before the newest write is never
/// taken for a remote edit, and it decides what each delivery changes on
/// screen.
public struct ComposerDraftModel: Equatable, Sendable {
    /// A write to hand to the writer.
    public struct Write: Equatable, Sendable {
        public var text: String
        public var generation: Int

        public init(text: String, generation: Int) {
            self.text = text
            self.generation = generation
        }
    }

    /// What a delivery changes on screen.
    public struct Change: Equatable, Sendable {
        /// The text view's new text, caret at the end.
        public var text: String?
        /// The session's picks, moved in the store.
        public var picks: ComposerPicks?
        /// Uploads that failed since the last look, for the alert.
        public var newlyFailedAttachments = 0

        public init(text: String? = nil, picks: ComposerPicks? = nil, newlyFailedAttachments: Int = 0) {
            self.text = text
            self.picks = picks
            self.newlyFailedAttachments = newlyFailedAttachments
        }
    }

    public private(set) var autosave = DraftAutosave(loaded: "")
    /// Writes handed over so far.
    public private(set) var generation = 0
    /// The first read has arrived.
    public private(set) var isLoaded = false
    /// The session's picks as last read: what a pick that failed to go
    /// out falls back to.
    public private(set) var storePicks: ComposerPicks?
    private var knownFailedAttachments = 0

    public init() {}

    /// A text change. `.saveNow` comes back as a write; `.saveLater` leaves
    /// `autosave.pending` and asks for the debounce (`flush` when it ends).
    public mutating func textChanged(_ text: String, synced: Bool) -> (write: Write?, debounce: Bool) {
        switch autosave.textChanged(text, synced: synced) {
        case .none: return (nil, false)
        case .saveNow(let value): return (write(value), false)
        case .saveLater: return (nil, true)
        }
    }

    /// The debounce ran out, the app is leaving the foreground, a send is
    /// about to go or the composer is going away: the pending edit, if any.
    public mutating func flush() -> Write? {
        guard let text = autosave.flush() else { return nil }
        return write(text)
    }

    /// `clearDraft`, after a send. `stored`: delete the stored draft too.
    public mutating func clear(stored: Bool) -> Write? {
        autosave.clear()
        return stored ? write("") : nil
    }

    /// A read from the writer. `text` and `composing` describe the text
    /// view; `synced` is a Happy Agent session, whose draft others edit.
    public mutating func receive(_ delivery: ComposerStoreDelivery, text: String, synced: Bool, composing: Bool) -> Change {
        let value = delivery.value
        var change = Change()
        if value.picks != storePicks {
            storePicks = value.picks
            change.picks = value.picks
        }
        guard isLoaded else {
            isLoaded = true
            knownFailedAttachments = value.failedAttachments
            // useDraft's load: only into a composer nobody has written in.
            if generation == 0, text.isEmpty, !value.draft.isEmpty {
                autosave = DraftAutosave(loaded: value.draft)
                change.text = value.draft
            }
            return change
        }
        change.newlyFailedAttachments = max(0, value.failedAttachments - knownFailedAttachments)
        knownFailedAttachments = value.failedAttachments
        if synced, delivery.generation == generation {
            change.text = autosave.storeChanged(value.draft, composing: composing)
        }
        return change
    }

    private mutating func write(_ text: String) -> Write {
        generation += 1
        return Write(text: text, generation: generation)
    }
}
