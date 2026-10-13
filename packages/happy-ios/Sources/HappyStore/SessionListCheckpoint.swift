import Foundation

/// Installed only after every list page succeeds. A partial download may
/// store rows, but must not advance the delta cursor or delete unseen rows.
public struct SessionListCheckpoint: Sendable {
    public var changedSince: Int64
    public var fullIDs: Set<String>?
    public var completedAt: Int64?

    public init(changedSince: Int64, fullIDs: Set<String>? = nil, completedAt: Int64? = nil) {
        self.changedSince = changedSince
        self.fullIDs = fullIDs
        self.completedAt = completedAt
    }
}