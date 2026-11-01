import Foundation

/// The existing workspace Git API's summary, shared by every row in that checkout.
public struct WorkspaceLineChanges: Equatable, Sendable, Codable {
    public var comparison: String
    public var insertions: Int
    public var deletions: Int
    public var countsExact: Bool
    public var scannedAt: Double

    public var visible: GitLineChanges? {
        guard comparison == "ready", insertions >= 0, deletions >= 0,
              insertions > 0 || deletions > 0 else { return nil }
        return GitLineChanges(approximate: !countsExact, insertions: insertions, deletions: deletions)
    }
}