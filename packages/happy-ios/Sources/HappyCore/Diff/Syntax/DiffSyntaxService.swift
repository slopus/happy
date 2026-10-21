import Foundation

/// syntax/service.ts's cache and queue, for owners that plan off the main
/// thread. A plan colours its rows from the cache and tokenizes the hunks
/// it lacks right there, starting no new hunk once its first-paint
/// deadline has passed; hunks it didn't start are tokenized in the
/// background into the cache, so a later plan has them and nothing a
/// reader has seen is recoloured.
///
/// The deadline is cooperative, not a timeout. Prism runs synchronously
/// and a single regex can't be interrupted, so a hunk started before the
/// deadline finishes after it. happy-app's worker is the same; only its UI
/// stops waiting at the second.
///
/// Call `colour` and `result` off the main thread.
public final class DiffSyntaxService: @unchecked Sendable {
    /// Background jobs past this are dropped, uncached.
    static let maxQueued = 64

    private struct JobKey: Hashable {
        let key: String
        let generation: UInt64
    }

    private struct Job {
        let identity: JobKey
        let input: DiffSyntax.Input
        let weight: Int
    }

    private let lock = NSLock()
    private let cache: DiffLRUCache<DiffSyntax.Result>
    private let queuePayloadLimit: Int
    private let queueCountLimit: Int
    private var queue: [Job] = []
    private var queued: Set<JobKey> = []
    private var active: Job?
    private var reservedBytes = 0
    private var generation: UInt64 = 0
    private var closed = false
    private var draining = false
    private let tokenize: @Sendable (DiffSyntax.Input) -> DiffSyntax.Result

    /// `tokenize` stands in for the tokenizer in tests.
    public init(
        queuePayloadLimit: Int = 4 * 1024 * 1024,
        queueCountLimit: Int = 64,
        resultPayloadLimit: Int = 4 * 1024 * 1024,
        resultCountLimit: Int = 512,
        tokenize: @escaping @Sendable (DiffSyntax.Input) -> DiffSyntax.Result = { DiffSyntax.tokenize($0) }
    ) {
        self.queuePayloadLimit = max(0, queuePayloadLimit)
        self.queueCountLimit = min(Self.maxQueued, max(0, queueCountLimit))
        cache = DiffLRUCache(limit: max(0, resultCountLimit), maxWeight: max(0, resultPayloadLimit))
        self.tokenize = tokenize
    }

    public var isClosed: Bool { lock.withLock { closed } }

    var retainedUsage: (results: Int, resultBytes: Int, jobs: Int, jobBytes: Int) {
        lock.withLock {
            let usage = cache.retainedUsage
            return (usage.count, usage.bytes, queued.count, reservedBytes)
        }
    }

    /// A finished result, without tokenizing.
    public func peek(_ key: String) -> DiffSyntax.Result? {
        lock.withLock { closed ? nil : cache.get(key) }
    }

    /// The cached result, or one tokenized now and kept.
    public func result(_ key: String, _ input: DiffSyntax.Input) -> DiffSyntax.Result {
        result(key, input, expectedGeneration: nil)
    }

    private func result(_ key: String, _ input: DiffSyntax.Input, expectedGeneration: UInt64?) -> DiffSyntax.Result {
        lock.lock()
        guard !closed, expectedGeneration == nil || generation == expectedGeneration else {
            lock.unlock()
            return DiffSyntax.Result(status: .limited)
        }
        if let cached = cache.get(key) { lock.unlock(); return cached }
        let startedGeneration = generation
        lock.unlock()
        let result = DiffSyntax.withinLimits(input) ? tokenize(input) : DiffSyntax.Result(status: .limited)
        remember(key, result, generation: startedGeneration)
        return result
    }

