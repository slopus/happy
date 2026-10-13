import Foundation

/// syntax/plan.ts and syntax/code.ts: which contiguous hunks of a file (or
/// which code block) to tokenize, and laying the results over the rows.
public enum DiffSyntaxPlan {
    /// One hunk to tokenize, and the line rows it covers, in order.
    public struct Hunk: Equatable, Sendable {
        public var key: String
        public var input: DiffSyntax.Input
        public var rowKeys: [String]
    }

    /// `syntaxKey`: content and language, nothing about the screen. Each
    /// piece is length-prefixed, so no text can pass for another.
    public static func key(_ input: DiffSyntax.Input) -> String {
        var key = "1:\(input.language.utf16.count):\(input.language)"
        for line in input.lines {
            key += "|\(line.type.rawValue)\(line.text.utf16.count):\(line.text)"
        }
        return key
    }

    /// `planSyntax`: whole hunks that show at least one displayed row, so
    /// comments and strings keep their context; never hidden tails, hunks
    /// past the limits, or rows that already have colour.
    public static func plan(_ file: DiffFile, displayed: [DiffRow]) -> [Hunk] {
        guard let language = file.language else { return [] }
        let wanted = Set(displayed.map(\.key))
        var hunks: [Hunk] = []
        var rows: [DiffLine] = []
        var intersects = false
        func flush() {
            defer {
                rows = []
                intersects = false
            }
            guard intersects, !rows.isEmpty, !rows.contains(where: { $0.spans.contains { $0.kind != .plain } }) else { return }
            let input = DiffSyntax.Input(language: language, lines: rows.map { .init(text: $0.text, type: $0.type) })
            guard DiffSyntax.withinLimits(input) else { return }
            hunks.append(Hunk(key: key(input), input: input, rowKeys: rows.map(\.key)))
        }
        for row in file.rows {
            guard case .line(let line) = row else {
                flush()
                continue
            }
            rows.append(line)
            if wanted.contains(line.key) { intersects = true }
        }
        flush()
        return hunks
    }

    /// `applySyntax`: the displayed rows with each highlighted hunk's
    /// colours laid under their word emphasis. Rows the results don't
    /// colour stay as they were.
    public static func apply(_ displayed: [DiffRow], hunks: [Hunk], outcomes: [String: DiffSyntax.Result]) -> [DiffRow] {
        var replacements: [String: [DiffSpan]] = [:]
        var lines: [String: DiffLine] = [:]
        for case .line(let line) in displayed { lines[line.key] = line }
        for hunk in hunks {
            guard let outcome = outcomes[hunk.key], outcome.status == .highlighted else { continue }
            for (index, key) in hunk.rowKeys.enumerated() {
                guard let line = lines[key], index < outcome.runs.count,
                      outcome.runs[index].contains(where: { $0.kind != .plain }) else { continue }
                replacements[key] = spans(line, runs: outcome.runs[index])
            }
        }
        guard !replacements.isEmpty else { return displayed }
        return displayed.map { row in
            guard case .line(var line) = row, let spans = replacements[line.key] else { return row }
            line.spans = spans
            return .line(line)
        }
    }

    /// The row's emphasis ranges kept, over the new runs.
    private static func spans(_ row: DiffLine, runs: [DiffSyntaxRun]) -> [DiffSpan] {
        var emphasis: [DiffIntraline.Range] = []
        var offset = 0
        for span in row.spans {
            let length = span.text.utf16.count
            if span.emphasis != .none { emphasis.append(offset..<(offset + length)) }
            offset += length
        }
        return DiffEngine.mergeSpans(row.text, runs: runs, ranges: emphasis, emphasis: row.type == .add ? .inserted : .deleted)
    }

    // MARK: Code blocks

    /// `MAX_CODE_SYNTAX_SPANS`: more spans than this stays one plain run.
    public static let maxCodeSpans = 2000

    /// `planCodeSyntax`: a code block as one all-context hunk, or nothing
    /// without a language or past the limits.
    public static func planCode(_ code: String, language: String?) -> (key: String, input: DiffSyntax.Input)? {
        guard let language, !code.isEmpty, code.utf16.count <= DiffSyntax.maxCharacters else { return nil }
        let lines = DiffText.lines(code, dropTrailingEmpty: false)
        guard lines.count <= DiffSyntax.maxLines else { return nil }
        let input = DiffSyntax.Input(language: language, lines: lines.map { .init(text: $0, type: .ctx) })
        guard DiffSyntax.withinLimits(input) else { return nil }
        return (key(input), input)
    }

    /// `codeSyntaxSpans`: the block's text in coloured spans, neighbours of
    /// one colour joined across lines; nil unless highlighted with some
    /// colour, or past `maxCodeSpans`.
    public static func codeSpans(_ input: DiffSyntax.Input, outcome: DiffSyntax.Result?) -> [(text: String, kind: DiffSpanKind)]? {
        guard let outcome, outcome.status == .highlighted else { return nil }
        var spans: [(text: String, kind: DiffSpanKind)] = []
        func append(_ text: Substring.UTF16View.SubSequence, _ kind: DiffSpanKind) {
            guard !text.isEmpty else { return }
            let string = String(text) ?? String(decoding: Array(text), as: UTF16.self)
            if let last = spans.last, last.kind == kind {
                spans[spans.count - 1].text += string
            } else {
                spans.append((string, kind))
            }
        }
        for (index, line) in input.lines.enumerated() {
            let units = Substring(line.text).utf16
            var offset = units.startIndex
            for run in index < outcome.runs.count ? outcome.runs[index] : [] {
                let end = units.index(offset, offsetBy: run.length, limitedBy: units.endIndex) ?? units.endIndex
                append(units[offset..<end], run.kind)
                offset = end
                if spans.count > maxCodeSpans { return nil }
            }
            append(units[offset...], .plain)
            if index < input.lines.count - 1 { append(Substring("\n").utf16[...], .plain) }
            if spans.count > maxCodeSpans { return nil }
        }
        return spans.contains { $0.kind != .plain } ? spans : nil
    }
}
