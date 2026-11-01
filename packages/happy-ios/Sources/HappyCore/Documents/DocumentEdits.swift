import Foundation

/// The editor's edits as pure functions over lines and runs, the way
/// BlockNote's keyboard handlers make them (`KeyboardShortcutsExtension`:
/// Enter splits, an empty list item lifts out, Backspace at a block's start
/// turns it into a paragraph before joining it to the one above). The
/// screen applies what they return through `DocumentEditor.replaceLines`.
public enum DocumentEdits {
    /// A replacement for some lines and where the caret goes after it.
    public struct Result: Equatable, Sendable {
        public var range: Range<Int>
        public var lines: [DocumentLine]
        /// The caret, as an index into `lines` (of the whole document after
        /// the edit) and a UTF-16 offset.
        public var caretLine: Int
        public var caretOffset: Int

        public init(range: Range<Int>, lines: [DocumentLine], caretLine: Int, caretOffset: Int) {
            self.range = range
            self.lines = lines
            self.caretLine = caretLine
            self.caretOffset = caretOffset
        }
    }

    // MARK: Runs

    /// The runs' text between two UTF-16 offsets, formats kept.
    public static func slice(_ runs: [DocumentRun], _ range: Range<Int>) -> [DocumentRun] {
        var out: [DocumentRun] = []
        var position = 0
        for run in runs {
            let units = Array(run.text.utf16)
            let start = max(range.lowerBound - position, 0)
            let end = min(range.upperBound - position, units.count)
            if start < end {
                DocumentReader.append(&out, DocumentRun(String(decoding: units[start..<end], as: UTF16.self), marks: run.marks))
            }
            position += units.count
        }
        return out
    }

    public static func length(_ runs: [DocumentRun]) -> Int { runs.reduce(0) { $0 + $1.text.utf16.count } }

    public static func concat(_ a: [DocumentRun], _ b: [DocumentRun]) -> [DocumentRun] {
        var out = a
        for run in b { DocumentReader.append(&out, run) }
        return out
    }

    /// Whether every character in `range` carries `mark` (the toolbar's lit buttons).
    public static func has(_ runs: [DocumentRun], _ mark: String, in range: Range<Int>) -> Bool {
        let picked = range.isEmpty ? slice(runs, max(0, range.lowerBound - 1)..<range.lowerBound) : slice(runs, range)
        return !picked.isEmpty && picked.allSatisfy { $0.marks[mark] != nil }
    }

    /// Sets or clears a mark over `range`. Inline code takes no other marks
    /// with it, as BlockNote's `code` mark excludes them.
    public static func setting(_ runs: [DocumentRun], _ mark: String, _ value: YAny?, in range: Range<Int>) -> [DocumentRun] {
        let total = length(runs)
        let range = max(0, range.lowerBound)..<min(total, range.upperBound)
        guard !range.isEmpty else { return runs }
        var middle = slice(runs, range)
        for i in middle.indices {
            if let value {
                if mark == "code" { middle[i].marks = middle[i].marks.filter { $0.key == "textColor" || $0.key == "backgroundColor" } }
                middle[i].marks[mark] = value
            } else {
                middle[i].marks[mark] = nil
            }
        }
        return concat(concat(slice(runs, 0..<range.lowerBound), middle), slice(runs, range.upperBound..<total))
    }

    public static func toggling(_ runs: [DocumentRun], _ mark: String, in range: Range<Int>) -> [DocumentRun] {
        setting(runs, mark, has(runs, mark, in: range) ? nil : .object([]), in: range)
    }

    /// The text typed in place of `range`, taking the formats a character
    /// typed there would: those before it, but never a link's or code's
    /// past their end (ProseMirror's non-inclusive marks).
    public static func typing(_ runs: [DocumentRun], _ text: String, replacing range: Range<Int>, marks: [String: YAny]? = nil) -> [DocumentRun] {
        let total = length(runs)
        let inserted = DocumentRun(text, marks: marks ?? self.marks(runs, at: range.lowerBound))
        return concat(concat(slice(runs, 0..<range.lowerBound), [inserted]), slice(runs, range.upperBound..<total))
    }

