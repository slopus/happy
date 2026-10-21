import Foundation
import HappyStore

/// Colour for markdown code blocks, one account's worth. A block is its
/// lines chained through `SyntaxHighlighter.tokenizeLine`, and each line is
/// kept by its grammar, its text and the brackets open before it, so a
/// streaming block tokenizes only the line that grew, and a block seen
/// again tokenizes nothing.
///
/// A plan asks with its pass's deadline (`SyntaxPass`). Lines it lacks are
/// tokenized right there until the deadline; then the block is `pending`,
/// drawn plain, and tokenized whole in the background, and the row being
/// measured is noted as pending (`SyntaxPass.notePending`). Every background job
/// ends with a `completions()` signal, and a pending answer is only ever
/// given while some job is queued or running, so a plan holding a pending
/// block always hears when to ask again.
///
/// Blocks past `DiffSyntax`'s limits (lines, line length, characters) are
/// plain for good and never queued.
///
/// The cache holds the account's code, so it lives and dies with the
/// account: `close()` empties it for good, and work finishing after that is
/// dropped. `clearCache()` empties it and keeps going; jobs from before
/// write nothing. Call `tokens` off the main thread.
public final class CodeSyntaxService: @unchecked Sendable {
    public enum Outcome: Equatable, Sendable {
        case highlighted([SyntaxToken])
        /// No language, or past the limits: plain, and it stays plain.
        case plain
        /// Not ready by the deadline: plain until a completion signal, then
        /// ask again.
        case pending
    }

    /// Background jobs, queued and running, never number more than this.
    static let maxQueued = 64

    private let lock = NSLock()
    private var cache: CodeLineCache
    private var queue: [Job] = []
    /// Queued and running jobs, by identity.
    private var queued: Set<JobKey> = []
    private var queuedBytes = 0
    private let queueCountLimit: Int
    private let queuePayloadLimit: Int
    private var draining = false
    private var generation: UInt64 = 0
    private var closed = false
    private var listeners: [UUID: AsyncStream<Void>.Continuation] = [:]
    private let now: @Sendable () -> ContinuousClock.Instant
    private let tokenizeLine: @Sendable (String, SyntaxHighlighter.Grammar, SyntaxHighlighter.BracketStack) -> SyntaxHighlighter.Line

    /// `now` and `tokenizeLine` stand in for the clock and the tokenizer in
    /// tests.
    public init(
        lineCountLimit: Int = 16_384,
        payloadLimit: Int = 4 * 1024 * 1024,
        queueCountLimit: Int = 64,
        queuePayloadLimit: Int = 4 * 1024 * 1024,
        now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
        tokenizeLine: @escaping @Sendable (String, SyntaxHighlighter.Grammar, SyntaxHighlighter.BracketStack) -> SyntaxHighlighter.Line = {
            SyntaxHighlighter.tokenizeLine($0, grammar: $1, stack: $2)
        }
    ) {
        cache = CodeLineCache(countLimit: lineCountLimit, weightLimit: payloadLimit)
        self.queueCountLimit = min(max(queueCountLimit, 1), Self.maxQueued)
        self.queuePayloadLimit = queuePayloadLimit
        self.now = now
        self.tokenizeLine = tokenizeLine
    }

    /// `code`'s tokens, as `SyntaxHighlighter.tokenize` gives them, if they
    /// are cached or can be made before `deadline`.
    public func tokens(_ code: String, language: String?, until deadline: ContinuousClock.Instant = SyntaxPass.deadline()) -> Outcome {
        ThreadRules.assertOffMain()
        guard let language else { return .plain }
        let lines = code.jsSplit("\n")
        let bytes = code.utf16.count * 2
        guard Self.withinLimits(lines), bytes <= queuePayloadLimit else { return .plain }
        let grammar = SyntaxHighlighter.Grammar(language: language)
        guard let generation = lock.withLock({ closed ? nil : generation }) else { return .plain }
        var tokens: [SyntaxToken] = []
        var stack = SyntaxHighlighter.BracketStack()
        for (index, text) in lines.enumerated() {
            let key = CodeLineKey(grammar: grammar, text: text, stack: stack)
            let line: SyntaxHighlighter.Line
            if let cached = lock.withLock({ cache.get(key) }) {
                line = cached
            } else if now() < deadline {
                line = tokenizeLine(text, grammar, stack)
                remember(key, line, generation: generation)
            } else {
                enqueue(Job(key: JobKey(grammar: grammar, code: code, generation: generation), lines: lines, bytes: bytes))
                SyntaxPass.notePending()
                return .pending
            }
            if index > 0 { tokens.append(SyntaxToken("\n", .plain)) }
            tokens += line.tokens
            stack = line.stack
        }
        return .highlighted(tokens)
    }

