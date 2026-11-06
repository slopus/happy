import Foundation

/// A document's Markdown, as the daemon projects it: a port of
/// happy-agent's `blocksToMarkdown.ts`. Used for copying a document as
/// Markdown and to check, here, that opening and editing never changes
/// what the daemon reads.
///
/// The daemon also parses each block's inline Markdown back and drops
/// emphasis that would not survive; this port keeps every format, which
/// matches the daemon for everything the editor writes (see
/// `DocumentMarkdownTests` for the corpus it is held to).
public enum DocumentMarkdown {
    public static func markdown(_ blocks: [DocumentBlock]) -> String {
        var omitted = Set<String>()
        let text = serialize(blocks, indent: "", omitted: &omitted)
        return text.isEmpty ? "" : text + "\n"
    }

    /// What the Markdown leaves out: underline, colors, alignment, toggles, nesting.
    public static func omitted(_ blocks: [DocumentBlock]) -> Set<String> {
        var omitted = Set<String>()
        _ = serialize(blocks, indent: "", omitted: &omitted)
        return omitted
    }

    private static func serialize(_ blocks: [DocumentBlock], indent: String, omitted: inout Set<String>) -> String {
        var chunks: [(text: String, type: String)] = []
        var number = 0
        for block in blocks {
            number = block.type == "numberedListItem" ? number + 1 : 0
            if case .unsupported = block.content { continue }
            recordProps(block, &omitted)
            let lines = ownMarkdown(block, number: number, omitted: &omitted)
            let continuation = indent + String(repeating: " ", count: markerWidth(block, number))
            var text = lines.enumerated().map { ($0.offset == 0 ? indent : continuation) + $0.element }.joined(separator: "\n")
            if !block.children.isEmpty {
                if DocumentSchema.listTypes.contains(block.type) {
                    let gap = DocumentSchema.listTypes.contains(block.children[0].type) ? "\n" : "\n\n"
                    text += gap + serialize(block.children, indent: continuation, omitted: &omitted)
                } else {
                    omitted.insert("nesting")
                    text += "\n\n" + serialize(block.children, indent: indent, omitted: &omitted)
                }
            }
            chunks.append((text, block.type))
        }
        var out = ""
        for (index, chunk) in chunks.enumerated() {
            if index > 0 {
                let previous = chunks[index - 1]
                let sameList = DocumentSchema.listTypes.contains(chunk.type) && (previous.type == chunk.type || (bulletLike(previous.type) && bulletLike(chunk.type)))
                out += sameList ? "\n" : "\n\n"
            }
            out += chunk.text
        }
        return out
    }

    private static func bulletLike(_ type: String) -> Bool { ["bulletListItem", "checkListItem", "toggleListItem"].contains(type) }

    private static func markerWidth(_ block: DocumentBlock, _ number: Int) -> Int {
        if block.type == "numberedListItem" { return "\(number). ".count }
        return DocumentSchema.listTypes.contains(block.type) ? 2 : 0
    }

    private struct Context { var table: Bool; var singleLine: Bool }