    public static func marks(_ runs: [DocumentRun], at offset: Int) -> [String: YAny] {
        guard offset > 0 else { return slice(runs, 0..<1).first?.marks.filter { $0.key != "link" && $0.key != "code" } ?? [:] }
        var marks = slice(runs, (offset - 1)..<offset).first?.marks ?? [:]
        let after = slice(runs, offset..<(offset + 1)).first?.marks
        for key in ["link", "code"] where marks[key] != nil && after?[key] != marks[key] { marks[key] = nil }
        return marks
    }

    // MARK: Lines

    static func fresh(_ type: String, depth: Int, runs: [DocumentRun] = [], id: String = DocumentEditor.newID()) -> DocumentLine {
        DocumentLine(block: DocumentBlock(id: id, type: type, props: [:], content: .inline(runs)), depth: depth)
    }

    /// Enter at `offset` in line `index`.
    public static func enter(_ lines: [DocumentLine], at index: Int, offset: Int, newID: String = DocumentEditor.newID()) -> Result? {
        guard lines.indices.contains(index) else { return nil }
        let line = lines[index]
        guard line.block.isInline else {
            let next = fresh("paragraph", depth: line.depth, id: newID)
            return Result(range: (index + 1)..<(index + 1), lines: [next], caretLine: index + 1, caretOffset: 0)
        }
        let runs = line.block.runs
        let total = length(runs)
        // An empty list item, quote or heading lifts out to a paragraph, then up a level.
        if total == 0, line.block.type != "paragraph" {
            var lifted = line
            lifted.block.type = "paragraph"
            lifted.block.props = DocumentEditor.carriedProps(from: line.block, to: "paragraph")
            return Result(range: index..<(index + 1), lines: [lifted], caretLine: index, caretOffset: 0)
        }
        if total == 0, line.depth > 0 {
            var lifted = line
            lifted.depth -= 1
            return Result(range: index..<(index + 1), lines: [lifted], caretLine: index, caretOffset: 0)
        }
        var first = line
        first.block.content = .inline(slice(runs, 0..<offset))
        let rest = slice(runs, offset..<total)
        let type = DocumentSchema.listTypes.contains(line.block.type) || line.block.type == "quote" ? line.block.type : "paragraph"
        var second = fresh(type, depth: line.depth, runs: rest, id: newID)
        second.block.props = DocumentEditor.carriedProps(from: line.block, to: type).filter { $0.key != "checked" && $0.key != "start" }
        // At the very start, the new empty line goes above and the line keeps its ID.
        if offset == 0, total > 0 {
            var above = second
            above.block.content = .inline([])
            return Result(range: index..<index, lines: [above], caretLine: index + 1, caretOffset: 0)
        }
        return Result(range: index..<(index + 1), lines: [first, second], caretLine: index + 1, caretOffset: 0)
    }

    /// Backspace at the start of line `index`.
    public static func backspaceAtStart(_ lines: [DocumentLine], at index: Int) -> Result? {
        guard lines.indices.contains(index) else { return nil }
        let line = lines[index]
        if line.block.isInline, line.block.type != "paragraph" {
            var plain = line
            plain.block.type = "paragraph"
            plain.block.props = DocumentEditor.carriedProps(from: line.block, to: "paragraph")
            if line.block.type == "codeBlock" { plain.block.content = .inline(line.block.runs.map { DocumentRun($0.text) }) }
            return Result(range: index..<(index + 1), lines: [plain], caretLine: index, caretOffset: 0)
        }
        // Nested, it comes up a level first (`liftListItem`).
        if line.depth > 0 {
            return outdent(lines, index..<(index + 1), caret: 0)
        }
        guard index > 0 else { return nil }
        let previous = lines[index - 1]
        if !previous.block.isInline {
            // A divider or picture above goes; the line stays.
            return Result(range: (index - 1)..<index, lines: [], caretLine: index - 1, caretOffset: 0)
        }
        guard line.block.isInline else {
            return Result(range: index..<(index + 1), lines: [], caretLine: index - 1, caretOffset: previous.length)
        }
        var joined = previous
        let code = previous.block.type == "codeBlock"
        let tail = code ? line.block.runs.map { DocumentRun($0.text) } : line.block.runs
        joined.block.content = .inline(concat(previous.block.runs, tail))
        // Its children come up a level to stay under the joined line.
        var range = (index - 1)..<(index + 1)
        var moved: [DocumentLine] = []
        var i = index + 1
        while i < lines.count, lines[i].depth > line.depth {
            var child = lines[i]
            child.depth = max(joined.depth + 1, child.depth - (line.depth - joined.depth))
            moved.append(child)
            i += 1
        }
        if !moved.isEmpty { range = (index - 1)..<i }
        return Result(range: range, lines: [joined] + moved, caretLine: index - 1, caretOffset: previous.length)
    }

