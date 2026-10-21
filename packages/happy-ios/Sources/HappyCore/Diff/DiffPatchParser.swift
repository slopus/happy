import Foundation

/// engine/parsePatch.ts: a tolerant unified-diff parser. Agent tools,
/// `git diff` and hand-written patches all come through here, and a bad
/// header degrades to "render what we can" rather than failing.
public enum DiffPatchParser {
    public struct RawLine: Equatable, Sendable {
        public var type: DiffLineType
        public var text: String
        public var oldNo: Int?
        public var newNo: Int?

        public init(_ type: DiffLineType, _ text: String, oldNo: Int? = nil, newNo: Int? = nil) {
            self.type = type
            self.text = text
            self.oldNo = oldNo
            self.newNo = newNo
        }
    }

    public struct RawHunk: Equatable, Sendable {
        public var oldStart: Int
        public var oldLines: Int
        public var newStart: Int
        public var newLines: Int
        /// What follows the closing `@@`, usually the enclosing function.
        public var section: String
        public var lines: [RawLine]

        public init(oldStart: Int, oldLines: Int, newStart: Int, newLines: Int, section: String, lines: [RawLine]) {
            self.oldStart = oldStart
            self.oldLines = oldLines
            self.newStart = newStart
            self.newLines = newLines
            self.section = section
            self.lines = lines
        }
    }

    public struct RawFile: Equatable, Sendable {
        public var path: String
        public var oldPath: String?
        public var kind: FileChangeKind
        public var hunks: [RawHunk]

        public init(path: String, oldPath: String? = nil, kind: FileChangeKind, hunks: [RawHunk] = []) {
            self.path = path
            self.oldPath = oldPath
            self.kind = kind
            self.hunks = hunks
        }
    }

    /// A contents diff ran out of its budget.
    public struct BudgetExceeded: Error, Equatable {}

    // MARK: Patches

    public static func parse(_ patch: String) -> [RawFile] {
        var lines = DiffText.lines(patch, dropTrailingEmpty: false)
        // The newline ending the last line is a terminator, not a line.
        if lines.count > 1, lines.last == "" { lines.removeLast() }

        var files: [RawFile] = []
        var file: RawFile?
        var inHunk = false
        var oldNo = 0
        var newNo = 0
        // `---`/`+++` pairs give the real paths; the `diff --git` line is
        // unreliable when paths contain spaces.
        var sawOldHeader = false

        func pushFile() {
            if let current = file { files.append(current) }
            file = nil
            inHunk = false
        }

        for line in lines {
            if DiffText.hasPrefix(line, "diff --git ") || DiffText.hasPrefix(line, "diff -") {
                pushFile()
                sawOldHeader = false
                // Best effort from the header; ---/+++ refine it.
                if let (old, new) = gitHeaderPaths(line) {
                    file = RawFile(path: cleanPath(new), oldPath: cleanPath(old), kind: .modified)
                }
                continue
            }
            if DiffText.hasPrefix(line, "new file mode") {
                file?.kind = .added
                continue
            }
            if DiffText.hasPrefix(line, "deleted file mode") {
                file?.kind = .deleted
                continue
            }
            if DiffText.hasPrefix(line, "rename from ") {
                if file != nil {
                    file?.oldPath = cleanPath(DiffText.droppingASCII(line, "rename from ".utf8.count))
                    file?.kind = .renamed
                }
                continue
            }
            if DiffText.hasPrefix(line, "rename to ") {
                let path = cleanPath(DiffText.droppingASCII(line, "rename to ".utf8.count))
                if file != nil {
                    file?.path = path
                    file?.kind = .renamed
                } else {
                    file = RawFile(path: path, kind: .renamed)
                }
                continue
            }
            if DiffText.hasPrefix(line, "Binary files") || DiffText.hasPrefix(line, "GIT binary patch") {
                file?.kind = .binary
                continue
            }
            if DiffText.hasPrefix(line, "index ") || DiffText.hasPrefix(line, "similarity index") || DiffText.hasPrefix(line, "old mode") || DiffText.hasPrefix(line, "new mode") {
                continue
            }

            if DiffText.hasPrefix(line, "--- ") {
                let path = DiffText.droppingASCII(line, 4)
                sawOldHeader = true
                if DiffText.trim(path) == "/dev/null" {
                    if file != nil { file?.kind = .added } else { file = RawFile(path: "", kind: .added) }
                } else if file != nil {
                    file?.oldPath = cleanPath(path)
                } else {
                    file = RawFile(path: cleanPath(path), oldPath: cleanPath(path), kind: .modified)
                }
                continue
            }

            if DiffText.hasPrefix(line, "+++ ") {
                let path = DiffText.droppingASCII(line, 4)
                if DiffText.trim(path) == "/dev/null" {
                    if file == nil { file = RawFile(path: "", kind: .modified) }
                    file?.kind = .deleted
                    if file?.path == "", let old = file?.oldPath { file?.path = old }
                } else {
                    let cleaned = cleanPath(path)
                    if file == nil { file = RawFile(path: cleaned, kind: .modified) }
                    // A `+++` right after `---` always names the current file.
                    if sawOldHeader || file?.path == "" { file?.path = cleaned }
                }
                sawOldHeader = false
                continue
            }

            if let header = hunkHeader(line) {
                if file == nil { file = RawFile(path: "", kind: .modified) }
                file?.hunks.append(RawHunk(
                    oldStart: header.oldStart, oldLines: header.oldLines,
                    newStart: header.newStart, newLines: header.newLines,
                    section: header.section, lines: []
                ))
                inHunk = true
                oldNo = header.oldStart
                newNo = header.newStart
                continue
            }

            guard inHunk, file != nil else { continue }

            // `\ No newline at end of file` is metadata, not content.
            if DiffText.hasPrefix(line, "\\") { continue }

            let marker = line.utf8.first
            let text = DiffText.droppingASCII(line, 1)
            let last = file!.hunks.count - 1
            if marker == UInt8(ascii: "+") {
                file!.hunks[last].lines.append(RawLine(.add, text, newNo: newNo))
                newNo += 1
            } else if marker == UInt8(ascii: "-") {
                file!.hunks[last].lines.append(RawLine(.del, text, oldNo: oldNo))
                oldNo += 1
            } else if marker == UInt8(ascii: " ") || line.isEmpty {
                file!.hunks[last].lines.append(RawLine(.ctx, text, oldNo: oldNo, newNo: newNo))
                oldNo += 1
                newNo += 1
            }
            // Anything else (junk between files) is ignored.
        }

        pushFile()
        return files.filter { !$0.path.isEmpty || !$0.hunks.isEmpty }
    }