    /// A signal each time a background job ends, and when the cache is
    /// cleared; plans with pending blocks ask again. Finishes on `close()`.
    public func completions() -> AsyncStream<Void> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let id = UUID()
            let added: Bool = lock.withLock {
                guard !closed else { return false }
                listeners[id] = continuation
                return true
            }
            guard added else { continuation.finish(); return }
            continuation.onTermination = { [weak self] _ in
                self?.lock.withLock { _ = self?.listeners.removeValue(forKey: id) }
            }
        }
    }

    /// Empties the cache and the queue. A job already running finishes
    /// without writing anything; plans with pending blocks ask again.
    public func clearCache() {
        let signal: [AsyncStream<Void>.Continuation] = lock.withLock {
            guard !closed else { return [] }
            generation &+= 1
            cache.removeAll()
            purgeQueue()
            return Array(listeners.values)
        }
        for listener in signal { listener.yield() }
    }

    /// Empties the cache for good: nothing is cached, queued or signalled
    /// after this, and every answer is plain.
    public func close() {
        let finished: [AsyncStream<Void>.Continuation] = lock.withLock {
            guard !closed else { return [] }
            closed = true
            generation &+= 1
            cache.removeAll()
            purgeQueue()
            defer { listeners.removeAll() }
            return Array(listeners.values)
        }
        for listener in finished { listener.finish() }
    }

    public var isClosed: Bool {
        lock.withLock { closed }
    }

    /// Waits for background work to finish (tests).
    public func idle() async {
        while lock.withLock({ draining }) {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    /// The cached lines and their weight (tests).
    var retainedUsage: (count: Int, bytes: Int) {
        lock.withLock { (cache.count, cache.weight) }
    }

    /// Queued and running jobs and their reserved bytes (tests).
    var queuedUsage: (count: Int, bytes: Int) {
        lock.withLock { (queued.count, queuedBytes) }
    }

    /// `DiffSyntax.withinLimits`, for a block's lines.
    static func withinLimits(_ lines: [String]) -> Bool {
        guard lines.count <= DiffSyntax.maxLines else { return false }
        var characters = 0
        for line in lines {
            let length = line.utf16.count
            if length > DiffSyntax.maxLine { return false }
            characters += length + 1
            if characters > DiffSyntax.maxCharacters { return false }
        }
        return true
    }

    // MARK: - Background

    private struct JobKey: Hashable {
        var grammar: SyntaxHighlighter.Grammar
        var code: String
        /// A job from before `clearCache` is a different job, so its end
        /// never releases a newer one's place.
        var generation: UInt64
    }

    private struct Job {
        var key: JobKey
        var lines: [String]
        /// Reserved from queueing until the job ends, running included.
        var bytes: Int
    }

    /// Queues `job` unless it is queued or running already, or the queue is
    /// full. A full queue holds at least one job, whose end signals.
    private func enqueue(_ job: Job) {
        let start: Bool = lock.withLock {
            guard !closed, job.key.generation == generation, !queued.contains(job.key),
                  queued.count < queueCountLimit, queuedBytes + job.bytes <= queuePayloadLimit else { return false }
            queued.insert(job.key)
            queuedBytes += job.bytes
            queue.append(job)
            guard !draining else { return false }
            draining = true
            return true
        }
        guard start else { return }
        Task.detached(priority: .utility) { [self] in
            while let job = next() {
                run(job)
                done(job)
            }
        }
    }

    private func next() -> Job? {
        lock.withLock {
            guard !queue.isEmpty else {
                draining = false
                return nil
            }
            return queue.removeFirst()
        }
    }

    /// Tokenizes the lines the cache lacks; stops at once if the service
    /// closed or cleared meanwhile.
    private func run(_ job: Job) {
        var stack = SyntaxHighlighter.BracketStack()
        for text in job.lines {
            let key = CodeLineKey(grammar: job.key.grammar, text: text, stack: stack)
            let cached: SyntaxHighlighter.Line?? = lock.withLock {
                guard !closed, job.key.generation == generation else { return .none }
                return .some(cache.get(key))
            }
            guard let cached else { return }
            let line = cached ?? tokenizeLine(text, job.key.grammar, stack)
            if cached == nil { remember(key, line, generation: job.key.generation) }
            stack = line.stack
        }
    }

    private func done(_ job: Job) {
        let signal: [AsyncStream<Void>.Continuation] = lock.withLock {
            if queued.remove(job.key) != nil { queuedBytes -= job.bytes }
            return closed ? [] : Array(listeners.values)
        }
        for listener in signal { listener.yield() }
    }

    /// Drops every queued job; a running one keeps its place until it ends.
    /// Called with the lock held.
    private func purgeQueue() {
        for job in queue where queued.remove(job.key) != nil {
            queuedBytes -= job.bytes
        }
        queue.removeAll()
    }

    private func remember(_ key: CodeLineKey, _ line: SyntaxHighlighter.Line, generation token: UInt64) {
        lock.withLock {
            guard !closed, token == generation else { return }
            cache.set(key, line, weight: Self.weight(key, line))
        }
    }

    /// The text twice (key and tokens), both stacks, and a token's overhead.
    static func weight(_ key: CodeLineKey, _ line: SyntaxHighlighter.Line) -> Int {
        64 + key.text.utf16.count * 4 + (key.stack.openers.count + line.stack.openers.count) * 2 + line.tokens.count * 48
    }
}

/// A line's identity: what its tokens depend on, and nothing else.
struct CodeLineKey: Hashable {
    var grammar: SyntaxHighlighter.Grammar
    var text: String
    var stack: SyntaxHighlighter.BracketStack
}

/// A least-recently-used cache of lines by count and total weight, with
/// constant-time reads and evictions (a doubly linked list over slots).
/// Not thread-safe: the service holds its lock around every call.
struct CodeLineCache {
    private struct Entry {
        var key: CodeLineKey
        var value: SyntaxHighlighter.Line
        var weight: Int
        var older: Int
        var newer: Int
    }

    private let countLimit: Int
    private let weightLimit: Int
    private var slots: [Entry?] = []
    private var free: [Int] = []
    private var index: [CodeLineKey: Int] = [:]
    private var oldest = -1
    private var newest = -1
    private(set) var weight = 0

    init(countLimit: Int, weightLimit: Int) {
        self.countLimit = countLimit
        self.weightLimit = weightLimit
    }

    var count: Int { index.count }

    mutating func get(_ key: CodeLineKey) -> SyntaxHighlighter.Line? {
        guard let slot = index[key] else { return nil }
        unlink(slot)
        link(slot)
        return slots[slot]?.value
    }

    mutating func set(_ key: CodeLineKey, _ value: SyntaxHighlighter.Line, weight: Int) {
        if let slot = index[key] { remove(slot) }
        guard weight <= weightLimit, countLimit > 0 else { return }
        let slot = free.popLast() ?? { slots.append(nil); return slots.count - 1 }()
        slots[slot] = Entry(key: key, value: value, weight: weight, older: -1, newer: -1)
        index[key] = slot
        self.weight += weight
        link(slot)
        while index.count > countLimit || self.weight > weightLimit, oldest >= 0 {
            remove(oldest)
        }
    }

    mutating func removeAll() {
        slots = []
        free = []
        index = [:]
        oldest = -1
        newest = -1
        weight = 0
    }

    private mutating func remove(_ slot: Int) {
        guard let entry = slots[slot] else { return }
        unlink(slot)
        index.removeValue(forKey: entry.key)
        weight -= entry.weight
        slots[slot] = nil
        free.append(slot)
    }

    /// Makes `slot` the newest.
    private mutating func link(_ slot: Int) {
        slots[slot]?.older = newest
        slots[slot]?.newer = -1
        if newest >= 0 { slots[newest]?.newer = slot }
        newest = slot
        if oldest < 0 { oldest = slot }
    }

    private mutating func unlink(_ slot: Int) {
        guard let entry = slots[slot] else { return }
        if entry.older >= 0 { slots[entry.older]?.newer = entry.newer } else { oldest = entry.newer }
        if entry.newer >= 0 { slots[entry.newer]?.older = entry.older } else { newest = entry.older }
    }
}