    /// Tab: a line goes under the one above, as long as there is one at its depth.
    public static func indent(_ lines: [DocumentLine], _ range: Range<Int>, caret: Int) -> Result? {
        guard let first = range.first, first > 0, lines[first - 1].depth >= lines[first].depth else { return nil }
        var out: [DocumentLine] = []
        var end = range.upperBound
        while end < lines.count, lines[end].depth > lines[range.upperBound - 1].depth { end += 1 }
        for line in lines[range.lowerBound..<end] {
            var moved = line
            moved.depth += 1
            out.append(moved)
        }
        return Result(range: range.lowerBound..<end, lines: out, caretLine: first, caretOffset: caret)
    }

    /// Shift-Tab: lines come up a level; the lines after them at their old
    /// depth become their children, as ProseMirror's `liftListItem` does.
    public static func outdent(_ lines: [DocumentLine], _ range: Range<Int>, caret: Int) -> Result? {
        guard let first = range.first, lines[range].contains(where: { $0.depth > 0 }) else { return nil }
        let lastDepth = lines[range.upperBound - 1].depth
        var end = range.upperBound
        while end < lines.count, lines[end].depth > lastDepth { end += 1 }
        let out = lines[range.lowerBound..<end].map { line -> DocumentLine in
            var moved = line
            moved.depth = max(0, moved.depth - 1)
            return moved
        }
        return Result(range: range.lowerBound..<end, lines: out, caretLine: first, caretOffset: caret)
    }

    /// A line made another type, its text kept (the toolbar's block buttons).
    public static func retype(_ line: DocumentLine, _ type: String, props: [String: YAny] = [:]) -> DocumentLine {
        var out = line
        out.block.type = type
        out.block.props = DocumentEditor.carriedProps(from: line.block, to: type).merging(props) { _, new in new }
        if type == "codeBlock" || line.block.type == "codeBlock" { out.block.content = .inline([DocumentRun(line.block.plainText)]) }
        if !line.block.isInline { out.block.content = .inline([]) }
        return out
    }

    /// A divider after line `index`, then an empty paragraph to go on typing in.
    public static func divider(_ lines: [DocumentLine], replacing index: Int) -> Result {
        let line = lines[index]
        let divider = DocumentLine(block: DocumentBlock(id: line.id, type: "divider", content: .none), depth: line.depth)
        let next = fresh("paragraph", depth: line.depth)
        let following = index + 1 < lines.count && lines[index + 1].block.isInline && lines[index + 1].length == 0
        if following { return Result(range: index..<(index + 1), lines: [divider], caretLine: index + 1, caretOffset: 0) }
        return Result(range: index..<(index + 1), lines: [divider, next], caretLine: index + 1, caretOffset: 0)
    }
}

/// Markdown typed as Markdown turning into what it means (BlockNote's input
/// rules): `# ` a heading, `- ` a bullet, `1. ` a numbered item, `[] ` a
/// task, `> ` a quote, ```` ``` ```` a code block, `---` a divider, and
/// `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` closing as typed.
public enum DocumentShortcuts {
    public enum Block: Equatable, Sendable {
        case type(String, props: [String: YAny], remove: Int)
        case divider
    }

