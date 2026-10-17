import Foundation
import HappyCrypto

/// One account's profile pictures (expo-image's memory and disk cache) and
/// thumbhash placeholders: decoded pictures kept while they fit in a few
/// pictures and bytes, the least recently used let go first, and fetched
/// bytes kept in the account's own `pictures/` directory so a picture seen
/// once shows offline. One load per picture at a time; a failed one is not
/// kept, so the next screen tries again.
///
/// Every account, active or not, has its own (`AccountController.pictures
/// (for:)`), so the same URL or thumbhash in two accounts is two pictures
/// and nothing of one account's is ever drawn for another. Fetching,
/// reading, writing and decoding all happen off the main thread.
@MainActor
public final class AccountPictures {
    /// A decoded picture; HappyUI's are UIImages.
    public typealias Picture = AnyObject & Sendable
    /// A picture's bytes, at most `limit` of them; nil when it can't be had.
    public typealias Fetch = @Sendable (_ url: URL, _ limit: Int) async -> Data?
    /// Bytes or a thumbhash as a picture, and what it costs to keep.
    public typealias Decode<Input> = @Sendable (Input) -> (picture: Picture, cost: Int)?

    /// The most a picture may be: no profile picture comes close.
    public nonisolated static let maxBytes = 10 * 1024 * 1024
    public nonisolated static let defaultMaxCount = 16
    public nonisolated static let defaultMaxCost = 8 * 1024 * 1024
    public nonisolated static let defaultMaxFiles = 32
    public nonisolated static let defaultMaxPlaceholders = 128

    /// The account these are, an `AccountSummary.ID`.
    public nonisolated let owner: String
    private let files: PictureFiles
    private let fetch: Fetch
    private var pictures: KeptPictures
    private var placeholders: KeptPictures
    private var inFlight: [Slot: (generation: UInt64, task: Task<Loaded?, Never>)] = [:]
    /// Moves on when everything kept is let go, so a load that started
    /// before is shown but not kept.
    private var generation: UInt64 = 0
    public private(set) var isClosed = false

    private typealias Loaded = (picture: Picture, cost: Int)

    private enum Slot: Hashable {
        case picture(String)
        case placeholder(String)
    }

    /// `directory` is the account's own `pictures/`, made on the first
    /// write but never its parent; nil keeps nothing on disk.
    public nonisolated init(
        owner: String,
        directory: URL?,
        fetch: @escaping Fetch,
        maxCount: Int = defaultMaxCount,
        maxCost: Int = defaultMaxCost,
        maxFiles: Int = defaultMaxFiles,
        maxPlaceholders: Int = defaultMaxPlaceholders
    ) {
        self.owner = owner
        self.files = PictureFiles(directory: directory, maxFiles: maxFiles)
        self.fetch = fetch
        self.pictures = KeptPictures(maxCount: maxCount, maxCost: maxCost)
        self.placeholders = KeptPictures(maxCount: maxPlaceholders, maxCost: .max)
    }

