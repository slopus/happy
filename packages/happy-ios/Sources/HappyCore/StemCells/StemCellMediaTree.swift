import Foundation
import HappyWire

/// A layout an agent wrote for media it showed (happy-agent `API.md`: a
/// `media` presentation's `tree`, and "Media layouts in text"): typed nodes,
/// never HTML. A presentation's tree arrives parsed; a block in the agent's
/// text is parsed here, the way `parseMediaLayoutHtml` parses it.
public struct StemCellMediaTree: Equatable, Sendable {
    public indirect enum Node: Equatable, Sendable {
        case element(tag: String, style: [String: String], children: [Node])
        /// The item at `index` of the media the tree arranges.
        case item(index: Int, alt: String?, style: [String: String])
        case text(String)
        case lineBreak
    }

    public var root: [Node]

    public init(root: [Node]) {
        self.root = root
    }

    static let tags: Set<String> = ["div", "section", "figure", "figcaption", "p", "span", "strong", "em", "code"]
    static let blockTags: Set<String> = ["div", "section", "figure", "figcaption", "p"]

    // MARK: A presentation's tree

    /// Desktop's `mediaLayoutProject`: a `tree` layout as the phone can draw
    /// it, every item exactly once. An index out of range or named again is
    /// skipped, an unknown tag holds its content as a `div`, and every item
    /// the tree never named follows it. Nil for any other layout.
    public static func decode(_ layout: JSONValue?, itemCount: Int) -> StemCellMediaTree? {
        guard layout?["type"]?.stringValue == "tree", let values = layout?["root"]?.arrayValue else { return nil }
        var seen = Set<Int>()
        var root = nodes(values, itemCount: itemCount, seen: &seen, depth: 0)
        for index in 0..<itemCount where !seen.contains(index) { root.append(.item(index: index, alt: nil, style: [:])) }
        return root.isEmpty ? nil : StemCellMediaTree(root: root)
    }

    /// Deeper than the daemon ever sends (it stops at 12); a guard, not a limit.
    static let maxDecodeDepth = 32

    static func nodes(_ values: [JSONValue], itemCount: Int, seen: inout Set<Int>, depth: Int) -> [Node] {
        var result: [Node] = []
        for value in values {
            switch value["type"]?.stringValue {
            case "break":
                result.append(.lineBreak)
            case "text":
                if let text = value["text"]?.stringValue, !text.isEmpty { result.append(.text(text)) }
            case "item":
                guard let number = value["index"]?.numberValue, number == number.rounded(), number >= 0, number < Double(itemCount) else { continue }
                guard seen.insert(Int(number)).inserted else { continue }
                let alt = value["alt"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
                result.append(.item(index: Int(number), alt: alt, style: style(value["style"])))
            case "element":
                guard depth < maxDecodeDepth, let tag = value["tag"]?.stringValue else { continue }
                let children = nodes(value["children"]?.arrayValue ?? [], itemCount: itemCount, seen: &seen, depth: depth + 1)
                result.append(.element(tag: tags.contains(tag) ? tag : "div", style: style(value["style"]), children: children))
            default:
                continue
            }
        }
        return result
    }

    /// The fields the subset names with values its grammar accepts; any
    /// other is left out, as a client must.
    static func style(_ value: JSONValue?) -> [String: String] {
        guard let object = value?.objectValue else { return [:] }
        var style: [String: String] = [:]
        for (key, value) in object {
            if let text = value.stringValue, let normalized = StemCellMediaTreeStyle.value(key, text) { style[key] = normalized }
        }
        return style
    }
}

// MARK: Layout HTML

extension StemCellMediaTree {
    /// What a layout block's HTML became.
    public struct Parsed: Equatable, Sendable {
        public var tree: StemCellMediaTree
        /// The indexes the tree places, in order, each once.
        public var placed: [Int]
        /// Content was lost to a limit: the block is then shown as written.
        public var truncated: Bool
    }

