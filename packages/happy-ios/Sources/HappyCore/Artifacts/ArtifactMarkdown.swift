import Foundation

/// Where a reference in an artifact's Markdown leads. API.md: relative
/// references inside a Markdown entry resolve against the entry's own URL,
/// exactly as a browser resolves them, and every file of a version lives
/// under the same prefix; a client rendering the entry itself resolves
/// each link and image the same way and loads it through the file route.
public enum ArtifactReference: Equatable, Sendable {
    /// A file of the same version, by its manifest `path`, and the
    /// fragment after `#`, if any. Whether the manifest holds it is the
    /// caller's to check.
    case file(String, fragment: String?)
    /// Only a fragment: a place in the same document.
    case fragment(String)
    /// An http(s) address, which the phone reaches only through the agent
    /// connection.
    case web(URL)
    /// A `data:` picture, read where it is written.
    case data(URL)
    /// Any other scheme (`mailto:`, `tel:`), for the system to open.
    case external(URL)
    /// Malformed, or a path that leaves the artifact.
    case refused
}

public enum ArtifactMarkdown {
    /// Resolves `raw`, as written in the document at `document` (a manifest
    /// path), against that document's folder. `..` never climbs above the
    /// version's root; a path that would is refused, as is one whose
    /// segments decode to a separator, a backslash or a control character
    /// (the daemon serves none of them). A leading `/` starts at the
    /// version's root rather than leaving the artifact for the host's.
    public static func resolve(_ raw: String, from document: String) -> ArtifactReference {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // `<a b.png>` is CommonMark's way to write a destination with spaces.
        if text.hasPrefix("<"), let close = text.firstIndex(of: ">") {
            text = String(text[text.index(after: text.startIndex)..<close])
        } else if let space = text.firstIndex(where: { $0 == " " || $0 == "\t" }) {
            // `url "title"`: the title is not part of the address.
            text = String(text[..<space])
        }
        guard !text.isEmpty, !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return .refused }
        if text.hasPrefix("//") {
            guard let url = URL(string: "https:" + text), url.host?.isEmpty == false else { return .refused }
            return .web(url)
        }
        if let scheme = scheme(of: text) {
            guard let url = URL(string: text) else { return .refused }
            switch scheme {
            case "http", "https": return url.host?.isEmpty == false ? .web(url) : .refused
            case "data": return .data(url)
            case "javascript", "file", "vbscript": return .refused
            default: return .external(url)
            }
        }
        var fragment: String?
        if let hash = text.firstIndex(of: "#") {
            fragment = String(text[text.index(after: hash)...])
            text = String(text[..<hash])
        }
        if let query = text.firstIndex(of: "?") { text = String(text[..<query]) }
        if text.isEmpty {
            guard let fragment else { return .refused }
            return .fragment(fragment.removingPercentEncoding ?? fragment)
        }
        var segments: [String] = []
        if !text.hasPrefix("/") {
            segments = document.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            segments.removeLast()
        }
        let parts = text.split(separator: "/", omittingEmptySubsequences: false)
        for (index, part) in parts.enumerated() {
            guard let decoded = String(part).removingPercentEncoding,
                  !decoded.contains("/"), !decoded.contains("\\"),
                  !decoded.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return .refused }
            switch decoded {
            case ".": continue
            case "..":
                guard !segments.isEmpty else { return .refused }
                segments.removeLast()
            case "":
                // A leading `/`, or `a//b`; a trailing `/` names a folder.
                if index == parts.count - 1, index > 0 { return .refused }
            default:
                segments.append(decoded)
            }
        }
        guard !segments.isEmpty else { return .refused }
        return .file(segments.joined(separator: "/"), fragment: fragment)
    }

    /// RFC 3986's `scheme ":"`, lowercased; nil for a relative reference.
    static func scheme(of text: String) -> String? {
        guard let colon = text.firstIndex(of: ":") else { return nil }
        let scheme = text[..<colon]
        guard let first = scheme.unicodeScalars.first, first.isASCIILetter,
              scheme.unicodeScalars.allSatisfy({ $0.isASCIILetter || ("0"..."9").contains($0) || "+-.".unicodeScalars.contains($0) }) else { return nil }
        // A path segment may hold a colon (`a:b.png` is a scheme by the
        // grammar, but `./a:b.png` is not); a single letter is a drive.
        return scheme.count > 1 ? scheme.lowercased() : nil
    }

    /// The document as the conversation renderer reads it, with every
    /// picture on a line of its own, where its parser looks for one:
    /// soft breaks joined, `<img>` and `<video>` written as Markdown
    /// images, a picture inside a paragraph moved out between the words
    /// around it, and a linked picture (`[![a](p)](l)`) shown as itself.
    /// Code is left as written.
    public static func prepare(_ markdown: String) -> String {
        var out: [String] = []
        var fence: String?
        for line in Markdown.joiningSoftBreaks(markdown).split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(line)
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            if let open = fence {
                out.append(text)
                if trimmed.hasPrefix(open) { fence = nil }
                continue
            }
            if let marker = Markdown.fenceMarker(trimmed) {
                fence = marker
                out.append(text)
                continue
            }
            // A table keeps its cells; a picture can't be drawn in one.
            if trimmed.hasPrefix("|") {
                out.append(text)
                continue
            }
            out += split(html(text))
        }
        return out.joined(separator: "\n")
    }

    /// Every picture `prepare`d Markdown shows, as written, in order.
    public static func pictures(_ prepared: String) -> [String] {
        var found: [String] = []
        var fence: String?
        for line in prepared.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let open = fence {
                if trimmed.hasPrefix(open) { fence = nil }
                continue
            }
            if let marker = Markdown.fenceMarker(trimmed) {
                fence = marker
                continue
            }
            let ns = trimmed as NSString
            if let match = Patterns.wholeImage.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) {
                found.append(ns.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespaces))
            }
        }
        return found
    }

    /// `<img src alt>`, `<video src>` and `<source src>` as Markdown images.
    /// On a line that had one, the tags wrapped around it (`<p
    /// align="center">`, `<a>`, `<video controls>`) go: drawn, they would
    /// read as code.
    static func html(_ line: String) -> String {
        guard line.contains("<") else { return line }
        var result = line
        var images: [String] = []
        for pattern in [Patterns.media, Patterns.source] {
            let ns = result as NSString
            for match in pattern.matches(in: result, range: NSRange(location: 0, length: ns.length)).reversed() {
                let tag = ns.substring(with: match.range)
                guard let source = attribute("src", in: tag), !source.contains(">") else { continue }
                let alt = (attribute("alt", in: tag) ?? "").replacingOccurrences(of: "]", with: "")
                // Held out while the wrappers go, so an address is never taken for a tag.
                result = (result as NSString).replacingCharacters(in: match.range, with: "\u{1}\(images.count)\u{1}")
                images.append("![\(alt)](<\(source)>)")
            }
        }
        guard !images.isEmpty else { return result }
        result = Patterns.wrapper.stringByReplacingMatches(in: result, range: NSRange(location: 0, length: (result as NSString).length), withTemplate: " ")
        for (index, image) in images.enumerated() {
            result = result.replacingOccurrences(of: "\u{1}\(index)\u{1}", with: image)
        }
        return result
    }

    /// A picture as the renderer's parser reads it: its address's
    /// parentheses escaped, which its pattern would stop at.
    static func normalized(_ image: String) -> String {
        guard let open = image.range(of: "]("), image.hasSuffix(")") else { return image }
        let destination = image[open.upperBound..<image.index(before: image.endIndex)]
        guard destination.contains("(") || destination.contains(")") else { return image }
        let escaped = destination.replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")
        return image[..<open.upperBound] + escaped + ")"
    }

    static func attribute(_ name: String, in tag: String) -> String? {
        let ns = tag as NSString
        for match in Patterns.attribute.matches(in: tag, range: NSRange(location: 0, length: ns.length)) {
            guard ns.substring(with: match.range(at: 1)).lowercased() == name else { continue }
            for group in 2...4 where match.range(at: group).location != NSNotFound {
                return decodeEntities(ns.substring(with: match.range(at: group)))
            }
        }
        return nil
    }

    static func decodeEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        return text.replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// The line with each picture on a line of its own, outside code spans.
    static func split(_ line: String) -> [String] {
        let ns = line as NSString
        let all = NSRange(location: 0, length: ns.length)
        let code = Patterns.codeSpan.matches(in: line, range: all).map(\.range)
        let images = Patterns.linkedImage.matches(in: line, range: all).map { ($0.range, $0.range(at: 1)) }
            + Patterns.image.matches(in: line, range: all).map { ($0.range, $0.range) }
        var pieces: [(range: NSRange, image: NSRange)] = []
        for (range, image) in images.sorted(by: { $0.0.location < $1.0.location }) {
            guard !code.contains(where: { NSIntersectionRange($0, range).length > 0 }),
                  !pieces.contains(where: { NSIntersectionRange($0.range, range).length > 0 }) else { continue }
            pieces.append((range, image))
        }
        guard !pieces.isEmpty else { return [line] }
        var out: [String] = []
        var cursor = 0
        // Whatever opens the line (a list's marker, a quote's `>`) stays with the words before.
        for piece in pieces {
            let before = ns.substring(with: NSRange(location: cursor, length: piece.range.location - cursor))
            if !before.trimmingCharacters(in: .whitespaces).isEmpty { out.append(before.trimmingCharacters(in: .whitespaces)) }
            out.append(normalized(ns.substring(with: piece.image)))
            cursor = piece.range.location + piece.range.length
        }
        let after = ns.substring(from: cursor).trimmingCharacters(in: .whitespaces)
        if !after.isEmpty { out.append(after) }
        return out
    }

    enum Patterns {
        nonisolated(unsafe) static let image = regex(#"!\[[^\]]*\]\((?:<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)"#)
        nonisolated(unsafe) static let linkedImage = regex(#"\[(!\[[^\]]*\]\((?:<[^>]*>|[^()\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\))\]\([^)]*\)"#)
        /// What the conversation renderer's parser takes as a picture.
        nonisolated(unsafe) static let wholeImage = regex(#"^!\[([^\]]*)\]\(([^)]+)\)$"#)
        nonisolated(unsafe) static let media = regex(#"<(?:img|video)\b[^>]*\bsrc\s*=[^>]*>"#, caseInsensitive: true)
        nonisolated(unsafe) static let source = regex(#"<source\b[^>]*\bsrc\s*=[^>]*>"#, caseInsensitive: true)
        nonisolated(unsafe) static let wrapper = regex(#"</?(?:p|div|center|a|picture|span|figure|video|br)\b[^>]*>"#, caseInsensitive: true)
        nonisolated(unsafe) static let attribute = regex(#"([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#)
        nonisolated(unsafe) static let codeSpan = regex(#"`+[^`]*`+"#)

        static func regex(_ pattern: String, caseInsensitive: Bool = false) -> NSRegularExpression {
            // swiftlint:disable:next force_try
            try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
        }
    }
}

private extension Unicode.Scalar {
    var isASCIILetter: Bool { ("a"..."z").contains(self) || ("A"..."Z").contains(self) }
}
