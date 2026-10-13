import Foundation
import HappyCrypto

/// The store's `sessionFileCache`: what each file looked like when last
/// read, so a revisit draws at once and refreshes behind it. One per
/// account (`AccountSession.fileCache`), never shared between accounts.
///
/// happy-app keeps it in memory only. Given a directory, this one also
/// keeps each read in the account's own files, so a file seen once shows
/// again after a relaunch, offline. Only files the person opened are kept:
/// nothing is fetched to fill it.
///   - In memory, the most recently used `maxCount` reads, at most
///     `maxCost` bytes of text; `get` reads only these, with no disk and
///     no SQL, so a screen can ask for it as it opens.
///   - On disk, the most recently used `maxFiles`, at most `maxDiskBytes`;
///     `snapshot` reads one off the main thread, once however many ask.
///     A read bigger than `maxEntryBytes` is shown but never written.
///   - Writes and reads run one at a time on the cache's own queue, in the
///     order they were asked for, so a later read always wins.
///   - `close()` lets everything go; once it returns nothing more is read
///     or written, so the account's directory can be removed.
public final class SessionFileCache: @unchecked Sendable {
    /// A session's root as it was when one of its files was last shown.
    public struct Root: Equatable, Sendable {
        public var path: String?

        public init(path: String?) {
            self.path = path
        }
    }

    public static let defaultMaxCount = 32
    public static let defaultMaxCost = 8 * 1024 * 1024
    public static let defaultMaxFiles = 256
    public static let defaultMaxDiskBytes = 64 * 1024 * 1024
    public static let defaultMaxEntryBytes = 4 * 1024 * 1024

    struct Key: Hashable, Sendable {
        var sessionId: String
        var path: String
    }

    private let lock = NSLock()
    private var memory: KeptFiles
    private var roots: [String: Root] = [:]
    private var reads: [Key: Task<FileViewer.Snapshot?, Never>] = [:]
    /// Keys set or removed while their disk read was under way: that read
    /// is older than what is kept now.
    private var overtaken: Set<Key> = []
    private var closed = false
    let disk: FileCacheDisk?

    /// Memory only, as happy-app's.
    public convenience init() {
        self.init(directory: nil)
    }

    /// The cache's directory inside an account's (`AccountSession
    /// .accountDirectory`).
    public static func directory(inAccount accountDirectory: URL) -> URL {
        accountDirectory.appendingPathComponent("file-cache", isDirectory: true)
    }