    public static let maxHTMLLength = 32 * 1024
    static let maxDepth = 12
    static let maxHTMLDepth = 32
    static let maxNodes = 500
    static let maxText = 8000
    static let maxAlt = 1000

    /// Left out together with everything inside them.
    static let droppedTags: Set<String> = [
        "applet", "area", "audio", "base", "button", "canvas", "dialog", "embed", "form", "frame", "frameset", "head",
        "iframe", "input", "link", "map", "math", "meta", "noscript", "object", "option", "portal", "script", "select",
        "slot", "source", "style", "svg", "template", "textarea", "title", "track", "video",
    ]

    /// `parseMediaLayoutHtml`: the HTML read as a browser reads it, then
    /// rebuilt from what the subset allows, never failing. A tag the subset
    /// lacks is unwrapped, one that runs or loads something is left out with
    /// its content, an `<img>` whose `src` `resolve` doesn't name or that is
    /// already placed is left out.
    public static func parse(html: String, resolve: (String) -> Int?) -> Parsed {
        guard html.utf16.count <= maxHTMLLength else { return Parsed(tree: StemCellMediaTree(root: []), placed: [], truncated: true) }
        var walk = Walk()
        let body = StemCellMediaHTML.body(html)
        let root = walk.children(body.children, ignoresWhitespace: false, depth: 0, htmlDepth: 0, resolve: resolve)
        return Parsed(tree: StemCellMediaTree(root: root), placed: walk.placed, truncated: walk.truncated)
    }

    /// The reference's walk over the document, with its budgets.
    struct Walk {
        var placed: [Int] = []
        var nodes = 0
        var text = 0
        var truncated = false

        mutating func count() -> Bool {
            guard nodes < maxNodes else { truncated = true; return false }
            nodes += 1
            return true
        }

        mutating func children(_ children: [StemCellMediaHTML.Child], ignoresWhitespace: Bool, depth: Int, htmlDepth: Int, resolve: (String) -> Int?) -> [Node] {
            var converted: [Node] = []
            for child in children { convert(child, depth: depth, htmlDepth: htmlDepth, into: &converted, resolve: resolve) }
            return tidy(converted, ignoresWhitespace: ignoresWhitespace)
        }

        mutating func convert(_ child: StemCellMediaHTML.Child, depth: Int, htmlDepth: Int, into: inout [Node], resolve: (String) -> Int?) {
            switch child {
            case .text(let node):
                let collapsed = collapse(node.value)
                let room = maxText - text
                guard room > 0, count() else { truncated = true; return }
                let units = Array(collapsed.utf16)
                if units.count > room { truncated = true }
                let kept = String(decoding: units.prefix(room), as: UTF16.self)
                text += min(units.count, room)
                into.append(.text(kept))
            case .element(let element):
                let tag = element.name
                guard htmlDepth < maxHTMLDepth else { truncated = true; return }
                guard count() else { return }
                if droppedTags.contains(tag) { return }
                if tag == "img" {
                    if let item = image(element, resolve: resolve) { into.append(item) }
                    return
                }
                if tag == "br" {
                    into.append(.lineBreak)
                    return
                }
                guard tags.contains(tag), depth < maxDepth else {
                    for child in element.children { convert(child, depth: depth, htmlDepth: htmlDepth + 1, into: &into, resolve: resolve) }
                    return
                }
                let style = StemCellMediaTree.parseStyle(element.attribute("style"))
                let display = style["display"] ?? ""
                let flow = display.contains("flex") || display.contains("grid")
                into.append(.element(tag: tag, style: style, children: children(element.children, ignoresWhitespace: flow, depth: depth + 1, htmlDepth: htmlDepth + 1, resolve: resolve)))
            }
        }

