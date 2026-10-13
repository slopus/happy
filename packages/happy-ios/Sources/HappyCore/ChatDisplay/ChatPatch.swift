import Foundation
import HappyWire

// Reading Codex / Gemini / Rig `apply_patch` payloads, a port of happy-app's
// `utils/codexPatchEntry.ts`. The shape varies by provider version (a map or
// a list, a unified diff or a pair of blobs), so deciding what changed in a
// file lives here, away from drawing.

/// One file's change, normalized from whichever shape carried it.
public struct PatchEntry: Equatable, Sendable {
    public var diff: String?
    public var unifiedDiff: String?
    public var type: String?
    public var content: String?
    public var movePath: String?
    public var oldContent: String?
    public var newContent: String?
    public var kindType: String?
    public var kindMovePath: String?
    public var addContent: String?
    public var modifyOld: String?
    public var modifyNew: String?
    public var hasModify = false
    public var hasAdd = false
    public var hasDelete = false
    public var deleteContent: String?

    public init() {}

    init(json: [String: JSONValue]) {
        diff = json["diff"]?.stringValue
        unifiedDiff = json["unified_diff"]?.stringValue
        type = json["type"]?.stringValue
        content = json["content"]?.stringValue
        movePath = json["move_path"]?.stringValue
        oldContent = json["oldContent"]?.stringValue ?? json["old_content"]?.stringValue
        newContent = json["newContent"]?.stringValue ?? json["new_content"]?.stringValue
        if let kind = json["kind"]?.objectValue {
            kindType = kind["type"]?.stringValue
            kindMovePath = kind["move_path"]?.stringValue
        }
        if let add = json["add"]?.objectValue {
            hasAdd = true
            addContent = add["content"]?.stringValue
        }
        if let modify = json["modify"]?.objectValue {
            hasModify = true
            modifyOld = modify["old_content"]?.stringValue
            modifyNew = modify["new_content"]?.stringValue
        }
        if let delete = json["delete"]?.objectValue {
            hasDelete = true
            deleteContent = delete["content"]?.stringValue
        }
    }

    /// add, update or delete.
    public var kind: String? { kindType ?? type }

    public var destination: String? {
        guard let path = kindMovePath ?? movePath, !path.isEmpty else { return nil }
        return path
    }

    /// "new", "delete", "move" or "edit" (`getPatchKindLabel`).
    public var kindLabel: String? {
        switch kind {
        case "add": "new"
        case "delete": "delete"
        case "update": destination != nil ? "move" : "edit"
        default: nil
        }
    }

    /// What to diff: a unified diff, or the text before and after.
    public var input: PatchInput? {
        func whole(_ content: String) -> PatchInput {
            kind == "delete" ? .pair(old: content, new: "") : .pair(old: "", new: content)
        }
        if let diff { return ChatPatch.looksLikeUnifiedDiff(diff) ? .patch(diff) : whole(diff) }
        if let unifiedDiff { return ChatPatch.looksLikeUnifiedDiff(unifiedDiff) ? .patch(unifiedDiff) : whole(unifiedDiff) }
        if hasModify { return .pair(old: modifyOld ?? "", new: modifyNew ?? "") }
        if oldContent != nil || newContent != nil { return .pair(old: oldContent ?? "", new: newContent ?? "") }
        if hasAdd { return .pair(old: "", new: addContent ?? "") }
        if kind == "add", let content { return .pair(old: "", new: content) }
        if hasDelete { return .pair(old: deleteContent ?? "", new: "") }
        if kind == "delete", let content { return .pair(old: content, new: "") }
        return nil
    }
}

public enum PatchInput: Equatable, Sendable {
    case patch(String)
    case pair(old: String, new: String)
}

