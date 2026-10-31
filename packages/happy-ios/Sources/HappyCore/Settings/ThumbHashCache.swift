import Foundation

/// Thumbhash placeholders as pictures, made the first time each is asked
/// for, on the thread that asks, and kept. A view asks while it is being
/// configured, so the placeholder is on screen in the first frame the view
/// is; scrolling back to it costs a lookup, not a decode.
///
/// One cache serves every account: a placeholder is a function of its hash
/// alone, so it says nothing the hash didn't. The decode is always the
/// hash's own 32 pixels on the long side, whatever size it is drawn at, so
/// the hash alone is the key. A hash that is not one is kept as nothing,
/// so it is not decoded again either. The least recently used go first.
public final class ThumbHashCache<Picture: AnyObject & Sendable>: @unchecked Sendable {
    public typealias Make = @Sendable (String) -> Picture?

    public static var defaultLimit: Int { 256 }

    private let lock = NSLock()
    private let limit: Int
    private let make: Make
    private var entries: [String: (picture: Picture?, use: UInt64)] = [:]
    private var uses: UInt64 = 0
    private var made = 0

    public init(limit: Int = defaultLimit, make: @escaping Make) {
        self.limit = max(1, limit)
        self.make = make
    }

    /// The placeholder for `thumbhash`, made now when it isn't kept; nil
    /// for no hash or one that is not a hash.
    public func picture(_ thumbhash: String?) -> Picture? {
        guard let thumbhash, !thumbhash.isEmpty else { return nil }
        if let kept = lookup(thumbhash) { return kept.picture }
        // Made outside the lock: two threads asking for the same new hash
        // at once both make it, and the second one made is kept.
        let picture = make(thumbhash)
        lock.lock()
        defer { lock.unlock() }
        made += 1
        uses += 1
        entries[thumbhash] = (picture, uses)
        if entries.count > limit, let oldest = entries.min(by: { $0.value.use < $1.value.use })?.key {
            entries.removeValue(forKey: oldest)
        }
        return picture
    }

    /// The placeholder only if it is already kept.
    public func cached(_ thumbhash: String?) -> Picture? {
        guard let thumbhash else { return nil }
        return lookup(thumbhash)?.picture
    }

    /// Lets every placeholder go (a memory warning).
    public func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
    }

    /// How many are kept, and how many were ever made, for tests.
    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    public var makes: Int {
        lock.lock()
        defer { lock.unlock() }
        return made
    }

    private func lookup(_ thumbhash: String) -> (picture: Picture?, use: UInt64)? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = entries[thumbhash] else { return nil }
        uses += 1
        entries[thumbhash]?.use = uses
        return entry
    }
}