        mutating func image(_ element: StemCellMediaHTML.Element, resolve: (String) -> Int?) -> Node? {
            guard let src = element.attribute("src"), let index = resolve(src), index >= 0, !placed.contains(index) else { return nil }
            placed.append(index)
            let style = StemCellMediaTree.parseStyle(element.attribute("style"))
            var alt: String?
            if let raw = element.attribute("alt") {
                let trimmed = trimJS(collapse(raw))
                let room = max(0, min(maxAlt, maxText - text))
                let units = Array(trimmed.utf16).prefix(room)
                text += units.count
                alt = units.isEmpty ? nil : String(decoding: units, as: UTF16.self)
            }
            return .item(index: index, alt: alt, style: style)
        }
    }

    /// Runs of tab, newline, form feed, return and space as one space.
    static func collapse(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var space = false
        for scalar in text.unicodeScalars {
            if StemCellMediaHTML.isSpace(scalar) {
                if !space { out.append(" ") }
                space = true
            } else {
                out.append(scalar)
                space = false
            }
        }
        return String(out)
    }

    /// JavaScript's `trim`: its whitespace and line terminators off both ends.
    static func trimJS(_ text: String) -> String {
        func isWhite(_ c: Unicode.Scalar) -> Bool {
            c == "\u{09}" || c == "\u{0A}" || c == "\u{0B}" || c == "\u{0C}" || c == "\u{0D}" || c == " " || c == "\u{A0}"
                || c == "\u{1680}" || (c.value >= 0x2000 && c.value <= 0x200A) || c == "\u{2028}" || c == "\u{2029}"
                || c == "\u{202F}" || c == "\u{205F}" || c == "\u{3000}" || c == "\u{FEFF}"
        }
        let scalars = Array(text.unicodeScalars)
        guard let first = scalars.firstIndex(where: { !isWhite($0) }), let last = scalars.lastIndex(where: { !isWhite($0) }) else { return "" }
        return String(String.UnicodeScalarView(scalars[first...last]))
    }

    /// Neighbouring text joined; whitespace that only separates blocks,
    /// starts or ends a list, or sits between a flex or grid's items, dropped.
    static func tidy(_ nodes: [Node], ignoresWhitespace: Bool) -> [Node] {
        var joined: [Node] = []
        for node in nodes {
            if case .text(let next) = node, case .text(let last)? = joined.last {
                var merged = last + next
                while merged.contains("  ") { merged = merged.replacingOccurrences(of: "  ", with: " ") }
                joined[joined.count - 1] = .text(merged)
            } else {
                joined.append(node)
            }
        }
        func isBlock(_ node: Node?) -> Bool {
            if case .element(let tag, _, _)? = node { return blockTags.contains(tag) }
            return false
        }
        return joined.enumerated().compactMap { position, node in
            guard case .text(" ") = node else { return node }
            let dropped = ignoresWhitespace || position == 0 || position == joined.count - 1
                || isBlock(joined[position - 1]) || isBlock(joined[position + 1])
            return dropped ? nil : node
        }
    }

    // MARK: Style

    /// `parseMediaLayoutHtmlStyle`: one `style` attribute's declarations in
    /// the subset, normalized; one holding a backslash or a quote is left
    /// out whole. Later declarations replace earlier ones.
    public static func parseStyle(_ source: String?) -> [String: String] {
        guard let source, !source.contains("\\"), !source.contains("\""), !source.contains("'") else { return [:] }
        var text = source
        while let open = text.range(of: "/*") {
            let close = text.range(of: "*/", range: open.upperBound..<text.endIndex)
            text.replaceSubrange(open.lowerBound..<(close?.upperBound ?? text.endIndex), with: " ")
        }
        var style: [String: String] = [:]
        for declaration in text.components(separatedBy: ";") {
            let trimmed = trimJS(declaration)
            guard !trimmed.isEmpty else { continue }
            let colon = trimmed.firstIndex(of: ":")
            let property = StemCellMediaHTML.asciiLowercase(trimJS(String(trimmed[..<(colon ?? trimmed.endIndex)])))
            guard let key = StemCellMediaTreeStyle.keys[property] else { continue }
            let value = colon.map { trimJS(String(trimmed[trimmed.index(after: $0)...])) } ?? ""
            guard let normalized = StemCellMediaTreeStyle.value(key, value) else { continue }
            style[key] = normalized
        }
        return style
    }
}

// MARK: Blocks and runs

extension StemCellMediaTree {
    /// One run of a paragraph's text with what its elements made of it.
    public struct Run: Equatable, Sendable {
        public var text: String
        public var bold = false
        public var italic = false
        public var code = false
        /// `small`, `normal`, `large` or `title`.
        public var size: String?
        /// `default`, `muted` or `accent`.
        public var tone: String?
    }

