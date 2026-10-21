import Foundation

/// components/diff/engine/highlight.ts and syntax/{protocol,tokenize}.ts:
/// Prism's tokens folded into the dozen colours the theme has, per line,
/// for one contiguous hunk at a time.
public enum DiffSyntax {
    /// How long a first paint waits for colour. The tokenizer also starts
    /// no new pass once it is spent; none of this can stop a regex that is
    /// already running.
    public static let revealMilliseconds = 1000
    public static let maxCharacters = 128_000
    public static let maxLine = 2000
    public static let maxLines = 2000
    public static let maxRuns = 20_000

    /// A contiguous hunk, or a code block whose lines are all context.
    public struct Input: Hashable, Sendable {
        public struct Line: Hashable, Sendable {
            public var text: String
            public var type: DiffLineType

            public init(text: String, type: DiffLineType) {
                self.text = text
                self.type = type
            }
        }

        public var language: String
        public var lines: [Line]

        public init(language: String, lines: [Line]) {
            self.language = language
            self.lines = lines
        }
    }

    public enum Status: Equatable, Sendable {
        case highlighted
        /// No grammar for the language.
        case unsupported
        /// Past the size limits or the time budget: stays plain.
        case limited
    }

    public struct Result: Equatable, Sendable {
        public var status: Status
        /// One run list per input line; empty unless highlighted.
        public var runs: [[DiffSyntaxRun]]

        public init(status: Status, runs: [[DiffSyntaxRun]] = []) {
            self.status = status
            self.runs = runs
        }
    }

    /// `withinSyntaxLimits`, in UTF-16 units.
    public static func withinLimits(_ input: Input) -> Bool {
        guard input.lines.count <= maxLines else { return false }
        var characters = 0
        for line in input.lines {
            let length = line.text.utf16.count
            if length > maxLine { return false }
            characters += length + 1
            if characters > maxCharacters { return false }
        }
        return true
    }

    /// syntax/tokenize.ts: each side of the hunk tokenized whole (comments
    /// and strings can span lines), then each line takes its new side's
    /// runs, or its old side's when it only has that.
    public static func tokenize(_ input: Input, budget: Duration = .milliseconds(revealMilliseconds)) -> Result {
        let started = ContinuousClock.now
        func expired() -> Bool { ContinuousClock.now - started >= budget }
        guard withinLimits(input) else { return Result(status: .limited) }
        guard Prism.hasGrammar(input.language) else { return Result(status: .unsupported) }
        var oldLines: [String] = []
        var newLines: [String] = []
        for line in input.lines {
            if line.type != .add { oldLines.append(line.text) }
            if line.type != .del { newLines.append(line.text) }
        }
        let oldRuns = oldLines.isEmpty ? [] : highlightLines(oldLines.joined(separator: "\n"), language: input.language)
        // Prism is synchronous: this keeps more work from starting after
        // the budget, it doesn't cut a running tokenize short.
        if expired() { return Result(status: .limited) }
        let unchanged = input.lines.allSatisfy { $0.type == .ctx }
        let newRuns = unchanged ? oldRuns : newLines.isEmpty ? [] : highlightLines(newLines.joined(separator: "\n"), language: input.language)
        if expired() { return Result(status: .limited) }
        var oldIndex = 0
        var newIndex = 0
        var runCount = 0
        let runs = input.lines.map { line -> [DiffSyntaxRun] in
            var old: [DiffSyntaxRun]?
            var new: [DiffSyntaxRun]?
            if line.type != .add {
                old = oldIndex < oldRuns.count ? oldRuns[oldIndex] : nil
                oldIndex += 1
            }
            if line.type != .del {
                new = newIndex < newRuns.count ? newRuns[newIndex] : nil
                newIndex += 1
            }
            let result = new ?? old ?? []
            runCount += result.count
            return result
        }
        return runCount > maxRuns ? Result(status: .limited) : Result(status: .highlighted, runs: runs)
    }

    /// highlight.ts's `highlightLines`: one run list per line of `text`.
    /// Without a grammar, or if tokenizing fails, every line is plain.
    public static func highlightLines(_ text: String, language: String?) -> [[DiffSyntaxRun]] {
        let units = Array(text.utf16)
        func plainLines() -> [[DiffSyntaxRun]] {
            units.split(separator: 10, omittingEmptySubsequences: false).map { line in
                line.isEmpty ? [] : [DiffSyntaxRun(.plain, line.count)]
            }
        }
        guard let language, Prism.hasGrammar(language),
              let tokens = try? Prism.tokenize(text, language: language) else { return plainLines() }
        let lineCount = units.isEmpty ? 1 : units.reduce(1) { $1 == 10 ? $0 + 1 : $0 }

        var lines: [[DiffSyntaxRun]] = []
        var current: [DiffSyntaxRun] = []
        func push(_ kind: DiffSpanKind, _ count: Int) {
            guard count > 0 else { return }
            if let last = current.last, last.kind == kind {
                current[current.count - 1].length += count
            } else {
                current.append(DiffSyntaxRun(kind, count))
            }
        }
        func emit(_ location: Int, _ length: Int, _ kind: DiffSpanKind) {
            var start = location
            let end = location + length
            var index = location
            while index < end {
                if units[index] == 10 {
                    push(kind, index - start)
                    lines.append(current)
                    current = []
                    start = index + 1
                }
                index += 1
            }
            push(kind, end - start)
        }
        func walk(_ nodes: [Prism.Node], _ inherited: DiffSpanKind) {
            for node in nodes {
                switch node {
                case .text(let location, let length):
                    emit(location, length, inherited)
                case .token(let type, let content):
                    let kind = classify(type)
                    walk(content, kind == .plain ? inherited : kind)
                }
            }
        }
        walk(tokens, .plain)
        lines.append(current)
        // Walking tokens must not change the line count.
        while lines.count < lineCount { lines.append([]) }
        return lines
    }

    /// Prism's ~80 token names in the theme's dozen colours. Aliases are
    /// not consulted, as in highlight.ts.
    public static func classify(_ type: String) -> DiffSpanKind {
        switch type {
        case "keyword", "boolean", "null", "important", "atrule", "rule", "directive", "entity":
            .keyword
        case "string", "char", "regex", "template-string", "attr-value", "url":
            .string
        case "comment", "prolog", "doctype", "cdata", "docstring":
            .comment
        case "number", "hexcode", "unit":
            .number
        case "function", "method", "function-variable", "macro":
            .function
        case "class-name", "builtin", "symbol", "namespace", "selector":
            .type
        case "operator", "arrow":
            .operator
        case "punctuation", "interpolation-punctuation":
            .punctuation
        case "tag", "script":
            .tag
        case "attr-name", "property", "parameter":
            .attr
        case "variable", "constant":
            .variable
        default:
            .plain
        }
    }
}
