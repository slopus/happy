import Foundation

/// What's New: happy-app's sources/changelog/changelog.json, bundled as is.
public struct Changelog: Decodable, Equatable, Sendable {
    public struct Entry: Decodable, Equatable, Sendable {
        public var title: String
        public var summary: String
        public var markdown: String

        public init(title: String, summary: String, markdown: String) {
            self.title = title
            self.summary = summary
            self.markdown = markdown
        }
    }

    public var entries: [Entry]
    /// The newest entry's title, which What's New marks as read.
    public var latestTitle: String

    public init(entries: [Entry], latestTitle: String) {
        self.entries = entries
        self.latestTitle = latestTitle
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        entries = try container.decode([Entry].self, forKey: .entries)
        latestTitle = try container.decodeIfPresent(String.self, forKey: .latestTitle) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case entries
        case latestTitle
    }

    public static func decode(_ data: Data) throws -> Changelog {
        try JSONDecoder().decode(Changelog.self, from: data)
    }
}

/// A What's New summary line (changelog.tsx `parseSummary`): text, links
/// and bundled images, in order.
public enum ChangelogSummary {
    public enum Segment: Equatable, Sendable {
        case text(String)
        case link(String, url: String)
        case image(path: String)
    }

    public static func parse(_ summary: String) -> [Segment] {
        // `!\[[^\]]*\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)`, matched left to
        // right without overlap.
        let image = /!\[[^\]]*\]\(([^)]+)\)/
        let link = /\[([^\]]+)\]\(([^)]+)\)/
        var segments: [Segment] = []
        var rest = summary[...]
        var text = ""
        while !rest.isEmpty {
            if let match = rest.prefixMatch(of: image) {
                if !text.isEmpty { segments.append(.text(text)); text = "" }
                segments.append(.image(path: String(match.1)))
                rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: link) {
                if !text.isEmpty { segments.append(.text(text)); text = "" }
                segments.append(.link(String(match.1), url: String(match.2)))
                rest = rest[match.range.upperBound...]
            } else {
                text.append(rest.removeFirst())
            }
        }
        if !text.isEmpty { segments.append(.text(text)) }
        return segments
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
