import Foundation

// A port of happy-app's components/markdown/parseMarkdown.ts,
// parseMarkdownBlock.ts, parseMarkdownSpans.ts and linkUtils.ts. The chat,
// the message detail and the text selection screen all render what this
// returns, so it must read agent output exactly as happy-app does, quirks
// included. Positions are UTF-16 offsets throughout, as in JavaScript, and
// the regular expressions are happy-app's own, run by NSRegularExpression.

public struct MarkdownSpan: Equatable, Hashable, Sendable {
    public enum Style: String, Equatable, Hashable, Sendable {
        case italic
        case bold
        case semibold
        case code
    }

    public var styles: [Style]
    public var text: String
    public var url: String?

    public init(styles: [Style] = [], text: String, url: String? = nil) {
        self.styles = styles
        self.text = text
        self.url = url
    }
}

public struct MarkdownListItem: Equatable, Hashable, Sendable {
    public var depth: Int
    public var spans: [MarkdownSpan]

    public init(depth: Int, spans: [MarkdownSpan]) {
        self.depth = depth
        self.spans = spans
    }
}

public struct MarkdownNumberedItem: Equatable, Hashable, Sendable {
    public var number: Int
    public var depth: Int
    public var spans: [MarkdownSpan]

    public init(number: Int, depth: Int, spans: [MarkdownSpan]) {
        self.number = number
        self.depth = depth
        self.spans = spans
    }
}

public enum MarkdownBlock: Equatable, Hashable, Sendable {
    case text([MarkdownSpan])
    case header(level: Int, [MarkdownSpan])
    case list([MarkdownListItem])
    case numberedList([MarkdownNumberedItem])
    case codeBlock(language: String?, content: String)
    case mermaid(String)
    case horizontalRule
    /// `<options><option>…</option></options>`: tappable replies.
    case options([String])
    case table(headers: [[MarkdownSpan]], rows: [[[MarkdownSpan]]])
    case image(alt: String, url: String)
}

public enum Markdown {
    /// parseMarkdown.ts.
    public static func parse(_ markdown: String) -> [MarkdownBlock] {
        parseBlocks(markdown)
    }