    /// The tree as boxes: containers, items, and paragraphs of inline text
    /// carrying their inherited text style. Text is drawn by the phone; the
    /// boxes are laid out by `StemCellMediaTreeLayout`.
    public indirect enum Block: Equatable, Sendable {
        case container(style: [String: String], children: [Block])
        case item(index: Int, alt: String?, style: [String: String])
        /// `align` is the inherited `textAlign`.
        case paragraph(align: String?, runs: [Run])
    }

    struct Inherited {
        var bold = false
        var italic = false
        var size: String?
        var tone: String?
        var align: String?
        var code = false

        func applying(tag: String, style: [String: String]) -> Inherited {
            var next = self
            if tag == "strong" { next.bold = true }
            if tag == "em" { next.italic = true }
            if tag == "code" { next.code = true }
            if let weight = style["fontWeight"] {
                next.bold = weight == "bold" || weight == "bolder" || (Int(weight).map { $0 >= 600 } ?? false)
            }
            if let fontStyle = style["fontStyle"] { next.italic = fontStyle != "normal" }
            if let size = style["fontSize"] { next.size = size }
            if let tone = style["tone"] { next.tone = tone }
            if let align = style["textAlign"] { next.align = align }
            return next
        }
    }

    public var blocks: [Block] {
        var out: [Block] = []
        var runs: [Run] = []
        Self.walk(root, Inherited(), runs: &runs, out: &out)
        Self.flush(&runs, align: nil, into: &out)
        return out
    }

    static func walk(_ nodes: [Node], _ inherited: Inherited, runs: inout [Run], out: inout [Block]) {
        for node in nodes {
            switch node {
            case .text(let text):
                runs.append(Run(text: text, bold: inherited.bold, italic: inherited.italic, code: inherited.code, size: inherited.size, tone: inherited.tone))
            case .lineBreak:
                runs.append(Run(text: "\n", bold: inherited.bold, italic: inherited.italic, code: inherited.code, size: inherited.size, tone: inherited.tone))
            case .item(let index, let alt, let style):
                flush(&runs, align: inherited.align, into: &out)
                out.append(.item(index: index, alt: alt, style: style))
            case .element(let tag, let style, let children):
                let display = style["display"]
                if display == "none" { continue }
                let next = inherited.applying(tag: tag, style: style)
                let inline = !blockTags.contains(tag) && (display == nil || display == "inline")
                if inline {
                    walk(children, next, runs: &runs, out: &out)
                } else {
                    flush(&runs, align: inherited.align, into: &out)
                    var inner: [Block] = []
                    var innerRuns: [Run] = []
                    walk(children, next, runs: &innerRuns, out: &inner)
                    flush(&innerRuns, align: next.align, into: &inner)
                    out.append(.container(style: style, children: inner))
                }
            }
        }
    }

    /// The runs so far as one paragraph, its outer spaces trimmed; nothing
    /// when they are only whitespace.
    static func flush(_ runs: inout [Run], align: String?, into out: inout [Block]) {
        defer { runs = [] }
        var kept = runs
        while let first = kept.first, first.text.allSatisfy({ $0 == " " }) { kept.removeFirst() }
        while let last = kept.last, last.text.allSatisfy({ $0 == " " }) { kept.removeLast() }
        guard !kept.isEmpty else { return }
        kept[0].text = String(kept[0].text.drop { $0 == " " })
        kept[kept.count - 1].text = String(kept[kept.count - 1].text.reversed().drop { $0 == " " }.reversed())
        out.append(.paragraph(align: align, runs: kept))
    }
}