public enum ChatPatch {
    /// The changed files and their changes, or nil when the input carries
    /// no patch this can read. A map's files come sorted by path: the
    /// decoded JSON keeps no key order.
    public static func changes(_ input: JSONValue) -> [(path: String, entry: PatchEntry)]? {
        for key in ["changes", "fileChanges"] {
            if let list = input[key]?.arrayValue { return normalize(list: list) }
            if let map = input[key]?.objectValue { return normalize(map: map) }
        }
        let envelope = input["patch"]?.stringValue ?? input["input"]?.stringValue
        guard let envelope, envelope.contains("*** Begin Patch") else { return nil }
        guard let changes = parseEnvelope(envelope) else { return nil }
        guard let workdir = input["workdir"]?.stringValue else { return changes }
        return changes.map { change in
            var entry = change.entry
            entry.kindMovePath = entry.kindMovePath.map { join(workdir, $0) }
            return (join(workdir, change.path), entry)
        }
    }

    public static func files(_ input: JSONValue) -> [String] {
        changes(input)?.map(\.path) ?? []
    }

    /// Codex reuses `diff` for a real unified diff (updates) and for a whole
    /// file body (adds and deletes); this tells them apart by content.
    public static func looksLikeUnifiedDiff(_ text: String) -> Bool {
        if text.hasPrefix("--- ") || text.hasPrefix("diff --git ") { return true }
        return text.split(separator: "\n", omittingEmptySubsequences: false).contains { line in
            guard line.hasPrefix("@@") else { return false }
            return line.drop(while: { $0 == "@" }).hasPrefix(" -")
        }
    }

    static func normalize(map: [String: JSONValue]) -> [(path: String, entry: PatchEntry)]? {
        guard !map.isEmpty else { return nil }
        var result: [(path: String, entry: PatchEntry)] = []
        for (path, value) in map.sorted(by: { $0.key < $1.key }) {
            // Incomplete or future payloads fall back to the raw view.
            guard let object = value.objectValue else { return nil }
            result.append((path, PatchEntry(json: object)))
        }
        return result
    }

    static func normalize(list: [JSONValue]) -> [(path: String, entry: PatchEntry)]? {
        var result: [(path: String, entry: PatchEntry)] = []
        for change in list {
            guard let record = change.objectValue, let path = record["path"]?.stringValue, !path.isEmpty else { continue }
            var entry = PatchEntry()
            let kind = record["kind"]?.objectValue
            let type = record["type"]?.stringValue ?? kind?["type"]?.stringValue
            if let kind {
                entry.kindType = kind["type"]?.stringValue
                entry.kindMovePath = kind["move_path"]?.stringValue
            } else if let type {
                entry.kindType = type
            }
            if let diff = record["diff"]?.stringValue {
                entry.diff = diff
            } else if let diff = record["unified_diff"]?.stringValue {
                entry.unifiedDiff = diff
            }
            if let add = record["add"]?.objectValue {
                entry.hasAdd = true
                entry.addContent = add["content"]?.stringValue
            }
            if let modify = record["modify"]?.objectValue {
                entry.hasModify = true
                entry.modifyOld = modify["old_content"]?.stringValue
                entry.modifyNew = modify["new_content"]?.stringValue
            }
            if let delete = record["delete"]?.objectValue {
                entry.hasDelete = true
                entry.deleteContent = delete["content"]?.stringValue
            }
            if type == "add", let content = record["content"]?.stringValue {
                entry.hasAdd = true
                entry.addContent = content
            }
            if type == "delete", let content = record["content"]?.stringValue {
                entry.hasDelete = true
                entry.deleteContent = content
            }
            if let index = result.firstIndex(where: { $0.path == path }) {
                result[index].entry = entry
            } else {
                result.append((path, entry))
            }
        }
        return result.isEmpty ? nil : result
    }

