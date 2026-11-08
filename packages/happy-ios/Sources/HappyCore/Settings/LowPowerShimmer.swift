import Foundation

/// Settings › Appearance › Shimmer in Low Power Mode. In Low Power Mode a
/// shimmer holds still, as with Reduce Motion: a sweep has the screen
/// composed again every frame it runs. This brings it back. The braille
/// loader is apart from it and moves either way.
public struct LowPowerShimmer: Sendable {
    public static let key = "shimmer-in-low-power-mode"
    /// Its own defaults suite: Low Power Mode is the phone's, so this
    /// belongs to the device, not to an account.
    public static let suiteName = "motion"

    private let storage: KeyValueStore

    public init(storage: KeyValueStore) {
        self.storage = storage
    }

    /// Off unless turned on.
    public var isEnabled: Bool {
        get { storage.string(forKey: Self.key) == "true" }
        nonmutating set { storage.set(newValue ? "true" : nil, forKey: Self.key) }
    }

    /// Whether a shimmer holds still: always with Reduce Motion; in Low
    /// Power Mode unless this is on.
    public static func holdsStill(reduceMotion: Bool, lowPower: Bool, shimmersInLowPower: Bool) -> Bool {
        reduceMotion || (lowPower && !shimmersInLowPower)
    }
}