    /// usePreparedSyntax: `displayed` with the colours of every hunk they
    /// touch. A missing hunk is tokenized here if `deadline` hasn't passed
    /// when its turn comes; the ones after stay plain here and are
    /// tokenized in the background.
    public func colour(_ file: DiffFile, displayed: [DiffRow], until deadline: ContinuousClock.Instant) -> [DiffRow] {
        guard !isClosed else { return displayed }
        let hunks = DiffSyntaxPlan.plan(file, displayed: displayed)
        guard !hunks.isEmpty else { return displayed }
        var outcomes: [String: DiffSyntax.Result] = [:]
        var late: [(key: String, input: DiffSyntax.Input)] = []
        for hunk in hunks {
            if let cached = peek(hunk.key) {
                outcomes[hunk.key] = cached
            } else if ContinuousClock.now < deadline {
                outcomes[hunk.key] = result(hunk.key, hunk.input)
            } else {
                late.append((hunk.key, hunk.input))
            }
        }
        if !late.isEmpty { prefetch(late) }
        return DiffSyntaxPlan.apply(displayed, hunks: hunks, outcomes: outcomes)
    }

    /// useSyntaxExpansion's check: whether showing `rows` would tokenize
    /// anything, so "show more" shows its spinner while it does.
    public func isMissing(_ file: DiffFile, rows: [DiffRow]) -> Bool {
        guard !isClosed else { return false }
        return DiffSyntaxPlan.plan(file, displayed: rows).contains { peek($0.key) == nil }
    }

    /// Tokenizes `parts` one at a time in the background, into the cache.
    public func prefetch(_ parts: [(key: String, input: DiffSyntax.Input)]) {
        guard !isClosed else { return }
        let eligible = parts.compactMap { part -> (key: String, input: DiffSyntax.Input, weight: Int)? in
            guard DiffSyntax.withinLimits(part.input) else { return nil }
            let weight = Self.queueWeight(part.key, part.input)
            guard weight <= queuePayloadLimit else { return nil }
            return (part.key, part.input, weight)
        }
        lock.lock()
        guard !closed else { lock.unlock(); return }
        for part in eligible {
            let identity = JobKey(key: part.key, generation: generation)
            guard !queued.contains(identity), queued.count < queueCountLimit,
                  part.weight <= queuePayloadLimit - reservedBytes else { continue }
            queued.insert(identity)
            reservedBytes += part.weight
            queue.append(Job(identity: identity, input: part.input, weight: part.weight))
        }
        let start = !draining && !queue.isEmpty
        if start { draining = true }
        lock.unlock()
        guard start else { return }
        Task.detached(priority: .utility) { [self] in
            while let part = next() {
                _ = result(part.identity.key, part.input, expectedGeneration: part.identity.generation)
                done(part)
            }
        }
    }

    /// Waits for background work to finish (tests).
    public func idle() async {
        while isDraining {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    private var isDraining: Bool {
        lock.lock()
        defer { lock.unlock() }
        return draining
    }

    private func done(_ job: Job) {
        lock.lock()
        queued.remove(job.identity)
        if active?.identity == job.identity {
            active = nil
            reservedBytes -= job.weight
        }
        lock.unlock()
    }

    public func clearCache() {
        lock.withLock {
            generation &+= 1
            purgeQueuedWork()
            cache.clear()
        }
    }

    /// Permanently discards this owner's private cache and queued work. A
    /// synchronous tokenizer already running finishes without storing output.
    public func close() {
        lock.withLock {
            guard !closed else { return }
            closed = true
            generation &+= 1
            purgeQueuedWork()
            cache.clear()
        }
    }

    /// Called only while holding lock. The in-flight job stays charged until
    /// done, including when a reusable purge admits a new generation's jobs.
    private func purgeQueuedWork() {
        queue.removeAll()
        queued.removeAll()
        reservedBytes = active?.weight ?? 0
        if let active { queued.insert(active.identity) }
    }

    private func next() -> Job? {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, !queue.isEmpty else {
            draining = false
            return nil
        }
        let job = queue.removeFirst()
        active = job
        return job
    }

    private func remember(_ key: String, _ result: DiffSyntax.Result, generation startedGeneration: UInt64) {
        // The service never caches a reader's timeout: that says nothing
        // about the input. Results here are always the tokenizer's own.
        let runs = result.runs.reduce(0) { $0 + $1.count }
        lock.withLock {
            guard !closed, generation == startedGeneration else { return }
            cache.set(key, result, weight: key.utf16.count * 2 + runs * 48)
        }
    }

    private static func queueWeight(_ key: String, _ input: DiffSyntax.Input) -> Int {
        96 + (key.utf16.count + input.language.utf16.count) * 2
            + input.lines.reduce(0) { $0 + 64 + $1.text.utf16.count * 2 }
    }
}
