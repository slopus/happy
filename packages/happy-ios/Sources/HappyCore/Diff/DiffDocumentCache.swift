import Foundation

/// An explicit owner's documents. The limits bound an estimate of retained
/// source and render payload, rather than the process's resident memory.
/// Builds run outside the lock; closing rejects every late cache insertion.
public final class DiffDocumentCache: @unchecked Sendable {
    private enum Source: Equatable, Sendable {
        case patch(String)
        case contents(path: String, oldText: String, newText: String)

        var payloadBytes: Int {
            switch self {
            case .patch(let patch): return patch.utf16.count * 2
            case .contents(let path, let oldText, let newText):
                return (path.utf16.count + oldText.utf16.count + newText.utf16.count) * 2
            }
        }
    }

    private struct Entry {
        let source: Source
        let options: DiffEngine.Options
        let document: DiffDocument
    }

    private let lock = NSLock()
    private let cache: DiffLRUCache<Entry>
    private var generation: UInt64 = 0
    private var closed = false
    private let buildPatch: @Sendable (String, DiffEngine.Options) -> DiffDocument
    private let buildContents: @Sendable (String, String, String, DiffEngine.Options) -> DiffDocument

    public convenience init(countLimit: Int = 48, payloadLimit: Int = 16 * 1024 * 1024) {
        self.init(countLimit: countLimit, payloadLimit: payloadLimit,
                  buildPatch: { DiffEngine.buildUncached(patch: $0, options: $1) },
                  buildContents: { DiffEngine.buildUncached(path: $0, oldText: $1, newText: $2, options: $3) })
    }

    /// Builder injection makes a build held across a close deterministic.
    init(countLimit: Int, payloadLimit: Int,
         buildPatch: @escaping @Sendable (String, DiffEngine.Options) -> DiffDocument,
         buildContents: @escaping @Sendable (String, String, String, DiffEngine.Options) -> DiffDocument) {
        cache = DiffLRUCache(limit: max(0, countLimit), maxWeight: max(0, payloadLimit))
        self.buildPatch = buildPatch
        self.buildContents = buildContents
    }

    public var isClosed: Bool { lock.withLock { closed } }

    var retainedUsage: (count: Int, bytes: Int) { lock.withLock { cache.retainedUsage } }

    public func build(patch: String, options: DiffEngine.Options = .init()) -> DiffDocument {
        guard !isClosed else { return .empty }
        let source = Source.patch(patch)
        let key = DiffEngine.cacheKey("p", patch, options)
        return document(source, key: key, options: options) { buildPatch(patch, options) }
    }

    public func build(path: String, oldText: String, newText: String, options: DiffEngine.Options = .init()) -> DiffDocument {
        guard !isClosed else { return .empty }
        let source = Source.contents(path: path, oldText: oldText, newText: newText)
        let key = DiffEngine.cacheKey("c", "\(path)\u{0}\(oldText)\u{0}\(newText)", options)
        return document(source, key: key, options: options) { buildContents(path, oldText, newText, options) }
    }

    private func document(_ source: Source, key: String, options: DiffEngine.Options, build: () -> DiffDocument) -> DiffDocument {
        lock.lock()
        guard !closed else { lock.unlock(); return .empty }
        if let hit = cache.get(key), hit.source == source, hit.options == options {
            lock.unlock()
            return hit.document
        }
        let startedGeneration = generation
        lock.unlock()
        let document = build()
        guard document.error == nil else { return document }
        let weight = source.payloadBytes + key.utf16.count * 2 + Self.payloadBytes(document)
        lock.withLock {
            guard !closed, generation == startedGeneration else { return }
            cache.set(key, Entry(source: source, options: options, document: document), weight: weight)
        }
        return document
    }

    /// A reusable purge also invalidates builds that were already running.
    public func clearCache() {
        lock.withLock {
            generation &+= 1
            cache.clear()
        }
    }

    /// Permanent for this owner. Calling build afterwards returns no content.
    public func close() {
        lock.withLock {
            guard !closed else { return }
            closed = true
            generation &+= 1
            cache.clear()
        }
    }

    private static func payloadBytes(_ document: DiffDocument) -> Int {
        func text(_ value: String?) -> Int { (value?.utf16.count ?? 0) * 2 }
        var bytes = 128 + text(document.error)
        for file in document.files {
            bytes += 128 + text(file.path) + text(file.oldPath) + text(file.language)
            for row in file.rows {
                switch row {
                case .line(let line):
                    bytes += 128 + text(line.key) + text(line.text)
                    for span in line.spans { bytes += 48 + text(span.text) }
                case .hunk(let hunk):
                    bytes += 96 + text(hunk.key) + text(hunk.text) + text(hunk.section)
                case .message(let key, _): bytes += 48 + text(key)
                }
            }
        }
        return bytes
    }
}