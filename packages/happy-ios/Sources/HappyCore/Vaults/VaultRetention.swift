import Foundation

/// A vault's retention policy (API.md, "Retention"). Sent whole, `null`s
/// included, since a settings change replaces the stored one.
public struct VaultRetention: Codable, Equatable, Hashable, Sendable {
    public struct Tier: Codable, Equatable, Hashable, Sendable {
        public var afterDays: Int
        public var everyDays: Int

        public init(afterDays: Int, everyDays: Int) {
            self.afterDays = afterDays
            self.everyDays = everyDays
        }
    }

    public var maxVersions: Int?
    public var maxAgeDays: Int?
    public var keepAllDays: Int
    public var thinning: [Tier]
    /// Nil keeps Trash items until they are restored.
    public var trashDays: Int?

    public init(maxVersions: Int? = nil, maxAgeDays: Int? = nil, keepAllDays: Int, thinning: [Tier], trashDays: Int? = 30) {
        self.maxVersions = maxVersions
        self.maxAgeDays = maxAgeDays
        self.keepAllDays = keepAllDays
        self.thinning = thinning
        self.trashDays = trashDays
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(maxVersions, forKey: .maxVersions)
        try container.encode(maxAgeDays, forKey: .maxAgeDays)
        try container.encode(keepAllDays, forKey: .keepAllDays)
        try container.encode(thinning, forKey: .thinning)
        try container.encode(trashDays, forKey: .trashDays)
    }

    /// The contract's limits, so the editor never sends what the computer refuses.
    public enum Limits {
        public static let maxVersions = 1...10_000
        public static let days = 0...36_500
        public static let maxAgeDays = 1...36_500
        public static let everyDays = 1...3_650
        public static let trashDays = 1...3_650
        public static let tiers = 8
    }

    /// Tiers sorted by `afterDays`, one per `afterDays`, at most eight,
    /// every number in range: what a custom edit is sent as.
    public func normalized() -> VaultRetention {
        var copy = self
        func clamp(_ value: Int, _ range: ClosedRange<Int>) -> Int { min(max(value, range.lowerBound), range.upperBound) }
        copy.maxVersions = maxVersions.map { clamp($0, Limits.maxVersions) }
        copy.maxAgeDays = maxAgeDays.map { clamp($0, Limits.maxAgeDays) }
        copy.keepAllDays = clamp(keepAllDays, Limits.days)
        copy.trashDays = trashDays.map { clamp($0, Limits.trashDays) }
        var seen = Set<Int>()
        copy.thinning = thinning
            .map { Tier(afterDays: clamp($0.afterDays, Limits.days), everyDays: clamp($0.everyDays, Limits.everyDays)) }
            .sorted { $0.afterDays < $1.afterDays }
            .filter { seen.insert($0.afterDays).inserted }
        copy.thinning = Array(copy.thinning.prefix(Limits.tiers))
        return copy
    }

    /// The same versions kept, with `preset`'s rules and this Trash time.
    public func applying(_ preset: VaultRetentionPreset) -> VaultRetention {
        guard let rules = preset.rules else { return self }
        var copy = rules
        copy.trashDays = trashDays
        return copy
    }

    /// The preset whose four version rules match exactly, else `.custom`.
    public var preset: VaultRetentionPreset {
        VaultRetentionPreset.named.first { preset in
            guard let rules = preset.rules else { return false }
            return rules.maxVersions == maxVersions && rules.maxAgeDays == maxAgeDays && rules.keepAllDays == keepAllDays && rules.thinning == thinning
        } ?? .custom
    }

    /// A new vault's policy: Time Machine, Trash kept 30 days.
    public static let standard = VaultRetention(keepAllDays: 1, thinning: [Tier(afterDays: 1, everyDays: 1), Tier(afterDays: 30, everyDays: 7)], trashDays: 30)
}

/// The presets every client offers, in this order, Time Machine the
/// default. Choosing one keeps the Trash time.
public enum VaultRetentionPreset: String, CaseIterable, Sendable {
    case timeMachine
    case keepEverything
    case lastTen
    case custom

    public static let named: [VaultRetentionPreset] = [.timeMachine, .keepEverything, .lastTen]

    /// The version rules; nil for custom. `trashDays` is not the preset's.
    public var rules: VaultRetention? {
        switch self {
        case .keepEverything: VaultRetention(keepAllDays: 0, thinning: [])
        case .lastTen: VaultRetention(maxVersions: 10, keepAllDays: 0, thinning: [])
        case .timeMachine: VaultRetention.standard
        case .custom: nil
        }
    }
}