    /// Only http(s) pictures are fetched; a `file:` or other URL from a
    /// profile is never read.
    public nonisolated static func isFetchable(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    // MARK: Pictures

    /// The kept picture, which counts as a use.
    public func cached(_ url: URL) -> Picture? {
        pictures.get(url.absoluteString)
    }

    public func cached(key: String) -> Picture? { pictures.get(key) }

    /// Private artwork uses an opaque identity and an authenticated loader.
    /// Disk contains encrypted bytes; decryption/decoding run off main on
    /// both the offline and network paths.
    public func picture(key: String, fetch: @escaping @Sendable () async -> Data?, decode: @escaping Decode<Data>) async -> Picture? {
        let files = self.files
        return await load(.picture(key)) {
            let name = PictureFiles.name(key)
            if let data = await files.read(name), let loaded = decode(data) { return loaded }
            guard !Task.isCancelled, let data = await fetch(), data.count <= Self.maxBytes,
                  let loaded = decode(data), !Task.isCancelled else { return nil }
            await files.write(data, name)
            return loaded
        }
    }

    /// The picture at `url`: kept, else from disk, else fetched (and then
    /// written to disk), and decoded by `decode`. Nil when it can't be had.
    /// Every caller of one cache should decode the same way: the first
    /// decode is the one kept.
    public func picture(_ url: URL, decode: @escaping Decode<Data>) async -> Picture? {
        guard Self.isFetchable(url) else { return nil }
        let key = url.absoluteString
        let files = self.files
        let fetch = self.fetch
        return await load(.picture(key)) {
            let name = PictureFiles.name(key)
            if let data = await files.read(name), let loaded = decode(data) {
                return loaded
            }
            guard !Task.isCancelled, let data = await fetch(url, Self.maxBytes), data.count <= Self.maxBytes,
                  let loaded = decode(data) else { return nil }
            await files.write(data, name)
            return loaded
        }
    }

    // MARK: Placeholders

    /// The kept placeholder for a thumbhash, which counts as a use.
    public func cachedPlaceholder(_ thumbhash: String) -> Picture? {
        placeholders.get(thumbhash)
    }

    /// The thumbhash as a picture, made by `make` off the main thread.
    public func placeholder(_ thumbhash: String, make: @escaping Decode<String>) async -> Picture? {
        await load(.placeholder(thumbhash)) { make(thumbhash) }
    }

    // MARK: Letting go

    /// Lets every picture go (a memory warning). Files stay.
    public func removeAll() {
        generation &+= 1
        pictures.removeAll()
        placeholders.removeAll()
        inFlight.removeAll()
    }

    /// The account is going: nothing is kept or shown from now on, loads on
    /// their way are cancelled, and once this returns nothing more is
    /// written, so the account's directory can be removed.
    public func close() async {
        isClosed = true
        generation &+= 1
        pictures.removeAll()
        placeholders.removeAll()
        for entry in inFlight.values { entry.task.cancel() }
        inFlight.removeAll()
        await files.close()
    }

    private func load(_ slot: Slot, _ work: @escaping @Sendable () async -> Loaded?) async -> Picture? {
        guard !isClosed else { return nil }
        if let picture = kept(slot) { return picture }
        if let entry = inFlight[slot] {
            let picture = await entry.task.value?.picture
            return isClosed ? nil : picture
        }
        let generation = self.generation
        let task = Task.detached(priority: .utility) { await work() }
        inFlight[slot] = (generation, task)
        let loaded = await task.value
        guard !isClosed else { return nil }
        guard generation == self.generation else { return loaded?.picture }
        inFlight[slot] = nil
        guard let loaded else { return nil }
        switch slot {
        case .picture(let key): pictures.set(key, loaded.picture, cost: loaded.cost)
        case .placeholder(let key): placeholders.set(key, loaded.picture, cost: loaded.cost)
        }
        return loaded.picture
    }

    private func kept(_ slot: Slot) -> Picture? {
        switch slot {
        case .picture(let key): pictures.get(key)
        case .placeholder(let key): placeholders.get(key)
        }
    }

    // MARK: Kept counts, for tests

    var keptCount: Int { pictures.count }
    var keptPlaceholderCount: Int { placeholders.count }
    var keptCost: Int { pictures.cost }
}

/// Decoded pictures by key, least recently used let go first.
private struct KeptPictures {
    let maxCount: Int
    let maxCost: Int
    private var entries: [String: (picture: AccountPictures.Picture, cost: Int, use: UInt64)] = [:]
    private var uses: UInt64 = 0
    private(set) var cost = 0

    init(maxCount: Int, maxCost: Int) {
        self.maxCount = maxCount
        self.maxCost = maxCost
    }

    var count: Int { entries.count }

    mutating func get(_ key: String) -> AccountPictures.Picture? {
        guard let entry = entries[key] else { return nil }
        uses += 1
        entries[key]?.use = uses
        return entry.picture
    }

    mutating func set(_ key: String, _ picture: AccountPictures.Picture, cost: Int) {
        if let previous = entries.removeValue(forKey: key) { self.cost -= previous.cost }
        // One picture past the whole budget is shown, not kept.
        guard cost <= maxCost else { return }
        uses += 1
        entries[key] = (picture, cost, uses)
        self.cost += cost
        while entries.count > maxCount || self.cost > maxCost {
            guard let oldest = entries.min(by: { $0.value.use < $1.value.use }) else { break }
            self.cost -= oldest.value.cost
            entries.removeValue(forKey: oldest.key)
        }
    }

    mutating func removeAll() {
        entries.removeAll()
        cost = 0
    }
}

/// The account's `pictures/` directory, touched only off the main thread
/// and one call at a time, so `close()` returning means no write is under
/// way or still to come.
actor PictureFiles {
    private let directory: URL?
    private let maxFiles: Int
    private var closed = false

    init(directory: URL?, maxFiles: Int) {
        self.directory = directory
        self.maxFiles = maxFiles
    }

    /// A picture's file: its URL's SHA-256, so the name says nothing of it.
    nonisolated static func name(_ key: String) -> String {
        let digits = Array("0123456789abcdef")
        return String(Hashing.sha256(Data(key.utf8)).flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 15)]] })
    }

    func read(_ name: String) -> Data? {
        guard !closed, let directory else { return nil }
        let file = directory.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: file) else { return nil }
        // Recently used, for pruning.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return data
    }

    func write(_ data: Data, _ name: String) {
        guard !closed, let directory else { return }
        let manager = FileManager.default
        // Never with its parents: an account directory that is gone (the
        // account signed out) stays gone.
        if !manager.fileExists(atPath: directory.path) {
            do { try manager.createDirectory(at: directory, withIntermediateDirectories: false) } catch { return }
        }
        do { try data.write(to: directory.appendingPathComponent(name), options: .atomic) } catch { return }
        prune(directory)
    }

    func close() {
        closed = true
    }

    /// Keeps the `maxFiles` most recently used.
    private func prune(_ directory: URL) {
        let manager = FileManager.default
        let key = URLResourceKey.contentModificationDateKey
        guard let files = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [key], options: [.skipsHiddenFiles]),
              files.count > maxFiles else { return }
        let dated = files.map { file in
            (file, (try? file.resourceValues(forKeys: [key]).contentModificationDate) ?? .distantPast)
        }
        for (file, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - maxFiles) {
            try? manager.removeItem(at: file)
        }
    }
}
