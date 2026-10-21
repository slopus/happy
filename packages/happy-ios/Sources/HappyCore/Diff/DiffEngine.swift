import Foundation

/// engine/buildDiff.ts: raw patches and blob pairs into render-ready
/// `DiffDocument`s. These builders retain no documents. Account renderers
/// reuse parsing, tab expansion and word diffing through DiffDocumentCache.
/// Safe to call from any thread.
public enum DiffEngine {
    public struct Options: Equatable, Sendable {
        /// Context lines when diffing two blobs; patches keep their own.
        public var contextLines: Int
        /// Fold away whitespace-only changes when diffing two blobs.
        public var ignoreWhitespace: Bool
        /// Gives up on an expensive blob diff before it can stall.
        public var budget: Budget?
        /// Word-level emphasis inside changed lines.
        public var intraline: Bool
        /// Tabs are expanded at build time so column math is exact.
        public var tabWidth: Int
        /// Files with more lines than this skip the word diff.
        public var maxHighlightLines: Int

        public init(
            contextLines: Int = 3,
            ignoreWhitespace: Bool = false,
            budget: Budget? = nil,
            intraline: Bool = true,
            tabWidth: Int = 4,
            maxHighlightLines: Int = 8000
        ) {
            self.contextLines = contextLines
            self.ignoreWhitespace = ignoreWhitespace
            self.budget = budget
            self.intraline = intraline
            self.tabWidth = tabWidth
            self.maxHighlightLines = maxHighlightLines
        }
    }

    /// `DiffBudget`: both limits go to the line diff; the timeout also bounds
    /// the word emphasis.
    public struct Budget: Equatable, Sendable {
        public var timeoutMs: Double
        public var maxEditLength: Int

        public init(timeoutMs: Double, maxEditLength: Int) {
            self.timeoutMs = timeoutMs
            self.maxEditLength = maxEditLength
        }
    }

    /// The copy a budgeted build reports when it gives up.
    public static let tooLargeError = "Diff is too large to render on this device."

    // MARK: Building

    public static func build(patch: String, options: Options = Options()) -> DiffDocument {
        buildUncached(patch: patch, options: options)
    }

    /// Explicit owners call these builders without retaining any global state.
    static func buildUncached(patch: String, options: Options) -> DiffDocument {
        let started = ContinuousClock.now
        let files = DiffPatchParser.parse(patch).map { buildFile($0, options) }
        return finish(files, started: started)
    }

    public static func build(path: String, oldText: String, newText: String, options: Options = Options()) -> DiffDocument {
        buildUncached(path: path, oldText: oldText, newText: newText, options: options)
    }

    static func buildUncached(path: String, oldText: String, newText: String, options: Options) -> DiffDocument {
        let started = ContinuousClock.now
        let emphasisDeadline = options.budget.map { Date().addingTimeInterval($0.timeoutMs / 1000) }
        let hunks: [DiffPatchParser.RawHunk]
        do {
            hunks = try DiffPatchParser.hunksFromContents(
                oldText, newText,
                contextLines: options.contextLines,
                ignoreWhitespace: options.ignoreWhitespace,
                budget: options.budget.map { MyersDiff.Budget(timeoutMs: $0.timeoutMs, maxEditLength: $0.maxEditLength) }
            )
        } catch {
            // Not cached: a later attempt may have more time.
            return DiffDocument(files: [], additions: 0, deletions: 0, buildMs: milliseconds(since: started), error: tooLargeError)
        }
        let kind: FileChangeKind = oldText.isEmpty && !newText.isEmpty ? .added
            : newText.isEmpty && !oldText.isEmpty ? .deleted
            : .modified
        let raw = DiffPatchParser.RawFile(path: path, kind: kind, hunks: hunks)
        return finish([buildFile(raw, options, emphasisDeadline: emphasisDeadline)], started: started)
    }

    private static func finish(_ files: [DiffFile], started: ContinuousClock.Instant) -> DiffDocument {
        DiffDocument(
            files: files,
            additions: files.reduce(0) { $0 + $1.additions },
            deletions: files.reduce(0) { $0 + $1.deletions },
            buildMs: milliseconds(since: started)
        )
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let elapsed = ContinuousClock.now - start
        return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
    }