    /// Makes the directory, off the main thread, while the account is made
    /// ready (`AccountSession.prepareDirectory`), after the account's own
    /// directory; nothing if it is already there. The cache never makes it
    /// itself: without it nothing is written, so a signed-out account's
    /// directory is never made again.
    public static func prepare(directory: URL) throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }

    /// `directory` is the account's own, made ready by `prepare`; nil keeps
    /// nothing on disk.
    public init(
        directory: URL?,
        maxCount: Int = defaultMaxCount,
        maxCost: Int = defaultMaxCost,
        maxFiles: Int = defaultMaxFiles,
        maxDiskBytes: Int = defaultMaxDiskBytes,
        maxEntryBytes: Int = defaultMaxEntryBytes
    ) {
        memory = KeptFiles(maxCount: maxCount, maxCost: maxCost)
        disk = directory.map { FileCacheDisk(directory: $0, maxFiles: maxFiles, maxBytes: maxDiskBytes, maxEntryBytes: maxEntryBytes) }
    }

    public var isClosed: Bool {
        lock.withLock { closed }
    }

    // MARK: Roots

    /// The session's root when a file of it was last shown, so a revisit
    /// can find its cached copy before the store is read; nil if none was.
    public func root(sessionId: String) -> Root? {
        lock.withLock { closed ? nil : roots[sessionId] }
    }

    public func setRoot(sessionId: String, _ root: Root) {
        lock.withLock {
            guard !closed else { return }
            roots[sessionId] = root
        }
    }

    // MARK: Reads

    /// The read kept in memory, which counts as a use. Never touches the
    /// disk, so the main thread may ask.
    public func get(sessionId: String, path: String) -> FileViewer.Snapshot? {
        lock.withLock { closed ? nil : memory.get(Key(sessionId: sessionId, path: path)) }
    }

    /// The read kept in memory, else on disk (read off the main thread, and
    /// then kept in memory). Asks no computer for anything.
    public func snapshot(sessionId: String, path: String) async -> FileViewer.Snapshot? {
        let key = Key(sessionId: sessionId, path: path)
        let pending: Task<FileViewer.Snapshot?, Never>? = lock.withLock {
            guard !closed else { return nil }
            if memory.contains(key) { return nil }
            if let read = reads[key] { return read }
            guard let disk else { return nil }
            let read = Task.detached(priority: .userInitiated) { [self] in
                finishRead(key, await disk.read(key))
            }
            reads[key] = read
            return read
        }
        if let pending { return await pending.value }
        return get(sessionId: sessionId, path: path)
    }

    private func finishRead(_ key: Key, _ value: FileViewer.Snapshot?) -> FileViewer.Snapshot? {
        lock.withLock {
            reads[key] = nil
            guard !closed else { return nil }
            if overtaken.remove(key) != nil { return memory.get(key) }
            guard let value else { return nil }
            memory.set(key, value)
            return value
        }
    }

    // MARK: Writes

    /// Keeps a fresh read, in memory now and on disk behind it.
    public func set(sessionId: String, path: String, _ snapshot: FileViewer.Snapshot) {
        let key = Key(sessionId: sessionId, path: path)
        let disk: FileCacheDisk? = lock.withLock {
            guard !closed else { return nil }
            if reads[key] != nil { overtaken.insert(key) }
            memory.set(key, snapshot)
            return self.disk
        }
        disk?.write(key, snapshot)
    }

    /// Forgets every read of a deleted session (storage.ts `deleteSession`).
    public func removeSession(sessionId: String) {
        let disk: FileCacheDisk? = lock.withLock {
            guard !closed else { return nil }
            for key in reads.keys where key.sessionId == sessionId { overtaken.insert(key) }
            memory.removeAll { $0.sessionId == sessionId }
            roots[sessionId] = nil
            return self.disk
        }
        disk?.remove(sessionId: sessionId)
    }

    // MARK: Letting go

    /// The account is going: nothing is kept or shown from now on, and once
    /// this returns nothing more is read or written.
    public func close() async {
        let disk: FileCacheDisk? = lock.withLock {
            closed = true
            memory.removeAll { _ in true }
            roots.removeAll()
            overtaken.removeAll()
            return self.disk
        }
        await disk?.close()
    }

    // MARK: For tests

    var keptCount: Int { lock.withLock { memory.count } }
}

/// Reads by key, least recently used let go first.
private struct KeptFiles {
    let maxCount: Int
    let maxCost: Int
    private var entries: [SessionFileCache.Key: (snapshot: FileViewer.Snapshot, cost: Int, use: UInt64)] = [:]
    private var uses: UInt64 = 0
    private var cost = 0

    init(maxCount: Int, maxCost: Int) {
        self.maxCount = maxCount
        self.maxCost = maxCost
    }

    var count: Int { entries.count }

    func contains(_ key: SessionFileCache.Key) -> Bool { entries[key] != nil }

    mutating func get(_ key: SessionFileCache.Key) -> FileViewer.Snapshot? {
        guard let entry = entries[key] else { return nil }
        uses += 1
        entries[key]?.use = uses
        return entry.snapshot
    }

    mutating func set(_ key: SessionFileCache.Key, _ snapshot: FileViewer.Snapshot) {
        if let previous = entries.removeValue(forKey: key) { cost -= previous.cost }
        let size = snapshot.content.content.utf8.count + (snapshot.diff?.utf8.count ?? 0)
        // One read past the whole budget is shown, not kept.
        guard size <= maxCost else { return }
        uses += 1
        entries[key] = (snapshot, size, uses)
        cost += size
        while entries.count > maxCount || cost > maxCost {
            guard let oldest = entries.min(by: { $0.value.use < $1.value.use }) else { break }
            cost -= oldest.value.cost
            entries.removeValue(forKey: oldest.key)
        }
    }

    mutating func removeAll(where match: (SessionFileCache.Key) -> Bool) {
        for key in entries.keys where match(key) {
            if let entry = entries.removeValue(forKey: key) { cost -= entry.cost }
        }
    }
}

/// The account's file cache directory, touched only on its own serial
/// queue, off the main thread.
final class FileCacheDisk: @unchecked Sendable {
    private struct Entry: Codable {
        var version: Int
        var sessionId: String
        var path: String
        var content: String
        var isBinary: Bool
        var diff: String?
    }