    /// `/^diff --git (.+) (.+)$/`: the split is at the last space that leaves
    /// both sides non-empty.
    static func gitHeaderPaths(_ line: String) -> (String, String)? {
        guard DiffText.hasPrefix(line, "diff --git ") else { return nil }
        let rest = Array(DiffText.droppingASCII(line, "diff --git ".utf8.count).unicodeScalars)
        guard !rest.contains(where: isLineTerminator), rest.count >= 3 else { return nil }
        var split = rest.count - 2
        while split >= 1, rest[split] != " " { split -= 1 }
        guard split >= 1 else { return nil }
        return (scalarsString(rest[..<split]), scalarsString(rest[(split + 1)...]))
    }

    struct HunkHeader: Equatable {
        var oldStart: Int
        var oldLines: Int
        var newStart: Int
        var newLines: Int
        var section: String
    }

    /// `/^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/`, by hand: the
    /// section's `.` stops at line terminators and `$` only matches at the
    /// very end, as in JavaScript.
    static func hunkHeader(_ line: String) -> HunkHeader? {
        let scalars = Array(line.unicodeScalars)
        var index = 0

        func atSigns() -> Bool {
            let start = index
            while index < scalars.count, scalars[index] == "@" { index += 1 }
            return index - start >= 2
        }
        func literal(_ text: String) -> Bool {
            for scalar in text.unicodeScalars {
                guard index < scalars.count, scalars[index] == scalar else { return false }
                index += 1
            }
            return true
        }
        func number() -> Int? {
            let start = index
            while index < scalars.count, ("0"..."9").contains(scalars[index]) { index += 1 }
            guard index > start else { return nil }
            return Int(scalarsString(scalars[start..<index])) ?? Int.max
        }
        func optionalCount() -> Int?? {
            guard index < scalars.count, scalars[index] == "," else { return .some(nil) }
            index += 1
            guard let value = number() else { return nil }
            return .some(value)
        }

        guard atSigns(), literal(" -"), let oldStart = number(), let oldLines = optionalCount(),
              literal(" +"), let newStart = number(), let newLines = optionalCount(),
              literal(" "), atSigns() else { return nil }
        if index < scalars.count, scalars[index] == " " { index += 1 }
        let section = scalars[index...]
        guard !section.contains(where: isLineTerminator) else { return nil }
        return HunkHeader(oldStart: oldStart, oldLines: oldLines ?? 1, newStart: newStart, newLines: newLines ?? 1, section: scalarsString(section))
    }

    private static func isLineTerminator(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "\n" || scalar == "\r" || scalar == "\u{2028}" || scalar == "\u{2029}"
    }