    /// linkUtils.ts `isHttpMarkdownLink`: only http(s) links open.
    public static func isHTTPLink(_ url: String) -> Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://")
    }

    /// The text a block contributes to a plain-text copy, for the copy
    /// buttons and text selection.
    public static func plainText(_ spans: [MarkdownSpan]) -> String {
        spans.map(\.text).joined()
    }

    // MARK: Blocks (parseMarkdownBlock.ts)

    static func parseBlocks(_ markdown: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let lines = markdown.jsSplit("\n")
        var index = 0
        outer: while index < lines.count {
            let line = lines[index]
            index += 1

            for level in 1...6 where line.hasPrefix(String(repeating: "#", count: level) + " ") {
                let content = trim(String(line.utf16Dropping(level + 1)))
                blocks.append(.header(level: level, parseSpans(content, header: true)))
                continue outer
            }

            let trimmed = trim(line)

            if trimmed.hasPrefix("```") {
                let language = trim(String(trimmed.utf16Dropping(3)))
                var content: [String] = []
                while index < lines.count {
                    let next = lines[index]
                    if trim(next) == "```" {
                        index += 1
                        break
                    }
                    content.append(next)
                    index += 1
                }
                let body = content.joined(separator: "\n")
                if language == "mermaid" {
                    blocks.append(.mermaid(body))
                } else {
                    blocks.append(.codeBlock(language: language.isEmpty ? nil : language, content: body))
                }
                continue
            }

            if trimmed == "---" {
                blocks.append(.horizontalRule)
                continue
            }

            if trimmed.hasPrefix("<options>") {
                var items: [String] = []
                while index < lines.count {
                    let next = lines[index]
                    if trim(next) == "</options>" {
                        index += 1
                        break
                    }
                    if let match = Patterns.option.firstMatch(in: next), let item = match.group(1, in: next) {
                        items.append(item)
                    }
                    index += 1
                }
                if !items.isEmpty {
                    blocks.append(.options(items))
                }
                continue
            }

            if let match = Patterns.image.firstMatch(in: trimmed),
               let alt = match.group(1, in: trimmed), let url = match.group(2, in: trimmed) {
                blocks.append(.image(alt: alt, url: trim(url)))
                continue
            }

            if let match = Patterns.numbered.firstMatch(in: trimmed) {
                let indent = leadingWhitespace(line)
                var rows = [(number: number(match.group(1, in: trimmed)), indent: indent, content: String(trimmed.utf16Dropping(match.range.length)))]
                while index < lines.count {
                    let raw = lines[index]
                    let nextTrimmed = trim(raw)
                    guard let next = Patterns.numbered.firstMatch(in: nextTrimmed) else { break }
                    rows.append((number(next.group(1, in: nextTrimmed)), leadingWhitespace(raw), String(nextTrimmed.utf16Dropping(next.range.length))))
                    index += 1
                }
                let base = rows[0].indent
                blocks.append(.numberedList(rows.map {
                    MarkdownNumberedItem(number: $0.number, depth: floorHalf($0.indent - base), spans: parseSpans($0.content, header: false))
                }))
                continue
            }

            if let match = Patterns.bullet.firstMatch(in: trimmed) {
                let indent = leadingWhitespace(line)
                var rows = [(indent: indent, content: String(trimmed.utf16Dropping(match.range.length)))]
                while index < lines.count {
                    let raw = lines[index]
                    let nextTrimmed = trim(raw)
                    guard let next = Patterns.bullet.firstMatch(in: nextTrimmed) else { break }
                    rows.append((leadingWhitespace(raw), String(nextTrimmed.utf16Dropping(next.range.length))))
                    index += 1
                }
                let base = rows[0].indent
                blocks.append(.list(rows.map {
                    MarkdownListItem(depth: floorHalf($0.indent - base), spans: parseSpans($0.content, header: false))
                }))
                continue
            }

            if trimmed.contains("|") && !trimmed.hasPrefix("```") {
                let (table, next) = parseTable(lines, start: index - 1)
                if let table {
                    blocks.append(table)
                    index = next
                    continue outer
                }
            }

            if !trimmed.isEmpty {
                blocks.append(.text(parseSpans(trimmed, header: false)))
            }
        }
        return blocks
    }

    /// Splits a pipe-delimited row, dropping only the empty cells the outer
    /// pipes make and keeping empty cells inside.
    static func splitTableRow(_ line: String) -> [String] {
        var cells = trim(line).jsSplit("|").map(trim)
        if cells.first == "" { cells.removeFirst() }
        if cells.last == "" { cells.removeLast() }
        return cells
    }

    static func parseTable(_ lines: [String], start: Int) -> (MarkdownBlock?, Int) {
        var index = start
        var tableLines: [String] = []
        // LLMs often put blank lines between rows; they don't end the table.
        while index < lines.count {
            if lines[index].contains("|") {
                tableLines.append(lines[index])
                index += 1
            } else if trim(lines[index]).isEmpty {
                index += 1
            } else {
                break
            }
        }
        guard tableLines.count >= 2 else { return (nil, start) }

        let separator = trim(tableLines[1])
        guard Patterns.tableSeparator.firstMatch(in: separator) != nil, separator.contains("-") else {
            return (nil, start)
        }

        let headers = splitTableRow(tableLines[0]).map { parseSpans($0, header: false) }
        guard !headers.isEmpty else { return (nil, start) }

        var rows: [[[MarkdownSpan]]] = []
        for line in tableLines.dropFirst(2) {
            let cells = splitTableRow(line).map { parseSpans($0, header: false) }
            if !cells.isEmpty { rows.append(cells) }
        }
        return (.table(headers: headers, rows: rows), index)
    }

    // MARK: Spans (parseMarkdownSpans.ts)

    public static func parseSpans(_ markdown: String, header: Bool) -> [MarkdownSpan] {
        var spans: [MarkdownSpan] = []
        let source = markdown as NSString
        var last = 0
        for match in Patterns.spans.matches(in: markdown) {
            if match.range.location > last {
                pushText(&spans, source.substring(with: NSRange(location: last, length: match.range.location - last)), styles: [])
            }
            if match.has(1) {
                let text = match.group(2, in: markdown) ?? ""
                pushText(&spans, text, styles: header ? [] : [.bold])
            } else if match.has(3) {
                let text = match.group(4, in: markdown) ?? ""
                pushText(&spans, text, styles: header ? [] : [.italic])
            } else if match.has(5) {
                let label = match.group(6, in: markdown) ?? ""
                if let url = match.group(7, in: markdown), !url.isEmpty {
                    spans.append(MarkdownSpan(text: label, url: url))
                } else {
                    // A link without its URL part reads as the bracketed text.
                    pushText(&spans, "[\(label)]", styles: [])
                }
            } else if match.has(8) {
                spans.append(MarkdownSpan(styles: [.code], text: match.group(9, in: markdown) ?? ""))
            }
            last = match.range.location + match.range.length
        }
        if last < source.length {
            pushText(&spans, source.substring(from: last), styles: [])
        }
        return spans
    }

    /// Plain text with bare http(s) URLs turned into links, trailing
    /// punctuation left outside them.
    static func pushText(_ spans: inout [MarkdownSpan], _ text: String, styles: [MarkdownSpan.Style]) {
        guard !text.isEmpty else { return }
        let source = text as NSString
        var last = 0
        for match in Patterns.url.matches(in: text) {
            if match.range.location > last {
                spans.append(MarkdownSpan(styles: styles, text: source.substring(with: NSRange(location: last, length: match.range.location - last))))
            }
            var url = source.substring(with: match.range)
            var trailing = ""
            while let end = url.utf16.last, trailingPunctuation.contains(end) {
                trailing = String(url.utf16Suffix(1)) + trailing
                url = String(url.utf16DroppingLast(1))
            }
            if !url.isEmpty { spans.append(MarkdownSpan(styles: styles, text: url, url: url)) }
            if !trailing.isEmpty { spans.append(MarkdownSpan(styles: styles, text: trailing)) }
            last = match.range.location + match.range.length
        }
        if last < source.length {
            spans.append(MarkdownSpan(styles: styles, text: source.substring(from: last)))
        }
    }

    private static let trailingPunctuation: Set<UInt16> = Set("),.;:!?".utf16)

    // MARK: JavaScript string helpers

    /// `String.prototype.trim`: whitespace and line terminators at both ends.
    static func trim(_ string: String) -> String {
        string.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `line.length - line.trimStart().length`.
    static func leadingWhitespace(_ line: String) -> Int {
        let start = line.unicodeScalars.prefix { CharacterSet.whitespacesAndNewlines.contains($0) }
        return start.reduce(0) { $0 + $1.utf16.count }
    }

    /// `Math.floor(n / 2)`, which rounds negative halves down too.
    static func floorHalf(_ value: Int) -> Int {
        Int((Double(value) / 2).rounded(.down))
    }

    /// `parseInt` of a run of digits; absurdly long runs saturate.
    static func number(_ digits: String?) -> Int {
        guard let digits else { return 0 }
        return Int(digits) ?? Int.max
    }
}

