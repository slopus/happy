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
///     A read bigger than `maxEntryBytes` is shown but never written, and
///     a file on disk bigger than that is never read. At most
///     `maxPendingReads` files are being read at once; a read asked for
///     past that is a miss, and the screen asks the computer.
///   - Writes and reads run one at a time on the cache's own queue, and a
///     read sees every write asked for before it. Writes waiting for the
///     queue are one per file, the newest; at most `maxPendingBytes` of
///     text wait (older waiting writes give way, and their file's older
///     copy goes, so it never comes back stale) and at most
///     `maxPendingChanges` files or sessions (past that, the directory is
///     emptied before what comes next is written).
///   - A session's root is kept for the `maxRoots` most recently used.
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
    public static let defaultMaxPendingBytes = 8 * 1024 * 1024
    public static let defaultMaxPendingChanges = 64
    public static let defaultMaxRoots = 256
    public static let defaultMaxPendingReads = 8

    struct Key: Hashable, Sendable {
        var sessionId: String
        var path: String
    }

    private let lock = NSLock()
    private var memory: KeptFiles
    private var roots: KeptRoots
    private var reads: [Key: Task<FileViewer.Snapshot?, Never>] = [:]
    /// Keys set or removed while their disk read was under way: that read
    /// is older than what is kept now.
    private var overtaken: Set<Key> = []
    private var closed = false
    private let maxPendingReads: Int
    #if DEBUG
    /// Callers that have waited on a disk read so far, joined or started;
    /// for tests that hold the disk. Counted under `lock`.
    private var diskWaits = 0
    #endif
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
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
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
        maxEntryBytes: Int = defaultMaxEntryBytes,
        maxPendingBytes: Int = defaultMaxPendingBytes,
        maxPendingChanges: Int = defaultMaxPendingChanges,
        maxRoots: Int = defaultMaxRoots,
        maxPendingReads: Int = defaultMaxPendingReads
    ) {
        self.maxPendingReads = max(1, maxPendingReads)
        memory = KeptFiles(maxCount: maxCount, maxCost: maxCost)
        roots = KeptRoots(maxCount: maxRoots)
        disk = directory.map {
            FileCacheDisk(
                directory: $0, maxFiles: maxFiles, maxBytes: maxDiskBytes, maxEntryBytes: maxEntryBytes,
                maxPendingBytes: maxPendingBytes, maxPendingChanges: maxPendingChanges
            )
        }
    }

    public var isClosed: Bool {
        lock.withLock { closed }
    }

    // MARK: Roots

    /// The session's root when a file of it was last shown, so a revisit
    /// can find its cached copy before the store is read; nil if none was.
    public func root(sessionId: String) -> Root? {
        lock.withLock { closed ? nil : roots.get(sessionId) }
    }

    public func setRoot(sessionId: String, _ root: Root) {
        lock.withLock {
            guard !closed else { return }
            roots.set(sessionId, root)
        }
    }

    // MARK: Reads

    /// The read kept in memory, which counts as a use. Never touches the
    /// disk, so the main thread may ask.
    public func get(sessionId: String, path: String) -> FileViewer.Snapshot? {
        lock.withLock { closed ? nil : memory.get(Key(sessionId: sessionId, path: path)) }
    }

    /// The read kept in memory, else on disk (read off the main thread, and
    /// then kept in memory). Asks no computer for anything. With
    /// `maxPendingReads` other files being read already, only memory.
    public func snapshot(sessionId: String, path: String) async -> FileViewer.Snapshot? {
        let key = Key(sessionId: sessionId, path: path)
        let pending: Task<FileViewer.Snapshot?, Never>? = lock.withLock {
            guard !closed else { return nil }
            if memory.contains(key) { return nil }
            if let read = reads[key] {
                #if DEBUG
                diskWaits += 1
                #endif
                return read
            }
            guard let disk, reads.count < maxPendingReads else { return nil }
            #if DEBUG
            diskWaits += 1
            #endif
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
            roots.remove(sessionId)
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
    var rootCount: Int { lock.withLock { roots.count } }
    var pendingReadCount: Int { lock.withLock { reads.count } }
    #if DEBUG
    var diskWaitCount: Int { lock.withLock { diskWaits } }
    #endif
}

/// Sessions' roots, least recently used let go first.
private struct KeptRoots {
    let maxCount: Int
    private var entries: [String: (root: SessionFileCache.Root, use: UInt64)] = [:]
    private var uses: UInt64 = 0

    init(maxCount: Int) {
        self.maxCount = max(0, maxCount)
    }

    var count: Int { entries.count }

    mutating func get(_ sessionId: String) -> SessionFileCache.Root? {
        guard let entry = entries[sessionId] else { return nil }
        uses += 1
        entries[sessionId]?.use = uses
        return entry.root
    }

    mutating func set(_ sessionId: String, _ root: SessionFileCache.Root) {
        uses += 1
        entries[sessionId] = (root, uses)
        while entries.count > maxCount {
            guard let oldest = entries.min(by: { $0.value.use < $1.value.use }) else { break }
            entries.removeValue(forKey: oldest.key)
        }
    }

    mutating func remove(_ sessionId: String) {
        entries[sessionId] = nil
    }

    mutating func removeAll() {
        entries.removeAll()
    }
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

/// What the disk queue has yet to do, coalesced and bounded: one change
/// per file, the newest; a deleted session's files; or, past
/// `maxChanges`, emptying the directory. Done in that order (empty,
/// sessions, files), which keeps the order they were asked in: a change
/// asked for before a session went or the directory was emptied was
/// dropped then.
struct PendingDiskWork {
    enum Change: Equatable {
        case write(FileViewer.Snapshot, cost: Int)
        /// The file goes: its newest read can't be written, and an older
        /// copy would come back stale.
        case remove
    }

    enum Work: Equatable {
        case clear
        case removeSession(String)
        case change(SessionFileCache.Key, Change)
    }

    let maxBytes: Int
    let maxChanges: Int
    private(set) var clearsAll = false
    private(set) var removedSessions: Set<String> = []
    private var changes: [SessionFileCache.Key: (change: Change, order: UInt64)] = [:]
    private var order: UInt64 = 0
    /// The text the waiting writes hold.
    private(set) var bytes = 0

    init(maxBytes: Int, maxChanges: Int) {
        self.maxBytes = max(0, maxBytes)
        self.maxChanges = max(1, maxChanges)
    }

    var count: Int { changes.count + removedSessions.count }
    var isEmpty: Bool { !clearsAll && count == 0 }

    mutating func set(_ key: SessionFileCache.Key, _ change: Change) {
        drop(key)
        if count >= maxChanges { clearAll() }
        order += 1
        changes[key] = (change, order)
        if case .write(_, let cost) = change { bytes += cost }
        // The oldest waiting writes give way, the newest last.
        while bytes > maxBytes {
            guard let oldest = changes.filter({ if case .write = $0.value.change { true } else { false } })
                .min(by: { $0.value.order < $1.value.order })
            else { break }
            drop(oldest.key)
            changes[oldest.key] = (.remove, oldest.value.order)
        }
    }

    mutating func removeSession(_ sessionId: String) {
        for key in changes.keys where key.sessionId == sessionId { drop(key) }
        // Emptying the directory takes the session's files with it.
        guard !clearsAll else { return }
        if count >= maxChanges {
            clearAll()
            return
        }
        removedSessions.insert(sessionId)
    }

    mutating func next() -> Work? {
        if clearsAll {
            clearsAll = false
            return .clear
        }
        if let sessionId = removedSessions.popFirst() { return .removeSession(sessionId) }
        guard let first = changes.min(by: { $0.value.order < $1.value.order }) else { return nil }
        drop(first.key)
        return .change(first.key, first.value.change)
    }

    /// Everything waiting goes, and the directory is emptied first.
    private mutating func clearAll() {
        clearsAll = true
        changes.removeAll()
        removedSessions.removeAll()
        bytes = 0
    }

    private mutating func drop(_ key: SessionFileCache.Key) {
        guard let previous = changes.removeValue(forKey: key) else { return }
        if case .write(_, let cost) = previous.change { bytes -= cost }
    }
}

/// The account's file cache directory, touched only on its own serial
/// queue, off the main thread. What waits for the queue is
/// `PendingDiskWork`, bounded; the queue takes it one change at a time.
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
    private let lock = NSLock()
    /// Under `lock`.
    private var pending: PendingDiskWork
    private var flushQueued = false
    private var accepting = true
    /// Confined to `queue`.
    private var closed = false
    #if DEBUG
    /// Reads and writes done, for tests; confined to `queue`.
    private var readCount = 0
    private var writeCount = 0
    #endif

    init(directory: URL, maxFiles: Int, maxBytes: Int, maxEntryBytes: Int, maxPendingBytes: Int, maxPendingChanges: Int) {
        self.directory = directory
        self.maxFiles = maxFiles
        self.maxBytes = maxBytes
        self.maxEntryBytes = maxEntryBytes
        pending = PendingDiskWork(maxBytes: maxPendingBytes, maxChanges: maxPendingChanges)
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

    /// The text a read holds, as the memory budget counts it.
    static func cost(_ snapshot: FileViewer.Snapshot) -> Int {
        snapshot.content.content.utf8.count + (snapshot.diff?.utf8.count ?? 0)
    }

    func read(_ key: SessionFileCache.Key) async -> FileViewer.Snapshot? {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.readNow(key)) }
        }
    }

    func write(_ key: SessionFileCache.Key, _ snapshot: FileViewer.Snapshot) {
        let cost = Self.cost(snapshot)
        // Too big to keep: written as a removal, so an older copy goes.
        let change: PendingDiskWork.Change = cost <= maxEntryBytes ? .write(snapshot, cost: cost) : .remove
        enqueue { $0.set(key, change) }
    }

    func remove(sessionId: String) {
        enqueue { $0.removeSession(sessionId) }
    }

    private func enqueue(_ change: (inout PendingDiskWork) -> Void) {
        lock.withLock {
            guard accepting else { return }
            change(&pending)
            guard !flushQueued else { return }
            flushQueued = true
            queue.async { self.flush() }
        }
    }

    /// Writes everything asked for before, then nothing more.
    func close() async {
        lock.withLock { accepting = false }
        await withCheckedContinuation { continuation in
            queue.async {
                self.flush()
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

    #if DEBUG
    var reads: Int {
        get async { await onQueue { self.readCount } }
    }

    var writes: Int {
        get async { await onQueue { self.writeCount } }
    }
    #endif

    /// Whether it still takes writes; false once `close` has begun.
    var isAccepting: Bool {
        lock.withLock { accepting }
    }

    /// What waits for the queue now: files and sessions, and the text held.
    var waiting: (count: Int, bytes: Int) {
        lock.withLock { (pending.count, pending.bytes) }
    }

    private func onQueue<T: Sendable>(_ value: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: value()) }
        }
    }

    // MARK: On the queue

    /// Does what waits, one change at a time, so whatever is asked for
    /// meanwhile still coalesces; then prunes once.
    private func flush() {
        var wrote = false
        while let work = lock.withLock({ () -> PendingDiskWork.Work? in
            if let work = pending.next() { return work }
            flushQueued = false
            return nil
        }) {
            guard !closed else { continue }
            switch work {
            case .clear: clearNow()
            case .removeSession(let sessionId): removeNow(sessionId: sessionId)
            case .change(let key, .remove): try? FileManager.default.removeItem(at: directory.appendingPathComponent(Self.name(key)))
            case .change(let key, .write(let snapshot, _)): if writeNow(key, snapshot) { wrote = true }
            }
        }
        if wrote { prune() }
    }

    private func readNow(_ key: SessionFileCache.Key) -> FileViewer.Snapshot? {
        guard !closed else { return nil }
        #if DEBUG
        readCount += 1
        #endif
        let file = directory.appendingPathComponent(Self.name(key))
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return nil }
        guard size <= maxEntryBytes else {
            // Never written this big: not this cache's.
            try? FileManager.default.removeItem(at: file)
            return nil
        }
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

    private func writeNow(_ key: SessionFileCache.Key, _ snapshot: FileViewer.Snapshot) -> Bool {
        let manager = FileManager.default
        let file = directory.appendingPathComponent(Self.name(key))
        let entry = Entry(
            version: Self.version, sessionId: key.sessionId, path: key.path,
            content: snapshot.content.content, isBinary: snapshot.content.isBinary, diff: snapshot.diff
        )
        guard let data = try? JSONEncoder().encode(entry), data.count <= maxEntryBytes else {
            // Too big to keep: an older copy would come back stale.
            try? manager.removeItem(at: file)
            return false
        }
        // Never made here: a directory that is gone (the account signed
        // out) stays gone, and nothing is written.
        guard manager.fileExists(atPath: directory.path) else { return false }
        do { try data.write(to: file, options: .atomic) } catch { return false }
        #if DEBUG
        writeCount += 1
        #endif
        return true
    }

    private func removeNow(sessionId: String) {
        let prefix = Self.prefix(sessionId)
        let manager = FileManager.default
        for name in (try? manager.contentsOfDirectory(atPath: directory.path)) ?? [] where name.hasPrefix(prefix) {
            try? manager.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    private func clearNow() {
        let manager = FileManager.default
        for name in (try? manager.contentsOfDirectory(atPath: directory.path)) ?? [] {
            try? manager.removeItem(at: directory.appendingPathComponent(name))
        }
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