    private static func scalarsString<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }

    /// Strips git's `a/` and `b/`, unquotes `core.quotepath` output and
    /// drops the timestamp `diff -u` puts after a tab.
    static func cleanPath(_ raw: String) -> String {
        var path = DiffText.trim(raw)
        if DiffText.hasPrefix(path, "\""), path.utf8.last == UInt8(ascii: "\""), path.utf16.count > 1 {
            if let data = path.data(using: .utf8),
               let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String {
                path = decoded
            } else {
                path = String(Substring(path.utf8.dropFirst().dropLast()))
            }
        }
        if let tab = path.utf8.firstIndex(of: UInt8(ascii: "\t")) {
            path = String(Substring(path.utf8[..<tab]))
        }
        if DiffText.hasPrefix(path, "a/") || DiffText.hasPrefix(path, "b/") {
            path = DiffText.droppingASCII(path, 2)
        }
        return path
    }

    // MARK: Contents

    /// A single-file patch built from two whole files.
    public static func rawFile(
        path: String,
        oldText: String,
        newText: String,
        contextLines: Int,
        ignoreWhitespace: Bool = false,
        budget: MyersDiff.Budget? = nil
    ) throws -> RawFile {
        let kind: FileChangeKind = oldText.isEmpty && !newText.isEmpty ? .added
            : newText.isEmpty && !oldText.isEmpty ? .deleted
            : .modified
        return RawFile(path: path, kind: kind, hunks: try hunksFromContents(oldText, newText, contextLines: contextLines, ignoreWhitespace: ignoreWhitespace, budget: budget))
    }

    /// The Myers line diff of two blobs, folded into hunks with
    /// `contextLines` of context. Throws `BudgetExceeded` when a budget runs
    /// out.
    public static func hunksFromContents(
        _ oldText: String,
        _ newText: String,
        contextLines: Int,
        ignoreWhitespace: Bool = false,
        budget: MyersDiff.Budget? = nil
    ) throws -> [RawHunk] {
        var all: [RawLine] = []
        var oldNo = 1
        var newNo = 1
        let oldLines = DiffText.lines(oldText, dropTrailingEmpty: true)
        let newLines = DiffText.lines(newText, dropTrailingEmpty: true)

        // A one-sided file needs no edit search, and must not spend a
        // two-sided budget on rows that are trivial to build.
        if oldLines.isEmpty || newLines.isEmpty {
            for text in oldLines {
                all.append(RawLine(.del, text, oldNo: oldNo))
                oldNo += 1
            }
            for text in newLines {
                all.append(RawLine(.add, text, newNo: newNo))
                newNo += 1
            }
            return foldHunks(all, contextLines: contextLines)
        }

        let changes: [(values: [String], added: Bool, removed: Bool)]
        if ignoreWhitespace {
            // Compare without whitespace, but keep each original line so the
            // renderer never shows a normalized copy.
            guard let result = MyersDiff.diffArrays(oldLines, newLines, key: stripWhitespace, budget: budget ?? .unlimited) else {
                throw BudgetExceeded()
            }
            changes = result.map { ($0.value, $0.added, $0.removed) }
        } else {
            guard let result = MyersDiff.diffLines(oldText, newText, budget: budget ?? .unlimited) else {
                throw BudgetExceeded()
            }
            changes = result.map { (DiffText.lines($0.value, dropTrailingEmpty: true), $0.added, $0.removed) }
        }

        for change in changes {
            for text in change.values {
                if change.added {
                    all.append(RawLine(.add, text, newNo: newNo))
                    newNo += 1
                } else if change.removed {
                    all.append(RawLine(.del, text, oldNo: oldNo))
                    oldNo += 1
                } else {
                    all.append(RawLine(.ctx, text, oldNo: oldNo, newNo: newNo))
                    oldNo += 1
                    newNo += 1
                }
            }
        }
        return foldHunks(all, contextLines: contextLines)
    }

    /// `text.replace(/\s/g, '')`.
    static func stripWhitespace(_ text: String) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: text.unicodeScalars.filter { !DiffText.isJSWhitespace($0) })
        return String(view)
    }

    /// Groups a whole file's lines into hunks, dropping unchanged runs
    /// longer than twice the context.
    public static func foldHunks(_ all: [RawLine], contextLines: Int) -> [RawHunk] {
        guard all.contains(where: { $0.type != .ctx }) else { return [] }

        var keep = [Bool](repeating: false, count: all.count)
        var lastFilled = -1
        for index in all.indices where all[index].type != .ctx {
            let from = max(0, index - contextLines)
            let to = min(all.count - 1, index + contextLines)
            if from > to { continue }
            var fill = max(from, lastFilled + 1)
            while fill <= to {
                keep[fill] = true
                fill += 1
            }
            if to > lastFilled { lastFilled = to }
        }

        var hunks: [RawHunk] = []
        var index = 0
        while index < all.count {
            if !keep[index] {
                index += 1
                continue
            }
            var end = index
            while end < all.count, keep[end] { end += 1 }
            let slice = Array(all[index..<end])
            let first = slice[0]
            let oldStart = first.oldNo ?? slice.first(where: { $0.oldNo != nil })?.oldNo ?? 0
            let newStart = first.newNo ?? slice.first(where: { $0.newNo != nil })?.newNo ?? 0
            hunks.append(RawHunk(
                oldStart: oldStart,
                oldLines: slice.filter { $0.type != .add }.count,
                newStart: newStart,
                newLines: slice.filter { $0.type != .del }.count,
                section: "",
                lines: slice
            ))
            index = end
        }
        return hunks
    }
}
