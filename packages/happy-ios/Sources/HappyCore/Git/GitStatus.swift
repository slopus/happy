import Foundation

/// A staged or unstaged file, with independent diff statistics for each side.
public struct GitFileStatus: Equatable, Sendable {
    /// gitStatusFiles.getFileStatusV2's human-readable status.
    public enum Status: String, Sendable {
        case modified
        case added
        case deleted
        case renamed
        case untracked
    }
    public var fileName: String
    public var filePath: String
    public var fullPath: String
    public var status: Status
    public var isStaged: Bool
    public var linesAdded: Int
    public var linesRemoved: Int
    public var oldPath: String?
}

/// The session header's counts and Changes screen's files for one checkout.
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

/// File-level git status shares the same snapshot as the session header.
public typealias GitStatusFiles = GitStatus

/// Pure porcelain-v2 and numstat parsers, after happy-app's git-parsers.
public enum GitStatusParser {
    /// Ports gitStatusFiles.parseGitStatusFilesV2 and gitStatusSync.parseGitStatusV2.
    public static func parse(status: String, unstagedNumstat: String = "", stagedNumstat: String = "", now: Int64 = 0) -> GitStatus {
        var result = GitStatus(lastUpdatedAt: now)
        let staged = numstat(stagedNumstat)
        let unstaged = numstat(unstagedNumstat)
        var modified: Set<String> = []
        for line in status.split(separator: "\n", omittingEmptySubsequences: true).map(String.init) {
            if line.hasPrefix("# branch.head ") {
                let branch = String(line.dropFirst(14))
                result.branch = branch == "(detached)" || branch == "(initial)" ? nil : branch
            } else if line.hasPrefix("# branch.upstream ") {
                result.upstreamBranch = String(line.dropFirst(18))
            } else if line.hasPrefix("# branch.ab ") {
                let counts = line.dropFirst(12).split(separator: " ")
                if counts.count == 2 {
                    result.aheadCount = Int(counts[0].dropFirst())
                    result.behindCount = Int(counts[1].dropFirst())
                }
            } else if line.hasPrefix("# stash ") {
                result.stashCount = Int(line.dropFirst(8)) ?? 0
            } else if line.hasPrefix("? ") {
                let path = decodePath(String(line.dropFirst(2)))
                result.untrackedCount += 1
                if !path.hasSuffix("/") { result.unstagedFiles.append(file(path: path, status: "?", staged: false, stats: [:], oldPath: nil)) }
            } else if line.hasPrefix("1 ") || line.hasPrefix("2 ") || line.hasPrefix("u ") {
                let count = line.hasPrefix("1 ") ? 8 : line.hasPrefix("2 ") ? 9 : 10
                let fields = line.split(separator: " ", maxSplits: count, omittingEmptySubsequences: false)
                guard fields.count == count + 1, fields[1].count == 2 else { continue }
                let codes = Array(fields[1])
                let raw = String(fields[count])
                let paths = raw.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
                let path = decodePath(String(paths[0]))
                let oldPath = paths.count > 1 ? decodePath(String(paths[1])) : nil
                if ![".", " ", "?"].contains(codes[0]) {
                    result.stagedFiles.append(file(path: path, status: codes[0], staged: true, stats: staged, oldPath: oldPath))
                }
                if ![".", " "].contains(codes[1]) {
                    result.unstagedFiles.append(file(path: path, status: codes[1], staged: false, stats: unstaged, oldPath: oldPath))
                }
                if codes.contains("M"), codes[0] != "A" { modified.insert(path) }
            }
        }
        result.modifiedCount = modified.count
        if result.upstreamBranch != nil {
            result.aheadCount = result.aheadCount ?? 0
            result.behindCount = result.behindCount ?? 0
        } else {
            result.aheadCount = nil
            result.behindCount = nil
        }
        return result
    }

    /// Ports git-parsers/gitPath.decodeGitPath, including UTF-8 octal bytes.
    public static func decodePath(_ path: String) -> String {
        guard path.hasPrefix("\""), path.hasSuffix("\""), path.count >= 2 else { return path }
        let chars = Array(path.dropFirst().dropLast())
        var bytes: [UInt8] = []
        var index = 0
        let escapes: [Character: String] = ["a": "\u{07}", "b": "\u{08}", "f": "\u{0c}", "n": "\n", "r": "\r", "t": "\t", "v": "\u{0b}", "\"": "\"", "\\": "\\"]
        while index < chars.count {
            if chars[index] != "\\" || index + 1 == chars.count {
                bytes.append(contentsOf: String(chars[index]).utf8)
                index += 1
                continue
            }
            index += 1
            var octal = ""
            while index < chars.count, octal.count < 3, ("0"..."7").contains(String(chars[index])) {
                octal.append(chars[index])
                index += 1
            }
            if !octal.isEmpty {
                bytes.append(UInt8(truncatingIfNeeded: Int(octal, radix: 8) ?? 0))
            } else {
                bytes.append(contentsOf: (escapes[chars[index]] ?? String(chars[index])).utf8)
                index += 1
            }
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func numstat(_ output: String) -> [String: (added: Int, removed: Int)] {
        var stats: [String: (added: Int, removed: Int)] = [:]
        for line in output.split(separator: "\n") {
            let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3 else { continue }
            var path = decodePath(String(parts[2]))
            // git --numstat abbreviates renames as dir/{old => new}/file.
            if let open = path.range(of: "{"), let arrow = path.range(of: " => ", range: open.upperBound..<path.endIndex),
               let close = path.range(of: "}", range: arrow.upperBound..<path.endIndex) {
                path = String(path[..<open.lowerBound]) + String(path[arrow.upperBound..<close.lowerBound]) + String(path[close.upperBound...])
            } else if let arrow = path.range(of: " => ") {
                path = String(path[arrow.upperBound...])
            }
            let binary = parts[0] == "-" || parts[1] == "-"
            stats[path] = binary ? (0, 0) : (Int(parts[0]) ?? 0, Int(parts[1]) ?? 0)
        }
        return stats
    }

    private static func file(path: String, status: Character, staged: Bool, stats: [String: (added: Int, removed: Int)], oldPath: String?) -> GitFileStatus {
        let kind: GitFileStatus.Status
        switch status {
        case "A": kind = .added
        case "D": kind = .deleted
        case "R", "C": kind = .renamed
        case "?": kind = .untracked
        default: kind = .modified
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return GitFileStatus(
            fileName: String(parts.last ?? ""), filePath: parts.dropLast().joined(separator: "/"), fullPath: path,
            status: kind, isStaged: staged, linesAdded: stats[path]?.added ?? 0,
            linesRemoved: stats[path]?.removed ?? 0, oldPath: oldPath
        )
    }
}