    private static let version = 1
    let directory: URL
    private let maxFiles: Int
    private let maxBytes: Int
    private let maxEntryBytes: Int
    private let queue = DispatchQueue(label: "HappyCore.sessionFileCache", qos: .userInitiated)
    /// Confined to `queue`.
    private var closed = false
    private var readCount = 0

    init(directory: URL, maxFiles: Int, maxBytes: Int, maxEntryBytes: Int) {
        self.directory = directory
        self.maxFiles = maxFiles
        self.maxBytes = maxBytes
        self.maxEntryBytes = maxEntryBytes
    }

    /// A file's name: the session's and the path's SHA-256, so the name
    /// says nothing of either, and a session's files share a prefix.
    static func name(_ key: SessionFileCache.Key) -> String {
        prefix(key.sessionId) + hex(Hashing.sha256(Data(key.path.utf8))) + ".json"
    }

    private static func prefix(_ sessionId: String) -> String {
        hex(Hashing.sha256(Data(sessionId.utf8))) + "-"
    }

    private static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef")
        return String(data.flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 15)]] })
    }

    func read(_ key: SessionFileCache.Key) async -> FileViewer.Snapshot? {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.readNow(key)) }
        }
    }

    func write(_ key: SessionFileCache.Key, _ snapshot: FileViewer.Snapshot) {
        queue.async { self.writeNow(key, snapshot) }
    }

    func remove(sessionId: String) {
        queue.async {
            guard !self.closed else { return }
            let prefix = Self.prefix(sessionId)
            let manager = FileManager.default
            for name in (try? manager.contentsOfDirectory(atPath: self.directory.path)) ?? [] where name.hasPrefix(prefix) {
                try? manager.removeItem(at: self.directory.appendingPathComponent(name))
            }
        }
    }

    func close() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.closed = true
                continuation.resume()
            }
        }
    }

    /// Everything asked for so far has been done.
    func drain() async {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume() }
        }
    }

    /// Stops the queue until the returned closure is called.
    func hold() -> @Sendable () -> Void {
        let gate = DispatchSemaphore(value: 0)
        queue.async { gate.wait() }
        return { gate.signal() }
    }

    var reads: Int {
        get async {
            await withCheckedContinuation { continuation in
                queue.async { continuation.resume(returning: self.readCount) }
            }
        }
    }

    // MARK: On the queue

    private func readNow(_ key: SessionFileCache.Key) -> FileViewer.Snapshot? {
        guard !closed else { return nil }
        readCount += 1
        let file = directory.appendingPathComponent(Self.name(key))
        guard let data = try? Data(contentsOf: file) else { return nil }
        guard let entry = try? JSONDecoder().decode(Entry.self, from: data), entry.version == Self.version,
              entry.sessionId == key.sessionId, entry.path == key.path else {
            // Unreadable, from another version, or not this file.
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        // Recently used, for pruning.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return FileViewer.Snapshot(content: FileViewer.Content(content: entry.content, isBinary: entry.isBinary), diff: entry.diff)
    }

    private func writeNow(_ key: SessionFileCache.Key, _ snapshot: FileViewer.Snapshot) {
        guard !closed else { return }
        let manager = FileManager.default
        let file = directory.appendingPathComponent(Self.name(key))
        let entry = Entry(
            version: Self.version, sessionId: key.sessionId, path: key.path,
            content: snapshot.content.content, isBinary: snapshot.content.isBinary, diff: snapshot.diff
        )
        guard let data = try? JSONEncoder().encode(entry), data.count <= maxEntryBytes else {
            // Too big to keep: an older copy would come back stale.
            try? manager.removeItem(at: file)
            return
        }
        // Never made here: a directory that is gone (the account signed
        // out) stays gone, and nothing is written.
        guard manager.fileExists(atPath: directory.path) else { return }
        do { try data.write(to: file, options: .atomic) } catch { return }
        prune()
    }

    /// Keeps the most recently used, within `maxFiles` and `maxBytes`.
    private func prune() {
        let manager = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
        var dated = files.map { file -> (file: URL, date: Date, size: Int) in
            let values = try? file.resourceValues(forKeys: Set(keys))
            return (file, values?.contentModificationDate ?? .distantPast, values?.fileSize ?? 0)
        }
        var total = dated.reduce(0) { $0 + $1.size }
        guard dated.count > maxFiles || total > maxBytes else { return }
        dated.sort { $0.date < $1.date }
        var count = dated.count
        for entry in dated where count > maxFiles || total > maxBytes {
            try? manager.removeItem(at: entry.file)
            count -= 1
            total -= entry.size
        }
    }
}
