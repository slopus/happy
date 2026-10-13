import Foundation
import HappyWire

public enum HappyAgentGitFileStatus: String, Codable, Sendable {
    case added, conflicted, copied, deleted, modified, renamed, submodule, type_changed, untracked
}

/// Validated native snapshot file. Unknown wire fields survive round trips.
public struct HappyAgentGitFile: Codable, Equatable, Sendable {
    public let raw: JSONValue
    public var path: String { raw["path"]!.stringValue! }
    public var previousPath: String? { raw["previousPath"]?.stringValue }
    public var status: HappyAgentGitFileStatus { HappyAgentGitFileStatus(rawValue: raw["status"]!.stringValue!)! }
    public var staged: Bool { raw["staged"]!.boolValue! }
    public var unstaged: Bool { raw["unstaged"]!.boolValue! }
    public var binary: Bool { raw["binary"]!.boolValue! }
    public var insertions: Int? { raw["insertions"]?.numberValue.map(Int.init) }
    public var deletions: Int? { raw["deletions"]?.numberValue.map(Int.init) }

    public init(_ raw: JSONValue) throws {
        guard raw.objectValue != nil, gitNonempty(raw["path"]),
              raw["previousPath"] == nil || gitNonempty(raw["previousPath"]),
              let status = raw["status"]?.stringValue, HappyAgentGitFileStatus(rawValue: status) != nil,
              ["staged", "unstaged", "binary"].allSatisfy({ raw[$0]?.boolValue != nil }),
              ["insertions", "deletions"].allSatisfy({ raw[$0] == nil || gitCount(raw[$0]) }) else {
            throw SessionActionError.failed("Happy Agent returned an invalid Git file.")
        }
        self.raw = raw
    }

    public init(from decoder: any Decoder) throws { try self.init(JSONValue(from: decoder)) }

    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct HappyAgentGitFacts: Equatable, Sendable {
    public let raw: JSONValue
    public var branch: String? { raw["branch"]?.stringValue }
    public var detached: Bool { raw["detached"]!.boolValue! }
    public var head: String? { raw["head"]?.stringValue }
    public var upstream: String? { raw["upstream"]?.stringValue }
    public var ahead: Int { Int(raw["ahead"]!.numberValue!) }
    public var behind: Int { Int(raw["behind"]!.numberValue!) }
}

public enum HappyAgentGitComparison: String, Sendable { case ready, unavailable }

public struct HappyAgentGitState: Codable, Equatable, Sendable {
    public let raw: JSONValue
    public let files: [HappyAgentGitFile]
    public var facts: HappyAgentGitFacts { HappyAgentGitFacts(raw: raw["facts"]!) }
    public var comparison: HappyAgentGitComparison { HappyAgentGitComparison(rawValue: raw["comparison"]!.stringValue!)! }
    public var base: String? { raw["base"]?.stringValue }
    public var changedFiles: Int { Int(raw["changedFiles"]!.numberValue!) }
    public var insertions: Int { Int(raw["insertions"]!.numberValue!) }
    public var deletions: Int { Int(raw["deletions"]!.numberValue!) }
    public var countsExact: Bool { raw["countsExact"]!.boolValue! }
    public var conflicted: Bool { raw["conflicted"]!.boolValue! }
    public var filesTruncated: Bool { raw["filesTruncated"]!.boolValue! }
    public var scannedAt: Double { raw["scannedAt"]!.numberValue! }

    public init(_ raw: JSONValue) throws {
        let invalid = SessionActionError.failed("Happy Agent returned an invalid Git state.")
        guard let facts = raw["facts"], facts.objectValue != nil,
              ["branch", "head", "upstream"].allSatisfy({ facts[$0] == .null || facts[$0]?.stringValue != nil }),
              facts["detached"]?.boolValue != nil, gitCount(facts["ahead"]), gitCount(facts["behind"]),
              let comparison = raw["comparison"]?.stringValue, HappyAgentGitComparison(rawValue: comparison) != nil,
              raw["base"] == .null || raw["base"]?.stringValue.map(gitRevision) == true,
              comparison != "ready" || raw["base"]?.stringValue != nil,
              ["changedFiles", "insertions", "deletions"].allSatisfy({ gitCount(raw[$0]) }),
              ["countsExact", "conflicted", "filesTruncated"].allSatisfy({ raw[$0]?.boolValue != nil }),
              let scanned = raw["scannedAt"]?.numberValue, scanned.isFinite, scanned >= 0,
              let files = raw["files"]?.arrayValue else { throw invalid }
        do { self.files = try files.map(HappyAgentGitFile.init) } catch { throw invalid }
        self.raw = raw
    }

    public init(from decoder: any Decoder) throws { try self.init(JSONValue(from: decoder)) }

    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public enum HappyAgentFileContent: Equatable, Sendable {
    case text(oldText: String, newText: String)
    case image(before: String?, after: String?)
    case message(String)
}

func gitNonempty(_ value: JSONValue?) -> Bool { value?.stringValue?.isEmpty == false }

func gitCount(_ value: JSONValue?) -> Bool {
    guard let number = value?.numberValue else { return false }
    return number.isFinite && number >= 0 && number.rounded() == number && number < Double(Int.max)
}

func gitRevision(_ value: String) -> Bool {
    (value.utf8.count == 40 || value.utf8.count == 64)
        && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
