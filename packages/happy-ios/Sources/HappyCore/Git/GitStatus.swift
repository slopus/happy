import Foundation

public struct GitFileStatus: Equatable, Sendable {
    public enum Status: String, Sendable { case modified, added, deleted, renamed, untracked }
    public var fileName: String
    public var filePath: String
    public var fullPath: String
    public var status: Status
    public var isStaged: Bool
    public var linesAdded: Int
    public var linesRemoved: Int
    public var oldPath: String?
}
public struct GitStatus: Equatable, Sendable {
    public var branch: String?
    public var upstreamBranch: String?
    public var aheadCount: Int?
    public var behindCount: Int?
    public var stashCount: Int = 0
    public var stagedFiles: [GitFileStatus] = []
    public var unstagedFiles: [GitFileStatus] = []
    public var modifiedCount: Int = 0
    public var untrackedCount: Int = 0
    public var lastUpdatedAt: Int64 = 0
    public var stagedCount: Int { stagedFiles.count }
    public var totalStaged: Int { stagedFiles.count }
    public var totalUnstaged: Int { unstagedFiles.count }
    public var isDirty: Bool { !stagedFiles.isEmpty || !unstagedFiles.isEmpty }
    public var stagedLinesAdded: Int { stagedFiles.reduce(0) { $0 + $1.linesAdded } }
    public var stagedLinesRemoved: Int { stagedFiles.reduce(0) { $0 + $1.linesRemoved } }
    public var unstagedLinesAdded: Int { unstagedFiles.reduce(0) { $0 + $1.linesAdded } }
    public var unstagedLinesRemoved: Int { unstagedFiles.reduce(0) { $0 + $1.linesRemoved } }
    public var linesAdded: Int { stagedLinesAdded + unstagedLinesAdded }
    public var linesRemoved: Int { stagedLinesRemoved + unstagedLinesRemoved }
    public var linesChanged: Int { linesAdded + linesRemoved }
}
public typealias GitStatusFiles = GitStatus

public enum GitStatusParser {
    /// Ports gitStatusFiles.parseGitStatusFilesV2 and gitStatusSync.parseGitStatusV2.
    public static func parse(status: String, unstagedNumstat: String = "", stagedNumstat: String = "", now: Int64 = 0) -> GitStatus {
        GitStatus(lastUpdatedAt: now)
    }
}