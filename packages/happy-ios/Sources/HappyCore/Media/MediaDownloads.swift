import Foundation

/// One account's media downloads into its `MediaStore`, after Telegram's
/// fetch manager: one reader per file, a range at a time, into the
/// partial file, resumable from whatever an earlier run kept.
///
/// - `download` reads the whole file; `pause` stops it, keeping the rest.
/// - `read` is a player's: the ranges it asks for are fetched first, so a
///   recording plays from what is here and a seek waits only for its own
///   range, while a download carries on after it.
/// - Background downloads (automatic ones) run at most
///   `backgroundLimit` at a time, at utility priority; one a person asked
///   for runs at once.
///
/// Progress goes to `DownloadBoard` under `MediaLibrary.key`.
public actor MediaDownloads {
    public enum Priority: Int, Comparable, Sendable {
        case background, user
        public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    /// A range asked for at a time while a player waits on it.
    public static let streamChunk = 256 * 1024
    /// A range asked for at a time while nothing waits.
    public static let chunk = 1024 * 1024
    public static let backgroundLimit = 2
    /// Failed fetches in a row before the file is given up on, until a tap.
    static let attempts = 3

    public nonisolated let store: MediaStore
    private let board: DownloadBoard
    private let boardKey: @Sendable (String) -> String
    private let sleep: InvalidateSync.Sleep
    private var jobs: [String: Job] = [:]
    private var waiting: [String] = []
    private var stopped = false

    private final class Job {
        let id: String
        var source: MediaSource
        var task: Task<Void, Never>?
        /// The whole file is wanted, not only what players ask.
        var full = false
        var priority: Priority = .background
        var readers: [Reader] = []
        var finished: [CheckedContinuation<Void, Error>] = []
        /// Where the last range ended: the next one follows on from it.
        var cursor = 0
        var failures = 0
        init(id: String, source: MediaSource) {
            self.id = id
            self.source = source
        }
    }

    private struct Reader {
        let token: UUID
        /// Stored ranges it needs.
        let ranges: [Range<Int>]
        let continuation: CheckedContinuation<Void, Error>
    }

    public init(store: MediaStore, board: DownloadBoard = .shared, key: @escaping @Sendable (String) -> String = { $0 },
                sleep: @escaping InvalidateSync.Sleep = InvalidateSync.taskSleep) {
        self.store = store
        self.board = board
        boardKey = key
        self.sleep = sleep
    }

    // MARK: State

    /// Where the file is, from the disk, also put on the board.
    @discardableResult
    public func phase(_ id: String, source: MediaSource) -> DownloadPhase {
        let phase = currentPhase(id, source: source)
        board.set(boardKey(id), phase)
        return phase
    }

    private func currentPhase(_ id: String, source: MediaSource) -> DownloadPhase {
        if let length = store.completeLength(id) { return .complete(total: length) }
        let seal = source.seal
        func plain(_ stored: Int?) -> Int? { stored.map { seal?.plainLength(stored: $0) ?? $0 } }
        let partial = store.hasPartial(id) ? store.partial(id) : nil
        let total = plain(partial?.total ?? source.length)
        let done = plain(partial?.downloaded ?? 0) ?? 0
        if let job = jobs[id] {
            if job.failures >= Self.attempts { return .failed(done: done, total: total) }
            // A player's reads alone (a video's first frame) aren't a download.
            if job.full { return .downloading(done: done, total: total) }
        }
        return done > 0 ? .paused(done: done, total: total) : .remote(total: total)
    }

    // MARK: Whole files

    /// Reads the whole file, from where an earlier read stopped. A person's
    /// tap (`user`) also lifts a background one queued behind others.
    public func download(_ id: String, source: MediaSource, priority: Priority = .user) {
        guard !stopped, !store.isComplete(id) else {
            phase(id, source: source)
            return
        }
        let job = job(id, source: source)
        job.full = true
        if job.failures >= Self.attempts { job.failures = 0 }
        if priority > job.priority { job.priority = priority }
        run(job)
        phase(id, source: source)
    }

    /// Stops a whole-file read; a player's ranges are still served.
    public func pause(_ id: String) {
        guard let job = jobs[id] else { return }
        job.full = false
        if job.readers.isEmpty, job.finished.isEmpty {
            job.task?.cancel()
            job.task = nil
            waiting.removeAll { $0 == id }
            jobs[id] = nil
        }
        phase(id, source: job.source)
    }

    /// A tap on the ring: pause what is going, else start or resume.
    public func toggle(_ id: String, source: MediaSource) {
        if let job = jobs[id], job.full, job.failures < Self.attempts { pause(id) } else { download(id, source: source, priority: .user) }
    }

    /// The whole file's plaintext, read first where it isn't here yet.
    public func data(_ id: String, source: MediaSource, priority: Priority = .user) async throws -> Data {
        try await complete(id, source: source, priority: priority)
        guard let length = store.completeLength(id), let data = store.read(id, 0..<length, seal: nil) else { throw MediaError.invalidResponse }
        return data
    }

    /// Waits until the whole file is here, reading it where it isn't.
    public func complete(_ id: String, source: MediaSource, priority: Priority = .user) async throws {
        if store.isComplete(id) { return }
        guard !stopped else { throw MediaError.stopped }
        let job = job(id, source: source)
        job.full = true
        if job.failures >= Self.attempts { job.failures = 0 }
        if priority > job.priority { job.priority = priority }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            job.finished.append(continuation)
            run(job)
            phase(id, source: source)
        }
    }

    // MARK: Streaming

    /// The plaintext length, from the disk or the first range read.
    public func length(_ id: String, source: MediaSource) async throws -> Int {
        if let length = store.completeLength(id) { return length }
        let stored: Int
        if let total = store.hasPartial(id) ? store.partial(id).total : nil {
            stored = total
        } else if let known = source.length {
            stored = known
        } else {
            try await wait(id, source: source, ranges: [0..<min(Self.streamChunk, 1)])
            if let length = store.completeLength(id) { return length }
            guard let total = store.partial(id).total else { throw MediaError.invalidResponse }
            stored = total
        }
        return source.seal?.plainLength(stored: stored) ?? stored
    }

    /// Plaintext bytes of `range`, fetched first where they aren't here: a
    /// player's read. The range is clamped to the file's end.
    public func read(_ id: String, source: MediaSource, range: Range<Int>) async throws -> Data {
        if let data = store.read(id, range, seal: source.seal) { return data }
        let stored = source.seal?.storedRanges(range) ?? [range]
        try await wait(id, source: source, ranges: stored)
        guard let data = store.read(id, range, seal: source.seal) else { throw MediaError.outOfRange }
        return data
    }

    /// How many plaintext bytes run on from `offset` without a hole, up to `limit`.
    public func available(_ id: String, source: MediaSource, from offset: Int, limit: Int) -> Int {
        if let length = store.completeLength(id) { return max(0, min(limit, length - offset)) }
        guard store.hasPartial(id) else { return 0 }
        let partial = store.partial(id)
        guard let seal = source.seal else { return partial.contiguous(from: offset, limit: limit) }
        guard partial.contains(0..<MediaSeal.header) else { return 0 }
        return partial.contiguous(from: offset + MediaSeal.header, limit: limit)
    }

    private func wait(_ id: String, source: MediaSource, ranges: [Range<Int>]) async throws {
        guard !stopped else { throw MediaError.stopped }
        let job = job(id, source: source)
        let token = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let reader = Reader(token: token, ranges: ranges, continuation: continuation)
                if satisfied(reader, job: job) {
                    continuation.resume()
                    return
                }
                job.readers.append(reader)
                // A player waits: never behind automatic downloads.
                job.priority = .user
                if job.failures >= Self.attempts { job.failures = 0 }
                run(job)
                phase(id, source: source)
            }
        } onCancel: {
            Task { await self.cancelReader(id, token: token) }
        }
    }

    /// A player that stopped waiting: its ranges are no longer fetched
    /// first, and a read nothing else wants stops.
    private func cancelReader(_ id: String, token: UUID) {
        guard let job = jobs[id], let index = job.readers.firstIndex(where: { $0.token == token }) else { return }
        let reader = job.readers.remove(at: index)
        reader.continuation.resume(throwing: CancellationError())
        if !job.full, job.readers.isEmpty, job.finished.isEmpty {
            job.task?.cancel()
            jobs[id] = nil
            phase(id, source: job.source)
            startWaiting()
        }
    }

    // MARK: Running

    private func job(_ id: String, source: MediaSource) -> Job {
        if let job = jobs[id] {
            if job.source.length == nil, source.length != nil { job.source.length = source.length }
            return job
        }
        let job = Job(id: id, source: source)
        jobs[id] = job
        return job
    }

    private var runningBackground: Int {
        jobs.values.filter { $0.task != nil && $0.priority == .background }.count
    }

    private func run(_ job: Job) {
        guard job.task == nil, !stopped else { return }
        if job.priority == .background, runningBackground >= Self.backgroundLimit {
            if !waiting.contains(job.id) { waiting.append(job.id) }
            return
        }
        waiting.removeAll { $0 == job.id }
        let id = job.id
        job.task = Task(priority: job.priority == .user ? .userInitiated : .utility) { [weak self] in
            await self?.loop(id)
        }
    }

    private func startWaiting() {
        while let next = waiting.first, runningBackground < Self.backgroundLimit {
            waiting.removeFirst()
            if let job = jobs[next] { run(job) }
        }
    }

    private func loop(_ id: String) async {
        while let job = jobs[id], !Task.isCancelled, !stopped {
            let partial = store.partial(id)
            if store.isComplete(id) || partial.isComplete {
                finish(job)
                return
            }
            guard let next = nextRange(job, partial: partial) else {
                // Nothing wanted now: what players ask later starts it again.
                job.task = nil
                if !job.full, job.readers.isEmpty, job.finished.isEmpty { jobs[id] = nil }
                startWaiting()
                return
            }
            do {
                let piece = try await job.source.fetch(next)
                try Task.checkCancellation()
                guard jobs[id] === job else { return }
                if let total = piece.total { try partial.setTotal(total) }
                guard !piece.data.isEmpty || partial.total == 0 else { throw MediaError.invalidResponse }
                try partial.write(piece.data, at: piece.offset)
                job.cursor = piece.offset + piece.data.count
                job.failures = 0
                serveReaders(job, partial: partial)
                phase(id, source: job.source)
            } catch {
                guard !Task.isCancelled, !(error is CancellationError), jobs[id] === job else { return }
                job.failures += 1
                if job.failures >= Self.attempts || error is MediaError {
                    job.failures = Self.attempts
                    fail(job, error)
                    return
                }
                try? await sleep(.seconds(1 << (job.failures - 1)))
            }
        }
    }

    /// The next stored range to fetch: what a reader waits on first, else
    /// on from where the last one ended, else the first hole.
    private func nextRange(_ job: Job, partial: PartialFile) -> Range<Int>? {
        let total = partial.total ?? job.source.length
        for reader in job.readers {
            for range in reader.ranges {
                let clamped = total.map { range.clamped(to: 0..<$0) } ?? range
                if let hole = partial.missing(in: clamped).first {
                    // A little ahead of what it asked, as a player reads on,
                    // short of bytes already here.
                    let end = min(hole.lowerBound + Self.streamChunk, total ?? Int.max)
                    let last = partial.missing(in: hole.lowerBound..<end).last?.upperBound ?? end
                    return hole.lowerBound..<last
                }
            }
        }
        guard job.full else { return nil }
        guard let total else { return 0..<Self.chunk }
        let hole = partial.missing(in: min(job.cursor, total)..<total).first ?? partial.missing(in: 0..<total).first
        return hole.map { $0.lowerBound..<min($0.upperBound, $0.lowerBound + Self.chunk) }
    }

    private func satisfied(_ reader: Reader, job: Job) -> Bool {
        if store.isComplete(job.id) { return true }
        guard store.hasPartial(job.id) else { return false }
        let partial = store.partial(job.id)
        let total = partial.total
        return reader.ranges.allSatisfy { range in
            let clamped = total.map { range.clamped(to: 0..<$0) } ?? range
            return partial.contains(clamped)
        }
    }

    private func serveReaders(_ job: Job, partial: PartialFile) {
        let ready = job.readers.filter { satisfied($0, job: job) }
        guard !ready.isEmpty else { return }
        let tokens = Set(ready.map(\.token))
        job.readers.removeAll { tokens.contains($0.token) }
        for reader in ready { reader.continuation.resume() }
    }

    private func finish(_ job: Job) {
        jobs[job.id] = nil
        do {
            if !store.isComplete(job.id) { try store.finish(job.id, seal: job.source.seal) }
            for reader in job.readers { reader.continuation.resume() }
            for waiter in job.finished { waiter.resume() }
            phase(job.id, source: job.source)
        } catch {
            // Kept as failed, so its ring says so until a tap.
            job.failures = Self.attempts
            jobs[job.id] = job
            fail(job, error)
        }
        startWaiting()
    }

    private func fail(_ job: Job, _ error: Error) {
        let readers = job.readers
        let finished = job.finished
        job.readers = []
        job.finished = []
        job.full = false
        job.task = nil
        for reader in readers { reader.continuation.resume(throwing: error) }
        for waiter in finished { waiter.resume(throwing: error) }
        board.set(boardKey(job.id), currentPhase(job.id, source: job.source))
        startWaiting()
    }

    // MARK: Lifetime

    /// Stops every read; what each kept stays for the next run.
    public func stop() {
        stopped = true
        for job in jobs.values {
            job.task?.cancel()
            for reader in job.readers { reader.continuation.resume(throwing: MediaError.stopped) }
            for waiter in job.finished { waiter.resume(throwing: MediaError.stopped) }
        }
        jobs.removeAll()
        waiting.removeAll()
    }

    /// Stops every read and forgets every file (Settings' Clear Media).
    public func removeAll() {
        for job in jobs.values {
            job.task?.cancel()
            for reader in job.readers { reader.continuation.resume(throwing: MediaError.stopped) }
            for waiter in job.finished { waiter.resume(throwing: MediaError.stopped) }
        }
        jobs.removeAll()
        waiting.removeAll()
        store.removeAll()
    }

    /// Whether a read is going, for tests.
    public func isRunning(_ id: String) -> Bool { jobs[id]?.task != nil }
}
