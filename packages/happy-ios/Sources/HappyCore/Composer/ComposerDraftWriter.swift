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
    /// The draft is the text of that write, compared off the main thread:
    /// what the composer last saved, as far as `generation` goes. A draft
    /// that isn't, in a read as new as the composer's writes, was written
    /// by someone else.
    public var draftIsSaved: Bool

    public init(value: ComposerStoreValue, generation: Int, draftIsSaved: Bool = false) {
        self.value = value
        self.generation = generation
        self.draftIsSaved = draftIsSaved
    }
}

/// Where a composer's writer reads and writes: `OutboxSender` for a
/// session, the chat's own store for a chat still being started. Every call
/// comes from the writer's background drain, one at a time; an actor can
/// implement it directly, and synchronous methods satisfy it.
public protocol ComposerStorage: Sendable {
    func composerValue(sessionId: String) async throws -> ComposerStoreValue
    func saveDraft(sessionId: String, text: String) async throws
    /// The current value, then one after each commit to what it reads,
    /// produced off the main thread. It ends by throwing if the database
    /// observation fails.
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error>
}

/// One session's composer persistence, in order and off the main thread.
///
/// The composer hands over draft writes, sends and read requests on the
/// main thread; a single drain runs them in that order on a background task:
///   - consecutive writes collapse into the newest text, which is read
///     here (a snapshot of the field is copied out off the main thread)
///     and compared with what is saved or stored, as its `Persist` asks;
///   - a send waits for the writes before it and holds back the writes
///     after it, so a Happy Agent send reads the stamp of the text it sends,
///     and typing during a send is written after the send's clear;
///   - reads move to the end of their run and are tagged with the newest
///     write the store holds (`ComposerStoreDelivery.generation`) and
///     whether the draft is its text (`draftIsSaved`);
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
/// before or after it still run, so a teardown flush lands. A writer that
/// takes over from another (`after:`) runs nothing until the other has
/// settled, so the old storage's last write never lands after the new one's
/// first read. If that write still failed, the new writer's deliveries say
/// so until its own first write lands: their generation is the newest one
/// the old storage holds, behind the composer's.
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
        case save(ComposerDraftText, generation: Int, persist: ComposerDraftModel.Write.Persist)
        case read(forced: Bool, observed: ComposerStoreValue?)
        case send(OutgoingMessage, AsyncThrowingStream<String, any Error>.Continuation)
        case barrier(CheckedContinuation<Settled, Never>)
        case retry
        case after(ComposerDraftWriter)
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

    /// What a barrier found: whether every write handed over is on disk,
    /// and the newest one that is.
    private struct Settled {
        var saved: Bool
        var generation: Int
    }
    /// The newest write handed over that hasn't landed.
    private var unsaved: (text: String, generation: Int, persist: ComposerDraftModel.Write.Persist)?
    /// The text of the newest write that landed: what the composer last
    /// saved, once its generation is `settled`.
    private var lastWrite = ""
    private var retries = 0
    private var retryScheduled = false
    /// What the composer holds: the last delivery, with each later saved
    /// write's text in place of its draft.
    private var held: ComposerStoreValue?

    /// `generation`: the composer's newest write so far, which a writer
    /// taking over from another (`predecessor`) starts from, so the store's
    /// reads keep the composer's numbering.
    public init(
        sessionId: String,
        storage: any ComposerStorage,
        sending: any ChatSending,
        generation: Int = 0,
        after predecessor: ComposerDraftWriter? = nil,
        retryDelays: [Duration] = ComposerDraftWriter.defaultRetryDelays,
        onFailure: @escaping @Sendable (Failure) -> Void = { _ in }
    ) {
        self.sessionId = sessionId
        self.storage = storage
        self.sending = sending
        self.retryDelays = retryDelays
        self.onFailure = onFailure
        settled = generation
        if let predecessor {
            enqueue(.after(predecessor))
        }
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

    /// A draft write, numbered by the composer, written whatever the
    /// store holds.
    public func save(_ text: String, generation: Int) {
        enqueue(.save(ComposerDraftText(text), generation: generation, persist: .always))
    }

    /// A `ComposerDraftModel` write.
    public func save(_ write: ComposerDraftModel.Write) {
        enqueue(.save(write.text, generation: write.generation, persist: write.persist))
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
        await landed().saved
    }

    private func landed() async -> Settled {
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
        ThreadRules.assertOffMain()
        while let batch = next() {
            var run = Run()
            for command in batch {
                switch command {
                case .save(let text, let generation, let persist):
                    run.save = (text, generation, persist)
                case .read(let forced, let observed):
                    // An observed value is checked where it was queued,
                    // against what the composer holds by then.
                    var holding = held
                    if let save = run.save { holding?.draft = await save.text.resolve() }
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
                    if let error = await commitUnsaved() {
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
                    let saved = await commitUnsaved() == nil
                    continuation.resume(returning: Settled(saved: saved, generation: settled))
                case .after(let predecessor):
                    await finish(run)
                    run = Run()
                    // Its unsaved write stays its own to retry; the
                    // composer, told by the generation, writes the text
                    // it holds here.
                    let landed = await predecessor.landed()
                    if !landed.saved { settled = min(settled, landed.generation) }
                }
            }
            await finish(run)
        }
    }

    /// The commands between two sends: only the newest write and one read
    /// (forced if any was) remain, the read after the write.
    private struct Run {
        var save: (text: ComposerDraftText, generation: Int, persist: ComposerDraftModel.Write.Persist)?
        /// Whether the read is forced.
        var read: Bool?
        /// A retry timer fired.
        var retry = false
    }

    private func finish(_ run: Run) async {
        if let save = run.save {
            unsaved = (await save.text.resolve(), save.generation, save.persist)
            retries = 0
        }
        if run.save != nil || run.retry {
            await commitUnsaved()
        }
        if let forced = run.read {
            await read(forced: forced)
        }
    }

    /// Writes the unsaved draft, if any. The error if it failed again.
    @discardableResult
    private func commitUnsaved() async -> (any Error)? {
        guard let write = unsaved else { return nil }
        let stored: Bool
        switch write.persist {
        case .always: stored = false
        case .unlessSaved: stored = write.text == lastWrite
        case .unlessStored: stored = write.text == held?.draft
        case .never: stored = true
        }
        do {
            if !stored {
                try await storage.saveDraft(sessionId: sessionId, text: write.text)
            }
        } catch {
            onFailure(Failure(operation: .save, error: error))
            scheduleRetry()
            return error
        }
        unsaved = nil
        retries = 0
        settled = write.generation
        lastWrite = write.text
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
            value = try await storage.composerValue(sessionId: sessionId)
        } catch {
            onFailure(Failure(operation: .read, error: error))
            return
        }
        if !forced, value == held { return }
        held = value
        let delivery = ComposerStoreDelivery(value: value, generation: settled, draftIsSaved: value.draft == lastWrite)
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
        ThreadRules.assertOffMain()
        return try store.writer.read { db in try ComposerStoreValue.fetch(db, sessionId: sessionId) }
    }

    public func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        let writer = store.writer
        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            // No removeDuplicates: a store that moves away and back between
            // two fetches must still wake the writer, which compares with
            // what the composer holds.
            let cancellable = ValueObservation
                .tracking { db in
                    ThreadRules.assertOffMain()
                    return try ComposerStoreValue.fetch(db, sessionId: sessionId)
                }
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
/// send's clear or a `retarget()` either), so a read from before the newest
/// write is never taken for a remote edit, and it decides what each
/// delivery changes on screen.
///
/// It never reads, copies or compares the field's text, whose cost would
/// grow with it: an edit tells it only whether the text is blank, and a
/// write carries the field as a snapshot the writer reads off the main
/// thread. Everything that becomes the text the composer counts as saved
/// is a write, numbered like the others: one that loads or takes a stored
/// draft, or clears the field after a send that cleared the store, just
/// isn't written again (`Persist.never`). So whenever a read is as new as
/// the composer's writes, the writer has the text it last saved to compare
/// the stored draft with.
public struct ComposerDraftModel: Equatable, Sendable {
    /// A write to hand to the writer.
    public struct Write: Equatable, Sendable {
        /// Whether the writer writes the text to the store.
        public enum Persist: Equatable, Sendable {
            case always
            /// Unless it is the text last saved: useDraft's
            /// `value !== lastSavedValue`, for an edit.
            case unlessSaved
            /// Unless the store, as last read, holds it already.
            case unlessStored
            /// The store holds it already: it is only counted as saved.
            case never
        }

        public var text: ComposerDraftText
        public var generation: Int
        public var persist: Persist

        public init(text: ComposerDraftText, generation: Int, persist: Persist = .always) {
            self.text = text
            self.generation = generation
            self.persist = persist
        }
    }

    /// What a delivery changes on screen.
    public struct Change: Equatable, Sendable {
        /// The text view's new text, caret at the end. Set it at once: the
        /// change it makes is the model's own (`textChanged` ignores it).
        public var text: String?
        /// The session's picks, moved in the store.
        public var picks: ComposerPicks?
        /// Uploads that failed since the last look, for the alert.
        public var newlyFailedAttachments = 0
        /// A write to hand to the writer.
        public var write: Write?

        public init(text: String? = nil, picks: ComposerPicks? = nil, newlyFailedAttachments: Int = 0, write: Write? = nil) {
            self.text = text
            self.picks = picks
            self.newlyFailedAttachments = newlyFailedAttachments
            self.write = write
        }
    }

    public private(set) var autosave = DraftAutosave()
    /// Writes handed over so far.
    public private(set) var generation = 0
    /// The first read has arrived.
    public private(set) var isLoaded = false
    /// The session's picks as last read: what a pick that failed to go
    /// out falls back to.
    public private(set) var storePicks: ComposerPicks?
    private var knownFailedAttachments = 0
    /// `generation` when the store last changed under the composer (its
    /// opening, or `retarget()`): writing since then means typing.
    private var loadGeneration = 0
    private var retargeted = false
    /// A retargeted composer's first read came during a send.
    private var loadDeferred = false
    /// The next text change is the composer setting text the model gave
    /// it or cleared, already counted.
    private var awaitsOwnText = false

    public init() {}

    /// The composer now writes to another store (a chat that was being
    /// started arrived): its next read is a first read again. The text
    /// stays, and so does the numbering.
    public mutating func retarget() {
        isLoaded = false
        retargeted = true
        loadDeferred = false
        loadGeneration = generation
        storePicks = nil
    }

    /// The send in flight returned, its text cleared from the field if it
    /// went: true if a first read waited for it and must be asked for again.
    public mutating func sendReturned() -> Bool {
        defer { loadDeferred = false }
        return loadDeferred
    }

    /// A text change that left the field blank or not; `text` is the field
    /// (a snapshot), asked for only if it is written now. `.saveNow` comes
    /// back as a write; `.saveLater` leaves `autosave.hasPending` and asks
    /// for the debounce (`flush` when it ends).
    public mutating func textChanged(isBlank: Bool, synced: Bool, text: @autoclosure () -> ComposerDraftText) -> (write: Write?, debounce: Bool) {
        if awaitsOwnText {
            awaitsOwnText = false
            return (nil, false)
        }
        switch autosave.textChanged(isBlank: isBlank, synced: synced) {
        case .none: return (nil, false)
        case .saveNow: return (write(text(), .unlessSaved), false)
        case .saveLater: return (nil, true)
        }
    }

    /// `textChanged` for a caller holding the text as a string.
    public mutating func textChanged(_ text: String, synced: Bool) -> (write: Write?, debounce: Bool) {
        textChanged(isBlank: DraftAutosave.isBlank(text), synced: synced, text: ComposerDraftText(text))
    }

    /// The debounce ran out, the app is leaving the foreground, a send is
    /// about to go or the composer is going away: the pending edit, if any.
    /// `text` is the field, which holds it.
    public mutating func flush(text: @autoclosure () -> ComposerDraftText) -> Write? {
        guard autosave.flush() else { return nil }
        return write(text(), .unlessSaved)
    }

    /// `clearDraft`, after a send; the composer empties the field next.
    /// `stored`: delete the stored draft too. Otherwise the send already
    /// emptied it, which is only counted.
    public mutating func clear(stored: Bool) -> Write {
        autosave.clear()
        awaitsOwnText = true
        return write("", stored ? .always : .never)
    }

    /// A read from the writer. `field` is the text view's text (a
    /// snapshot), asked for only when it is to be written; `fieldIsEmpty`
    /// and `fieldIsBlank` describe it. `synced` is a Happy Agent session,
    /// whose draft others edit; `composing`, an input method is composing;
    /// `sending`, a send is in flight.
    public mutating func receive(
        _ delivery: ComposerStoreDelivery,
        field: @autoclosure () -> ComposerDraftText,
        fieldIsEmpty: Bool,
        fieldIsBlank: Bool,
        synced: Bool,
        composing: Bool,
        sending: Bool = false
    ) -> Change {
        let value = delivery.value
        var change = Change()
        if !isLoaded, retargeted, sending {
            // A send queued before the retarget: until it returns, the
            // field may hold what it sent, which the new store mustn't get.
            loadDeferred = true
            return change
        }
        if value.picks != storePicks {
            storePicks = value.picks
            change.picks = value.picks
        }
        guard isLoaded else {
            isLoaded = true
            knownFailedAttachments = value.failedAttachments
            let typed = generation != loadGeneration
            // The old store missed the composer's newest write (it failed):
            // what it handed over is older than the field.
            let behind = delivery.generation != generation
            if typed {
                // Its own writes follow this read.
            } else if retargeted, !fieldIsEmpty || behind {
                // Carried over from the old store: the text is the truth
                // (SessionView's ChatComposer), so the new store gets it
                // unless it holds it already, and a store behind gets it
                // again to catch the numbering up.
                autosave = DraftAutosave(loadedIsBlank: fieldIsBlank)
                change.write = write(field(), behind ? .always : .unlessStored)
            } else if fieldIsEmpty, !value.draft.isEmpty {
                // useDraft's load: only into a composer nobody has written
                // in, and never over text the composer holds.
                take(value.draft, into: &change)
            }
            return change
        }
        change.newlyFailedAttachments = max(0, value.failedAttachments - knownFailedAttachments)
        knownFailedAttachments = value.failedAttachments
        if synced, delivery.generation == generation,
           autosave.storeChanged(isSaved: delivery.draftIsSaved, composing: composing) {
            take(value.draft, into: &change)
        }
        return change
    }

    /// `receive` for a caller holding the field as a string.
    public mutating func receive(_ delivery: ComposerStoreDelivery, text: String, synced: Bool, composing: Bool, sending: Bool = false) -> Change {
        receive(
            delivery, field: ComposerDraftText(text), fieldIsEmpty: text.isEmpty,
            fieldIsBlank: DraftAutosave.isBlank(text), synced: synced, composing: composing, sending: sending
        )
    }

    /// A stored draft becomes the text: it is shown, and counted as saved.
    private mutating func take(_ draft: String, into change: inout Change) {
        autosave.took(isBlank: DraftAutosave.isBlank(draft))
        awaitsOwnText = true
        change.text = draft
        change.write = write(ComposerDraftText(draft), .never)
    }

    private mutating func write(_ text: ComposerDraftText, _ persist: Write.Persist) -> Write {
        generation += 1
        return Write(text: text, generation: generation, persist: persist)
    }
}
