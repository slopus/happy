import Foundation

/// Whether a paired computer is a home of its own, Stem Cells, beside the
/// Happy account's session list: the profile chosen decides which shows.
/// Only in development and preview builds: a production build cannot reach
/// it, whatever is stored.
public struct StemCellsPreference: Sendable {
    /// The filter's old Stem Cells choice, read once to carry it over.
    public static let enabledKey = "stemCells.home"
    public static let computerKey = "stemCells.computer"
    public static let directKey = "stemCells.direct"

    public let variant: AppVariant
    /// UserDefaults is safe from any thread.
    private nonisolated(unsafe) let storage: UserDefaults

    public init(variant: AppVariant, storage: UserDefaults = .standard) {
        self.variant = variant
        self.storage = storage
    }

    /// A computer can be home at all.
    public var isAvailable: Bool { variant != .production }

    /// The Direct connection experiment: computers paired straight to this
    /// phone, each a home of its own. Off until the person turns it on in
    /// Settings, on this phone alone; never on in production.
    public var directConnection: Bool {
        get { isAvailable && storage.bool(forKey: Self.directKey) }
        nonmutating set {
            guard isAvailable else { return }
            storage.set(newValue, forKey: Self.directKey)
        }
    }

    /// Paired computers are offered: production keeps its computer page;
    /// elsewhere, while the experiment is on.
    public var showsComputers: Bool { !isAvailable || directConnection }

    /// The Happy account's filter showed Stem Cells, before a computer was
    /// a home of its own: true once, so that launch opens the computer.
    /// Never true in production.
    public func takeFilterChoice() -> Bool {
        guard isAvailable, storage.object(forKey: Self.enabledKey) != nil else { return false }
        defer { storage.removeObject(forKey: Self.enabledKey) }
        return storage.bool(forKey: Self.enabledKey)
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
}