    /// The `*** Begin Patch` envelope the model hands `apply_patch`. Updates
    /// become old/new excerpts: hunk anchors and context lines land on both
    /// sides. Nil when the envelope is malformed or edits one file twice.
    public static func parseEnvelope(_ patch: String) -> [(path: String, entry: PatchEntry)]? {
        let lines = patch.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard lines.first == "*** Begin Patch", let end = lines.firstIndex(of: "*** End Patch"),
              !lines[(end + 1)...].contains(where: { !$0.trimmed.isEmpty }) else { return nil }

        var changes: [(path: String, entry: PatchEntry)] = []
        var seen = Set<String>()
        var path: String?
        var action: String?
        var movePath: String?
        var addLines: [String] = []
        var oldLines: [String] = []
        var newLines: [String] = []

        func flush() {
            if let path, let action {
                var entry = PatchEntry()
                entry.kindType = action
                switch action {
                case "add":
                    entry.hasAdd = true
                    entry.addContent = addLines.joined(separator: "\n")
                case "update":
                    entry.kindMovePath = movePath
                    entry.hasModify = true
                    entry.modifyOld = oldLines.joined(separator: "\n")
                    entry.modifyNew = newLines.joined(separator: "\n")
                default:
                    break
                }
                changes.append((path, entry))
            }
            path = nil
            action = nil
            movePath = nil
            addLines = []
            oldLines = []
            newLines = []
        }

        for line in lines[1...end] {
            if line.hasPrefix("*** ") || line == "***" {
                if let marker = fileMarker(line) {
                    flush()
                    action = marker.action
                    let trimmed = marker.path.trimmed
                    if trimmed.isEmpty || seen.contains(trimmed) { return nil }
                    seen.insert(trimmed)
                    path = trimmed
                    continue
                }
                if line.hasPrefix("*** Move to: "), line.count > "*** Move to: ".count, action == "update" {
                    movePath = String(line.dropFirst("*** Move to: ".count)).trimmed
                    continue
                }
                if line == "*** End Patch" {
                    flush()
                    continue
                }
                if line == "*** End of File" && action == "update" { continue }
                return nil
            }
            guard let current = action, path != nil else { continue }
            switch current {
            case "add":
                guard line.hasPrefix("+") else { return nil }
                addLines.append(String(line.dropFirst()))
            case "delete":
                return nil
            default:
                if line.hasPrefix("@@") {
                    let anchor = line.hasPrefix("@@ ") ? String(line.dropFirst(3)) : ""
                    if !anchor.isEmpty {
                        oldLines.append(anchor)
                        newLines.append(anchor)
                    }
                } else if line.hasPrefix("+") {
                    newLines.append(String(line.dropFirst()))
                } else if line.hasPrefix("-") {
                    oldLines.append(String(line.dropFirst()))
                } else {
                    // Context: the strict format prefixes a space; codex's own
                    // parser tolerates its absence, so this does too.
                    let content = line.hasPrefix(" ") ? String(line.dropFirst()) : line
                    oldLines.append(content)
                    newLines.append(content)
                }
            }
        }
        flush()
        return changes.isEmpty ? nil : changes
    }

    static func fileMarker(_ line: String) -> (action: String, path: String)? {
        for (prefix, action) in [("*** Add File: ", "add"), ("*** Update File: ", "update"), ("*** Delete File: ", "delete")] where line.hasPrefix(prefix) {
            let path = String(line.dropFirst(prefix.count))
            return path.isEmpty ? nil : (action, path)
        }
        return nil
    }

    /// A relative patch path under the call's working directory, with `.`
    /// and `..` resolved.
    static func join(_ workdir: String, _ path: String) -> String {
        if path.hasPrefix("/") { return path }
        if path.count >= 3 {
            let characters = Array(path.prefix(3))
            if characters[0].isLetter, characters[0].isASCII, characters[1] == ":", characters[2] == "/" || characters[2] == "\\" { return path }
        }
        let combined = "\(workdir)/\(path)"
        let absolute = combined.hasPrefix("/")
        var parts: [String] = []
        for part in combined.split(separator: "/", omittingEmptySubsequences: true) where part != "." {
            if part == "..", let last = parts.last, last != ".." {
                parts.removeLast()
            } else if part != ".." || !absolute {
                parts.append(String(part))
            }
        }
        return (absolute ? "/" : "") + parts.joined(separator: "/")
    }
}
