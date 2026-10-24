import Foundation

/// Whether home shows the Stem Cells sidebar instead of the session list.
/// It is this phone's own choice, never synced, and exists only in
/// development and preview builds: a production build cannot reach it,
/// whatever is stored.
public struct StemCellsPreference: Sendable {
    public static let enabledKey = "stemCells.home"
    public static let computerKey = "stemCells.computer"

    public let variant: AppVariant
    /// UserDefaults is safe from any thread.
    private nonisolated(unsafe) let storage: UserDefaults

    public init(variant: AppVariant, storage: UserDefaults = .standard) {
        self.variant = variant
        self.storage = storage
    }

    /// The filter offers Stem Cells at all.
    public var isAvailable: Bool { variant != .production }

    /// Home shows Stem Cells. Never true in production.
    public var isEnabled: Bool {
        get { isAvailable && storage.bool(forKey: Self.enabledKey) }
        nonmutating set {
            guard isAvailable else { return }
            storage.set(newValue, forKey: Self.enabledKey)
        }
    }

    /// The paired computer Stem Cells shows when a Happy account is the
    /// active one: the last one chosen.
    public var computerID: String? {
        get { isAvailable ? storage.string(forKey: Self.computerKey) : nil }
        nonmutating set {
            guard isAvailable else { return }
            storage.set(newValue, forKey: Self.computerKey)
        }
    }

    public static let didChange = Notification.Name("StemCellsPreference.didChange")
}