    static func buildFile(_ raw: DiffPatchParser.RawFile, _ options: Options, emphasisDeadline: Date? = nil) -> DiffFile {
        let language = DiffLanguage.detect(raw.path)
        let totalLines = raw.hunks.reduce(0) { $0 + $1.lines.count }
        let rich = totalLines <= options.maxHighlightLines

        var rows: [DiffRow] = []
        var additions = 0
        var deletions = 0
        var maxColumns = 0
        var maxLineNo = 0
        var previousOldEnd: Int?

        for (hunkIndex, hunk) in raw.hunks.enumerated() {
            // Tabs first: every offset afterwards refers to the expanded text,
            // which is also what is drawn.
            let lines = hunk.lines.map { line -> DiffPatchParser.RawLine in
                var line = line
                line.text = expandTabs(line.text, width: options.tabWidth)
                return line
            }

            let hidden = previousOldEnd.map { hunk.oldStart - $0 } ?? hunk.oldStart - 1
            rows.append(.hunk(DiffHunk(
                key: "h\(hunkIndex)",
                text: "@@ -\(hunk.oldStart),\(hunk.oldLines) +\(hunk.newStart),\(hunk.newLines) @@",
                section: DiffText.trim(hunk.section),
                hidden: hidden > 0 ? hidden : nil
            )))
            previousOldEnd = hunk.oldStart + hunk.oldLines

            let emphasis = rich && options.intraline ? DiffIntraline.computeEmphasis(lines, deadline: emphasisDeadline) : [:]

            for (lineIndex, line) in lines.enumerated() {
                if line.type == .add { additions += 1 } else if line.type == .del { deletions += 1 }
                let length = line.text.utf16.count
                let runs = length > 0 ? [DiffSyntaxRun(.plain, length)] : []
                let spans = mergeSpans(line.text, runs: runs, ranges: emphasis[lineIndex], emphasis: line.type == .add ? .inserted : .deleted)
                maxColumns = max(maxColumns, length)
                maxLineNo = max(maxLineNo, line.oldNo ?? 0, line.newNo ?? 0)
                rows.append(.line(DiffLine(
                    key: "\(hunkIndex):\(lineIndex)",
                    type: line.type,
                    oldNo: line.oldNo,
                    newNo: line.newNo,
                    text: line.text,
                    spans: spans
                )))
            }
        }

        if raw.kind == .binary {
            rows.append(.message(key: "binary", code: .binary))
        } else if rows.isEmpty {
            rows.append(.message(key: "empty", code: .empty))
        }

        return DiffFile(
            path: raw.path,
            oldPath: raw.oldPath.flatMap { $0 != raw.path ? $0 : nil },
            kind: raw.kind,
            language: language,
            additions: additions,
            deletions: deletions,
            rows: rows,
            maxColumns: maxColumns,
            maxLineNo: maxLineNo
        )
    }

    // MARK: Spans

    /// Lays word-diff ranges over syntax runs, splitting at every boundary
    /// of either and joining neighbours of the same class and emphasis.
    public static func mergeSpans(_ text: String, runs: [DiffSyntaxRun], ranges: [DiffIntraline.Range]?, emphasis: DiffEmphasis) -> [DiffSpan] {
        let units = Array(text.utf16)
        guard !units.isEmpty else { return [] }

        var spans: [DiffSpan] = []
        var pieces: [(from: Int, to: Int, kind: DiffSpanKind, emphasis: DiffEmphasis)] = []
        func append(_ from: Int, _ to: Int, _ kind: DiffSpanKind, _ value: DiffEmphasis) {
            guard to > from else { return }
            if let last = pieces.last, last.kind == kind, last.emphasis == value, last.to == from {
                pieces[pieces.count - 1].to = to
            } else {
                pieces.append((from, to, kind, value))
            }
        }

        var position = 0
        var rangeIndex = 0
        for run in runs {
            let runEnd = min(position + run.length, units.count)
            guard let ranges, !ranges.isEmpty else {
                append(position, runEnd, run.kind, .none)
                position = runEnd
                continue
            }
            var cursor = position
            while cursor < runEnd {
                while rangeIndex < ranges.count, ranges[rangeIndex].upperBound <= cursor { rangeIndex += 1 }
                guard rangeIndex < ranges.count, ranges[rangeIndex].lowerBound < runEnd else {
                    append(cursor, runEnd, run.kind, .none)
                    break
                }
                let range = ranges[rangeIndex]
                if range.lowerBound > cursor {
                    append(cursor, range.lowerBound, run.kind, .none)
                    cursor = range.lowerBound
                }
                let end = min(range.upperBound, runEnd)
                append(cursor, end, run.kind, emphasis)
                cursor = end
            }
            position = runEnd
        }
        // Trailing text when the runs came up short.
        if position < units.count { append(position, units.count, .plain, .none) }

        for piece in pieces {
            spans.append(DiffSpan(DiffText.string(units, piece.from..<piece.to), piece.kind, piece.emphasis))
        }
        return spans
    }

    static func expandTabs(_ text: String, width: Int) -> String {
        guard text.utf8.contains(UInt8(ascii: "\t")) else { return text }
        var out = String.UnicodeScalarView()
        var column = 0
        for scalar in text.unicodeScalars {
            if scalar == "\t" {
                let pad = width - (column % width)
                out.append(contentsOf: repeatElement(" ", count: pad))
                column += pad
            } else {
                out.append(scalar)
                column += scalar.utf16.count
            }
        }
        return String(out)
    }

    // MARK: Cache

    // DiffDocumentCache uses this compact fingerprint only to select a bucket;
    // it verifies the full typed source and options before reusing a document.
    static func cacheKey(_ prefix: String, _ input: String, _ options: Options) -> String {
        let flags = "\(options.contextLines):\(options.ignoreWhitespace ? 1 : 0):0:\(options.intraline ? 1 : 0):\(options.tabWidth):\(options.maxHighlightLines)"
        let budget = options.budget.map { ":budget:\($0.timeoutMs):\($0.maxEditLength)" } ?? ""
        return "\(prefix):\(flags)\(budget):\(input.utf16.count):\(String(fnv1a(input), radix: 36))"
    }

    /// FNV-1a over the UTF-16 units, as the JavaScript key hashes them.
    static func fnv1a(_ input: String) -> UInt32 {
        var hash: UInt32 = 0x811c9dc5
        for unit in input.utf16 {
            hash ^= UInt32(unit)
            hash = hash &+ (hash << 1) &+ (hash << 4) &+ (hash << 7) &+ (hash << 8) &+ (hash << 24)
        }
        return hash
    }
}

/// A run of `length` UTF-16 units of one syntax class (`SyntaxRun`).
public struct DiffSyntaxRun: Equatable, Sendable {
    public var kind: DiffSpanKind
    public var length: Int

    public init(_ kind: DiffSpanKind, _ length: Int) {
        self.kind = kind
        self.length = length
    }
}