    private static func ownMarkdown(_ block: DocumentBlock, number: Int, omitted: inout Set<String>) -> [String] {
        let props = block.props
        func lines(_ singleLine: Bool = false) -> [String] {
            inline(block.runs, Context(table: false, singleLine: singleLine), &omitted).components(separatedBy: "\n")
        }
        switch block.type {
        case "heading":
            let level = min(6, max(1, block.level))
            var text = lines(true).first ?? ""
            if let range = text.range(of: #"(\s)#(#*)$"#, options: .regularExpression) {
                let hashes = text[range].dropFirst()
                text.replaceSubrange(range, with: String(text[range].prefix(1)) + "\\" + hashes)
            }
            return [String(repeating: "#", count: level) + (text.isEmpty ? "" : " " + text)]
        case "bulletListItem", "toggleListItem": return prefixed("- ", lines())
        case "numberedListItem": return prefixed("\(number). ", lines())
        case "checkListItem": return prefixed("- [\(block.checked ? "x" : " ")] ", lines())
        case "quote": return lines().map { $0.isEmpty ? ">" : "> " + $0 }
        case "codeBlock":
            let code = block.plainText
            let fence = String(repeating: "`", count: max(3, longestRun(code, "`") + 1))
            let language = block.language
            return [fence + (language == "text" ? "" : language)] + code.components(separatedBy: "\n") + [fence]
        case "divider": return ["---"]
        case "image":
            let name = props["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? props["caption"]?.stringValue ?? ""
            return ["![\(escapeText(name, Context(table: false, singleLine: true), inLink: true))](\(destination(props["url"]?.stringValue ?? "")))"]
        case "file", "audio", "video":
            let url = props["url"]?.stringValue ?? ""
            let name = props["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? url
            if url.isEmpty { return [escapeLine(escapeText(name, Context(table: false, singleLine: true), inLink: false))] }
            return ["[\(escapeText(name, Context(table: false, singleLine: true), inLink: true))](\(destination(url)))"]
        case "table":
            guard case let .table(rows) = block.content, let first = rows.first else { return [] }
            let width = max(1, rows.map(\.count).max() ?? 0)
            func render(_ row: [[DocumentRun]]) -> String {
                let cells = (0..<width).map { index in index < row.count ? inline(row[index], Context(table: true, singleLine: true), &omitted) : "" }
                return "| " + cells.joined(separator: " | ") + " |"
            }
            return [render(first), "| " + Array(repeating: "---", count: width).joined(separator: " | ") + " |"] + rows.dropFirst().map(render)
        default:
            return lines()
        }
    }

    private static func prefixed(_ marker: String, _ lines: [String]) -> [String] {
        lines.enumerated().map { $0.offset == 0 ? marker + $0.element : $0.element }
    }

    // MARK: Inline

    private enum Node {
        case text(String, Set<String>)
        case link(String, [(String, Set<String>)])
    }

    private static func inline(_ runs: [DocumentRun], _ context: Context, _ omitted: inout Set<String>) -> String {
        escapeLines(render(normalize(runs, context, &omitted), context), context)
    }

    private static func normalize(_ runs: [DocumentRun], _ context: Context, _ omitted: inout Set<String>) -> [Node] {
        func kept(_ run: DocumentRun) -> (String, Set<String>) {
            if run.marks["underline"] != nil { omitted.insert("underline") }
            if let color = run.marks["textColor"]?["stringValue"]?.stringValue, color != "default" { omitted.insert("text colors") }
            if let color = run.marks["backgroundColor"]?["stringValue"]?.stringValue, color != "default" { omitted.insert("highlights") }
            let styles = Set(["bold", "italic", "strike", "code"].filter { run.marks[$0] != nil })
            return (context.singleLine ? run.text.replacingOccurrences(of: "\n", with: " ") : run.text, styles)
        }
        var nodes: [Node] = []
        for run in runs where !run.text.isEmpty {
            let text = kept(run)
            if let href = run.marks["link"]?["href"]?.stringValue {
                if case let .link(last, content)? = nodes.last, last == href {
                    nodes[nodes.count - 1] = .link(href, content + [text])
                } else {
                    nodes.append(.link(href, [text]))
                }
            } else {
                nodes.append(.text(text.0, text.1))
            }
        }
        return sharedWhitespace(nodes.map { node in
            if case let .link(href, content) = node {
                return .link(href, sharedWhitespaceTexts(content.filter { !$0.0.isEmpty }))
            }
            return node
        })
    }

    private static func isBlank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private static func sharedWhitespace(_ nodes: [Node]) -> [Node] {
        nodes.enumerated().map { index, node in
            guard case let .text(text, _) = node, isBlank(text) else { return node }
            func styles(_ other: Node?) -> Set<String> { if case let .text(_, s)? = other { return s }; return [] }
            let before = styles(index > 0 ? nodes[index - 1] : nil)
            let after = styles(index + 1 < nodes.count ? nodes[index + 1] : nil)
            return .text(text, before.intersection(after).intersection(["bold", "italic", "strike"]))
        }
    }

    private static func sharedWhitespaceTexts(_ texts: [(String, Set<String>)]) -> [(String, Set<String>)] {
        texts.enumerated().map { index, item in
            guard isBlank(item.0) else { return item }
            let before = index > 0 ? texts[index - 1].1 : []
            let after = index + 1 < texts.count ? texts[index + 1].1 : []
            return (item.0, before.intersection(after).intersection(["bold", "italic", "strike"]))
        }
    }

    private static let delimiters = ["bold": "**", "italic": "*", "strike": "~~"]

    private static func render(_ nodes: [Node], _ context: Context) -> String {
        var out = ""
        var open: [String] = []
        func close(_ keep: [String]) {
            var shared = 0
            while shared < open.count, keep.contains(open[shared]) { shared += 1 }
            for style in open[shared...].reversed() { out += delimiters[style]! }
            open = Array(open[..<shared])
        }
        func text(_ value: String, _ marks: Set<String>, inLink: Bool) {
            let styles = ["bold", "italic", "strike"].filter { marks.contains($0) }
            let leading = String(value.prefix { $0.isWhitespace })
            let trailing = value.count > leading.count ? String(value.reversed().prefix { $0.isWhitespace }.reversed()) : ""
            let core = String(value.dropFirst(leading.count).dropLast(trailing.count))
            if core.isEmpty {
                close(styles)
                out += escapeText(value, context, inLink: inLink)
                return
            }
            close(styles)
            out += escapeText(leading, context, inLink: inLink)
            for style in styles where !open.contains(style) {
                out += delimiters[style]!
                open.append(style)
            }
            out += marks.contains("code") ? codeSpan(core) : escapeText(core, context, inLink: inLink)
            if !trailing.isEmpty {
                close([])
                out += escapeText(trailing, context, inLink: inLink)
            }
        }
        for node in nodes {
            switch node {
            case let .text(value, marks): text(value, marks, inLink: false)
            case let .link(href, content):
                close([])
                out += "["
                for (value, marks) in content { text(value, marks, inLink: true) }
                close([])
                out += "](\(destination(href)))"
            }
        }
        close([])
        return out
    }

    private static func codeSpan(_ text: String) -> String {
        let fence = String(repeating: "`", count: longestRun(text, "`") + 1)
        let pad = text.hasPrefix("`") || text.hasSuffix("`") || (text.hasPrefix(" ") && text.hasSuffix(" ") && !isBlank(text)) ? " " : ""
        return fence + pad + text + pad + fence
    }

    private static func longestRun(_ text: String, _ char: Character) -> Int {
        var longest = 0
        var run = 0
        for c in text {
            run = c == char ? run + 1 : 0
            longest = max(longest, run)
        }
        return longest
    }

    /// A link destination as markdown-it's `normalizeLink` would give it back.
    static func destination(_ href: String) -> String {
        guard !href.isEmpty else { return "" }
        let url = normalizeLink(href)
        if url.contains(where: { $0.isWhitespace || "<>()".contains($0) }) {
            return "<" + url.replacingOccurrences(of: "<", with: "%3C").replacingOccurrences(of: ">", with: "%3E").replacingOccurrences(of: "\n", with: "%0A") + ">"
        }
        return url.replacingOccurrences(of: "\\", with: "\\\\")
    }

    /// mdurl's `encode`: percent-encodes what is not URL-safe, keeping existing escapes.
    static func normalizeLink(_ href: String) -> String {
        let keep = Set(";/?:@&=+$,-_.!~*'()#".unicodeScalars).union(Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".unicodeScalars))
        let scalars = Array(href.unicodeScalars)
        var out = ""
        var i = 0
        while i < scalars.count {
            let c = scalars[i]
            if c == "%", i + 2 < scalars.count, scalars[i + 1].properties.isASCIIHexDigit, scalars[i + 2].properties.isASCIIHexDigit {
                out.unicodeScalars.append(contentsOf: scalars[i...i + 2])
                i += 3
                continue
            }
            if keep.contains(c) {
                out.unicodeScalars.append(c)
            } else {
                for byte in String(c).utf8 { out += String(format: "%%%02X", byte) }
            }
            i += 1
        }
        return out
    }

    private static let punctuation: Set<Character> = Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

    /// Escapes only what Markdown would read as inline syntax (`escapeText`).
    private static func escapeText(_ text: String, _ context: Context, inLink: Bool) -> String {
        let chars = Array(text)
        var out = ""
        func space(_ c: Character?) -> Bool { c?.isWhitespace ?? false }
        func word(_ c: Character?) -> Bool { c.map { $0.isLetter || $0.isNumber } ?? false }
        for (index, char) in chars.enumerated() {
            let before: Character? = index > 0 ? chars[index - 1] : nil
            let after: Character? = index + 1 < chars.count ? chars[index + 1] : nil
            var escape = false
            switch char {
            case "\\": escape = after == nil || after == "\n" || punctuation.contains(after!)
            case "`", "[": escape = true
            case "]": escape = inLink
            case "*": escape = !(space(before) && space(after))
            case "_": escape = !((word(before) && word(after)) || (space(before) && space(after)))
            case "~": escape = before == "~" || after == "~"
            case "<": escape = after.map { $0.isASCII && ($0.isLetter || "/!?".contains($0)) } ?? false
            case "&": escape = String(chars[index...]).range(of: #"^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});"#, options: .regularExpression) != nil
            case "|": escape = context.table
            default: break
            }
            if escape { out += "\\" }
            out.append(char)
        }
        return out
    }

    private static func escapeLines(_ markdown: String, _ context: Context) -> String {
        let lines = markdown.components(separatedBy: "\n")
        return lines.enumerated().map { index, line in
            var escaped = escapeLine(line)
            if index < lines.count - 1 { escaped += "\\" }
            return escaped
        }.joined(separator: context.singleLine ? " " : "\n")
    }

    /// Keeps a line from starting block syntax, and keeps its outer whitespace.
    private static func escapeLine(_ line: String) -> String {
        guard !line.isEmpty else { return line }
        let indent = String(line.prefix { $0 == " " || $0 == "\t" })
        var rest = String(line.dropFirst(indent.count))
        if rest.range(of: #"^#{1,6}(\s|$)"#, options: .regularExpression) != nil
            || rest.hasPrefix(">")
            || rest.range(of: #"^[-+](\s|$)"#, options: .regularExpression) != nil
            || rest.range(of: #"^[-=]+\s*$"#, options: .regularExpression) != nil
            || rest.hasPrefix("~~~") {
            rest = "\\" + rest
        } else if let match = rest.range(of: #"^\d{1,9}[.)](\s|$)"#, options: .regularExpression) {
            let digits = rest[match].prefix { $0.isNumber }
            rest = String(digits) + "\\" + rest.dropFirst(digits.count)
        }
        var out = indent.isEmpty ? rest : entity(indent.first!) + String(indent.dropFirst()) + rest
        if let last = out.last, last == " " || last == "\t", out.contains(where: { $0 != " " && $0 != "\t" }) {
            out = String(out.dropLast()) + entity(last)
        }
        return out
    }

    private static func entity(_ c: Character) -> String { c == "\t" ? "&#9;" : "&#32;" }

    private static func recordProps(_ block: DocumentBlock, _ omitted: inout Set<String>) {
        if let c = block.props["textColor"]?.stringValue, c != "default" { omitted.insert("text colors") }
        if let c = block.props["backgroundColor"]?.stringValue, c != "default" { omitted.insert("highlights") }
        if let a = block.props["textAlignment"]?.stringValue, a != "left" { omitted.insert("alignment") }
        if block.type == "toggleListItem" || block.props["isToggleable"]?.boolValue == true { omitted.insert("toggles") }
    }
}
