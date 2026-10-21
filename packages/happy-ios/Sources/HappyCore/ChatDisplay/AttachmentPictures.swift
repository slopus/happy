import Foundation

/// useAttachmentImage's cache, for one account: the session pictures it has
/// decoded, by session and ref, and the markdown images it has fetched, by
/// URL, kept while they fit in `maxCount` pictures and `maxCost` bytes, the
/// least recently used let go first. One load per picture at a time; a
/// failed load is not kept, so the next screen tries again.
///
/// `AccountSession` owns it, so pictures are never shared between accounts
/// and go with the account when it is switched away from or signed out.
@MainActor
public final class AttachmentPictures {
    /// A decoded picture; HappyUI's are UIImages.
    public typealias Picture = AnyObject & Sendable

    public struct Key: Hashable, Sendable {
        public var sessionId: String
        public var ref: String

        public init(sessionId: String, ref: String) {
            self.sessionId = sessionId
            self.ref = ref
        }

        /// A markdown image: its URL, in no session, so never one of a
        /// session's attachments.
        public static func web(_ url: String) -> Key {
            Key(sessionId: "", ref: url)
        }
    }

    /// `MAX_CACHE_ENTRIES`.
    public nonisolated static let defaultMaxCount = 50
    /// Decoded, a picture can take a few megabytes where useAttachmentImage
    /// keeps a data URI, so this bounds bytes as well.
    public nonisolated static let defaultMaxCost = 48 * 1024 * 1024

    public nonisolated let maxCount: Int
    public nonisolated let maxCost: Int
    private var entries: [Key: (picture: Picture, cost: Int, use: UInt64)] = [:]
    private var inFlight: [Key: Task<(picture: Picture, cost: Int)?, Never>] = [:]
    private var uses: UInt64 = 0
    public private(set) var totalCost = 0

    public nonisolated init(maxCount: Int = defaultMaxCount, maxCost: Int = defaultMaxCost) {
        self.maxCount = maxCount
        self.maxCost = maxCost
    }

    public var count: Int { entries.count }

    /// The kept picture, which counts as a use.
    public func cached(_ key: Key) -> Picture? {
        guard let entry = entries[key] else { return nil }
        uses += 1
        entries[key] = (entry.picture, entry.cost, uses)
        return entry.picture
    }

    /// The picture, kept or loaded; nil when `load` couldn't make it. A
    /// load already on its way for `key` is shared.
    public func picture(_ key: Key, load: @escaping @Sendable () async -> (picture: Picture, cost: Int)?) async -> Picture? {
        if let picture = cached(key) { return picture }
        if let task = inFlight[key] { return await task.value?.picture }
        let task = Task.detached(priority: .userInitiated) { await load() }
        inFlight[key] = task
        let loaded = await task.value
        inFlight[key] = nil
        guard let loaded else { return nil }
        remember(key, loaded.picture, cost: loaded.cost)
        return loaded.picture
    }

    /// Lets every picture go (a memory warning).
    public func removeAll() {
        entries.removeAll()
        totalCost = 0
    }

    private func remember(_ key: Key, _ picture: Picture, cost: Int) {
        if let previous = entries.removeValue(forKey: key) { totalCost -= previous.cost }
        // One picture past the whole budget is shown, not kept.
        guard cost <= maxCost else { return }
        uses += 1
        entries[key] = (picture, cost, uses)
        totalCost += cost
        while entries.count > maxCount || totalCost > maxCost {
            guard let oldest = entries.min(by: { $0.value.use < $1.value.use }) else { break }
            totalCost -= oldest.value.cost
            entries.removeValue(forKey: oldest.key)
        }
    }
}
