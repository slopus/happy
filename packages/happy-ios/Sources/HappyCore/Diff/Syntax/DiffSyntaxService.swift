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
    public static let shared = DiffSyntaxService()

    /// Background jobs past this are dropped, uncached.
    static let maxQueued = 64

    private let lock = NSLock()
    private let cache = DiffLRUCache<DiffSyntax.Result>(limit: 512, maxWeight: 4 * 1024 * 1024)
    private var queue: [(key: String, input: DiffSyntax.Input)] = []
    private var queued: Set<String> = []
    private var draining = false
    private let tokenize: @Sendable (DiffSyntax.Input) -> DiffSyntax.Result

    /// `tokenize` stands in for the tokenizer in tests.
    public init(tokenize: @escaping @Sendable (DiffSyntax.Input) -> DiffSyntax.Result = { DiffSyntax.tokenize($0) }) {
        self.tokenize = tokenize
    }

    /// A finished result, without tokenizing.
    public func peek(_ key: String) -> DiffSyntax.Result? {
        cache.get(key)
    }

    /// The cached result, or one tokenized now and kept.
    public func result(_ key: String, _ input: DiffSyntax.Input) -> DiffSyntax.Result {
        if let cached = cache.get(key) { return cached }
        let result = DiffSyntax.withinLimits(input) ? tokenize(input) : DiffSyntax.Result(status: .limited)
        remember(key, result)
        return result
    }

    /// usePreparedSyntax: `displayed` with the colours of every hunk they
    /// touch. A missing hunk is tokenized here if `deadline` hasn't passed
    /// when its turn comes; the ones after stay plain here and are
    /// tokenized in the background.
    public func colour(_ file: DiffFile, displayed: [DiffRow], until deadline: ContinuousClock.Instant) -> [DiffRow] {
        let hunks = DiffSyntaxPlan.plan(file, displayed: displayed)
        guard !hunks.isEmpty else { return displayed }
        var outcomes: [String: DiffSyntax.Result] = [:]
        var late: [(key: String, input: DiffSyntax.Input)] = []
        for hunk in hunks {
            if let cached = cache.get(hunk.key) {
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
        DiffSyntaxPlan.plan(file, displayed: rows).contains { cache.get($0.key) == nil }
    }

    /// Tokenizes `parts` one at a time in the background, into the cache.
    public func prefetch(_ parts: [(key: String, input: DiffSyntax.Input)]) {
        lock.lock()
        for part in parts where !queued.contains(part.key) && queue.count < Self.maxQueued {
            queued.insert(part.key)
            queue.append(part)
        }
        let start = !draining && !queue.isEmpty
        if start { draining = true }
        lock.unlock()
        guard start else { return }
        Task.detached(priority: .utility) { [self] in
            while let part = next() {
                _ = result(part.key, part.input)
                done(part.key)
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

    private func done(_ key: String) {
        lock.lock()
        queued.remove(key)
        lock.unlock()
    }

    public func clearCache() {
        cache.clear()
    }

    private func next() -> (key: String, input: DiffSyntax.Input)? {
        lock.lock()
        defer { lock.unlock() }
        guard !queue.isEmpty else {
            draining = false
            return nil
        }
        return queue.removeFirst()
    }

    private func remember(_ key: String, _ result: DiffSyntax.Result) {
        // The service never caches a reader's timeout: that says nothing
        // about the input. Results here are always the tokenizer's own.
        let runs = result.runs.reduce(0) { $0 + $1.count }
        cache.set(key, result, weight: key.utf16.count * 2 + runs * 48)
    }
}
