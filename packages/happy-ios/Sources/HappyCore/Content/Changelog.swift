import Foundation

/// What's New: happy-app's sources/changelog/changelog.json, bundled as is.
public struct Changelog: Decodable, Equatable, Sendable {
    public struct Entry: Decodable, Equatable, Sendable {
        public var title: String
        public var summary: String
        public var markdown: String
    }

    public var entries: [Entry]

    public static func decode(_ data: Data) throws -> Changelog {
        try JSONDecoder().decode(Changelog.self, from: data)
    }
}

/// The little markdown the changelog uses: `- ` bullets, paragraphs,
/// `**bold**` and `[label](url)` links.
public enum ChangelogMarkdown {
    public enum Span: Equatable, Sendable {
        case text(String, bold: Bool)
        case link(String, url: String)
    }

    public enum Block: Equatable, Sendable {
        case bullet([Span])
        case paragraph([Span])
    }

    public static func parse(_ markdown: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(spans(paragraph.joined(separator: " "))))
            paragraph = []
        }
        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                flushParagraph()
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flushParagraph()
                blocks.append(.bullet(spans(String(line.dropFirst(2)))))
            } else {
                paragraph.append(line)
            }
        }
        flushParagraph()
        return blocks
    }

    /// Inline spans. Unclosed markers are kept as text.
    public static func spans(_ text: String) -> [Span] {
        var spans: [Span] = []
        var plain = ""
        var bold = false
        var index = text.startIndex
        func flush() {
            guard !plain.isEmpty else { return }
            spans.append(.text(plain, bold: bold))
            plain = ""
        }
        while index < text.endIndex {
            let rest = text[index...]
            if rest.hasPrefix("**"), bold || rest.dropFirst(2).contains("**") {
                flush()
                bold.toggle()
                index = text.index(index, offsetBy: 2)
                continue
            }
            if rest.hasPrefix("["),
               let close = rest.range(of: "]("),
               let end = rest[close.upperBound...].firstIndex(of: ")") {
                let label = String(rest[rest.index(after: rest.startIndex)..<close.lowerBound])
                let url = String(rest[close.upperBound..<end])
                if !label.contains("]") {
                    flush()
                    spans.append(.link(label, url: url))
                    index = text.index(after: end)
                    continue
                }
            }
            plain.append(text[index])
            index = text.index(after: index)
        }
        flush()
        return spans
    }
}
