import Foundation

/// utils/codexUnifiedDiff.ts: Codex's patches and diffs as the tool views
/// need them. Codex sends hunks without file headers; the diff renderer
/// needs headers, and its turn diff view wants the two sides.
public enum CodexUnifiedDiff {
    /// A file in Codex's `changes`: `add`, `delete`, `update`, or anything
    /// else (treated as an update).
    public enum FileKind: Equatable, Sendable {
        case add, delete, update
        case other(String?)

        public init(_ value: String?) {
            switch value {
            case "add": self = .add
            case "delete": self = .delete
            case "update": self = .update
            default: self = .other(value)
            }
        }
    }

    /// The two sides a diff describes, and the file it names, if it does.
    public struct Parsed: Equatable, Sendable {
        public var oldText: String
        public var newText: String
        public var fileName: String?

        public init(oldText: String, newText: String, fileName: String? = nil) {
            self.oldText = oldText
            self.newText = newText
            self.fileName = fileName
        }
    }

    /// `materializeUnifiedDiffPatch`: a hunk-only fragment gains `---` and
    /// `+++` headers for `fileName` (`/dev/null` on the side an add or a
    /// delete lacks); a diff that has headers is returned as is.
    public static func materializePatch(_ unifiedDiff: String, fileName: String, kind: FileKind = .update) -> String {
        if contains(unifiedDiff, "\n--- ") || DiffText.hasPrefix(unifiedDiff, "--- ")
            || contains(unifiedDiff, "\n+++ ") || DiffText.hasPrefix(unifiedDiff, "+++ ")
            || DiffText.hasPrefix(unifiedDiff, "diff --git ") {
            return unifiedDiff
        }
        let oldPath = kind == .add ? "/dev/null" : "a/\(fileName)"
        let newPath = kind == .delete ? "/dev/null" : "b/\(fileName)"
        return "--- \(oldPath)\n+++ \(newPath)\n\(unifiedDiff)"
    }

    /// `parseUnifiedDiff`: a unified diff, or a bare hunk fragment, as old
    /// and new file contents. Lines outside a hunk and git's metadata lines
    /// are skipped.
    public static func parse(_ unifiedDiff: String) -> Parsed {
        var oldLines: [String] = []
        var newLines: [String] = []
        var fileName: String?
        var inHunk = false
        let metadata = [
            "diff --git", "index ", "---", "new file mode", "deleted file mode",
            "similarity index ", "rename from ", "rename to ",
        ]

        for line in DiffText.lines(unifiedDiff, dropTrailingEmpty: false) {
            if DiffText.hasPrefix(line, "+++ ") {
                fileName = DiffText.droppingASCII(line, DiffText.hasPrefix(line, "+++ b/") ? 6 : 4)
                continue
            }
            if metadata.contains(where: { DiffText.hasPrefix(line, $0) }) { continue }
            if DiffText.hasPrefix(line, "@@") {
                inHunk = true
                continue
            }
            let marker = line.utf8.first
            if !inHunk, marker == UInt8(ascii: "+") || marker == UInt8(ascii: "-") || marker == UInt8(ascii: " ") {
                inHunk = true
            }
            guard inHunk else { continue }

            switch marker {
            case UInt8(ascii: "+"):
                newLines.append(DiffText.droppingASCII(line, 1))
            case UInt8(ascii: "-"):
                oldLines.append(DiffText.droppingASCII(line, 1))
            case UInt8(ascii: " "):
                let content = DiffText.droppingASCII(line, 1)
                oldLines.append(content)
                newLines.append(content)
            case nil:
                oldLines.append("")
                newLines.append("")
            default:
                // Including "\ No newline at end of file".
                break
            }
        }

        return Parsed(oldText: oldLines.joined(separator: "\n"), newText: newLines.joined(separator: "\n"), fileName: fileName)
    }

    /// `includes`, by code unit.
    private static func contains(_ text: String, _ part: String) -> Bool {
        text.utf8.firstRange(of: part.utf8) != nil
    }
}