/// happy-app's regular expressions. NSRegularExpression is immutable and
/// safe to share between threads.
enum Patterns {
    nonisolated(unsafe) static let spans = regex(#"(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))"#)
    nonisolated(unsafe) static let url = regex(#"https?://[^\s<]+"#)
    nonisolated(unsafe) static let option = regex(#"<option>(.*?)</option>"#)
    nonisolated(unsafe) static let image = regex(#"^!\[([^\]]*)\]\(([^)]+)\)$"#)
    nonisolated(unsafe) static let numbered = regex(#"^(\d+)\.\s+"#)
    nonisolated(unsafe) static let bullet = regex(#"^([-*+])\s+"#)
    nonisolated(unsafe) static let tableSeparator = regex(#"^[|\s\-:=]*$"#)

    static func regex(_ pattern: String, options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // The patterns are literals; a typo is a programming error.
        try! NSRegularExpression(pattern: pattern, options: options)
    }
}

extension NSRegularExpression {
    func matches(in string: String) -> [NSTextCheckingResult] {
        matches(in: string, range: NSRange(location: 0, length: (string as NSString).length))
    }

    func firstMatch(in string: String) -> NSTextCheckingResult? {
        firstMatch(in: string, range: NSRange(location: 0, length: (string as NSString).length))
    }
}

extension NSTextCheckingResult {
    /// Whether a capture group took part in the match (JavaScript's
    /// `match[n]` being truthy needs a non-empty group, see `group`).
    func has(_ group: Int) -> Bool {
        group < numberOfRanges && range(at: group).location != NSNotFound && range(at: group).length > 0
    }

    func group(_ group: Int, in string: String) -> String? {
        guard group < numberOfRanges else { return nil }
        let range = range(at: group)
        guard range.location != NSNotFound else { return nil }
        return (string as NSString).substring(with: range)
    }
}

extension String {
    /// `split(separator)` on one UTF-16 unit, as JavaScript splits. Swift's
    /// own split works on characters, where "\r\n" is one character and
    /// would not split on "\n".
    func jsSplit(_ separator: Unicode.Scalar) -> [String] {
        let unit = UInt16(separator.value)
        return utf16.split(separator: unit, omittingEmptySubsequences: false).map { String($0) ?? String(decoding: Array($0), as: UTF16.self) }
    }

    /// `slice(n)` in UTF-16 units, as JavaScript counts.
    func utf16Dropping(_ count: Int) -> Substring {
        let units = utf16
        guard let start = units.index(units.startIndex, offsetBy: count, limitedBy: units.endIndex) else { return "" }
        return self[start...]
    }

    func utf16DroppingLast(_ count: Int) -> Substring {
        let units = utf16
        guard let end = units.index(units.endIndex, offsetBy: -count, limitedBy: units.startIndex) else { return "" }
        return self[..<end]
    }

    func utf16Suffix(_ count: Int) -> Substring {
        let units = utf16
        guard let start = units.index(units.endIndex, offsetBy: -count, limitedBy: units.startIndex) else { return self[...] }
        return self[start...]
    }
}