    /// What the text before the caret makes of a paragraph, right after a character was typed.
    public static func block(_ line: DocumentLine, caret: Int) -> Block? {
        guard line.block.isInline, line.block.type != "codeBlock" else { return nil }
        let text = line.block.plainText
        let units = Array(text.utf16)
        guard caret <= units.count else { return nil }
        let before = String(decoding: units[0..<caret], as: UTF16.self)
        if line.block.type == "paragraph", text == "---", caret == 3 { return .divider }
        guard before.hasSuffix(" ") else { return nil }
        let rules: [(String, (Substring) -> (String, [String: YAny])?)] = [
            (#"^(#{1,6}) $"#, { m in ("heading", ["level": .number(Double(m.filter { $0 == "#" }.count))]) }),
            (#"^\s?[-+*] $"#, { _ in ("bulletListItem", [:]) }),
            (#"^\s?(\d+)\. $"#, { m in
                let n = Int(m.filter(\.isNumber)) ?? 1
                return ("numberedListItem", n == 1 ? [:] : ["start": .number(Double(n))])
            }),
            (#"^\s?\[\s*\] $"#, { _ in ("checkListItem", ["checked": .bool(false)]) }),
            (#"^\s?\[[Xx]\] $"#, { _ in ("checkListItem", ["checked": .bool(true)]) }),
            (#"^> $"#, { _ in ("quote", [:]) }),
            (#"^```([A-Za-z0-9+#-]*) $"#, { m in
                let language = m.dropFirst(3).dropLast()
                return ("codeBlock", ["language": .string(language.isEmpty ? "text" : String(language))])
            }),
        ]
        for (pattern, make) in rules {
            guard let match = before.range(of: pattern, options: .regularExpression) else { continue }
            guard let (type, props) = make(before[match]) else { continue }
            // Headings change level in place; other blocks start from a paragraph.
            if line.block.type != "paragraph", !(type == "heading" && line.block.type == "heading") { return nil }
            if type == line.block.type, type != "heading" { return nil }
            return .type(type, props: props, remove: before.utf16.count)
        }
        return nil
    }

    public struct Inline: Equatable, Sendable {
        public var runs: [DocumentRun]
        public var caret: Int
    }

    /// A closing delimiter just typed at `caret` formats what it closes.
    public static func inline(_ runs: [DocumentRun], caret: Int) -> Inline? {
        let units = Array(DocumentEdits.slice(runs, 0..<caret).map(\.text).joined().utf16)
        guard units.count == caret else { return nil }
        let delimiters: [(String, String)] = [("**", "bold"), ("__", "bold"), ("~~", "strike"), ("*", "italic"), ("_", "italic"), ("`", "code")]
        for (delimiter, mark) in delimiters {
            let d = Array(delimiter.utf16)
            guard caret >= 2 * d.count + 1, Array(units[(caret - d.count)..<caret]) == d else { continue }
            // The opening delimiter: the nearest one before, with text between that doesn't start or end in a space.
            var start = caret - d.count - 1
            var found: Int?
            while start - d.count + 1 >= 0 {
                let open = start - d.count + 1
                if Array(units[open...start]) == d {
                    found = open
                    break
                }
                start -= 1
            }
            guard let open = found else { continue }
            let inner = (open + d.count)..<(caret - d.count)
            guard !inner.isEmpty else { continue }
            let space: UInt16 = 0x20
            if units[inner.lowerBound] == space || units[inner.upperBound - 1] == space { continue }
            // `**` isn't two italics, and an `*` inside a word after a letter isn't one either.
            if d.count == 1, open > 0, units[open - 1] == d[0] { continue }
            if d.count == 1, units[inner.upperBound - 1] == d[0] { continue }
            if delimiter == "_", open > 0, let scalar = Unicode.Scalar(units[open - 1]), CharacterSet.alphanumerics.contains(scalar) { continue }
            if mark != "code", DocumentEdits.slice(runs, inner).contains(where: { $0.marks["code"] != nil }) { continue }
            let total = DocumentEdits.length(runs)
            var middle = DocumentEdits.setting(DocumentEdits.slice(runs, inner), mark, .object([]), in: 0..<inner.count)
            if mark == "code" { middle = middle.map { DocumentRun($0.text, marks: $0.marks.filter { $0.key == "code" }) } }
            let out = DocumentEdits.concat(DocumentEdits.concat(DocumentEdits.slice(runs, 0..<open), middle), DocumentEdits.slice(runs, caret..<total))
            return Inline(runs: out, caret: caret - 2 * d.count)
        }
        return nil
    }
}
