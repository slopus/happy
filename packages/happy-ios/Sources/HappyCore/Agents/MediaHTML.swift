import Foundation

/// HTML read into a document the way a browser reads it, as far as layout
/// HTML needs: the tokenizer's tags, attributes, character references and
/// raw text, and the tree builder's "in body" rules with their repairs —
/// implied end tags, paragraphs closed by blocks, the adoption agency for
/// misnested formatting and its reconstruction. Tables, forms and foreign
/// content are read as ordinary elements. `MediaTree.parse` walks
/// what this builds the way the reference walks parse5's tree.
enum MediaHTML {
    final class Element {
        let name: String
        let attributes: [(name: String, value: String)]
        var children: [Child] = []
        weak var parent: Element?

        init(_ name: String, _ attributes: [(name: String, value: String)]) {
            self.name = name
            self.attributes = attributes
        }

        func attribute(_ name: String) -> String? { attributes.first { $0.name == name }?.value }

        func append(_ element: Element) {
            element.detach()
            element.parent = self
            children.append(.element(element))
        }

        func append(text: String) {
            if case .text(let last)? = children.last { last.value += text } else { children.append(.text(Text(text))) }
        }

        func detach() {
            guard let parent else { return }
            parent.children.removeAll { if case .element(let element) = $0 { element === self } else { false } }
            self.parent = nil
        }
    }

    final class Text {
        var value: String
        init(_ value: String) { self.value = value }
    }

    enum Child {
        case element(Element)
        case text(Text)
    }

    // MARK: Tokens

    enum Token {
        case text(String)
        case start(name: String, attributes: [(name: String, value: String)])
        case end(String)
    }

    /// Elements whose content is text up to their own end tag.
    static let rawText: Set<String> = ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title", "plaintext"]
    /// Of those, the ones whose text still decodes character references.
    static let escapable: Set<String> = ["textarea", "title"]

    static func isSpace(_ c: Unicode.Scalar) -> Bool { c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{0C}" }
    static func isLetter(_ c: Unicode.Scalar) -> Bool { (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") }

    static func asciiLowercase(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { ($0 >= "A" && $0 <= "Z") ? Unicode.Scalar($0.value + 32)! : $0 }))
    }

    static func tokens(_ html: String) -> [Token] {
        // The input stream: CR and CRLF are LF.
        let s = Array(html.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").unicodeScalars)
        var tokens: [Token] = []
        var text = String.UnicodeScalarView()
        var i = 0
        func flush() {
            if !text.isEmpty { tokens.append(.text(decode(String(text), inAttribute: false))) }
            text = String.UnicodeScalarView()
        }
        func starts(_ word: String, at index: Int, folding: Bool = false) -> Bool {
            let w = Array(word.unicodeScalars)
            guard index + w.count <= s.count else { return false }
            for (offset, scalar) in w.enumerated() {
                let c = s[index + offset]
                if folding ? asciiLowercase(String(c)) != String(scalar) : c != scalar { return false }
            }
            return true
        }
        while i < s.count {
            guard s[i] == "<", i + 1 < s.count else { text.append(s[i]); i += 1; continue }
            let next = s[i + 1]
            if starts("<!--", at: i) {
                flush()
                // `<!-->` and `<!--->` end at once.
                var j = i + 4
                if starts(">", at: j) { i = j + 1; continue }
                if starts("->", at: j) { i = j + 2; continue }
                while j < s.count, !starts("-->", at: j), !starts("--!>", at: j) { j += 1 }
                i = j >= s.count ? s.count : j + (starts("-->", at: j) ? 3 : 4)
                continue
            }
            if next == "!" || next == "?" {
                // A declaration or processing instruction: a bogus comment.
                flush()
                var j = i + 2
                while j < s.count, s[j] != ">" { j += 1 }
                i = j + 1
                continue
            }
            if next == "/" {
                guard i + 2 < s.count else { text.append(s[i]); text.append(next); i += 2; continue }
                if s[i + 2] == ">" { flush(); i += 3; continue }
                guard isLetter(s[i + 2]) else {
                    flush()
                    var j = i + 2
                    while j < s.count, s[j] != ">" { j += 1 }
                    i = j + 1
                    continue
                }
                flush()
                guard let (name, _, end) = tag(s, from: i + 2) else { return tokens }
                tokens.append(.end(name))
                i = end
                continue
            }
            guard isLetter(next) else { text.append(s[i]); i += 1; continue }
            flush()
            guard let (name, attributes, end) = tag(s, from: i + 1) else { return tokens }
            tokens.append(.start(name: name, attributes: attributes))
            i = end
            guard rawText.contains(name) else { continue }
            // Raw text: everything to `</name` followed by a space, `/` or `>`.
            var j = i
            var body = String.UnicodeScalarView()
            while j < s.count {
                if s[j] == "<", name != "plaintext", starts("</" + name, at: j, folding: true) {
                    let after = j + 2 + name.unicodeScalars.count
                    if after >= s.count || isSpace(s[after]) || s[after] == "/" || s[after] == ">" { break }
                }
                body.append(s[j])
                j += 1
            }
            if !body.isEmpty {
                let raw = String(body)
                tokens.append(.text(escapable.contains(name) ? decode(raw, inAttribute: false) : raw))
            }
            guard j < s.count, let (endName, _, end) = tag(s, from: j + 2) else { return tokens }
            tokens.append(.end(endName))
            i = end
        }
        flush()
        return tokens
    }

    /// A tag's name and attributes from just past its `<` or `</`, and where
    /// it ends; nil when the input ends inside it.
    static func tag(_ s: [Unicode.Scalar], from start: Int) -> (String, [(name: String, value: String)], Int)? {
        var j = start
        var name = String.UnicodeScalarView()
        while j < s.count, !isSpace(s[j]), s[j] != "/", s[j] != ">" { name.append(s[j]); j += 1 }
        var attributes: [(name: String, value: String)] = []
        while j < s.count {
            let c = s[j]
            if isSpace(c) || c == "/" { j += 1; continue }
            if c == ">" { return (asciiLowercase(String(name)), attributes, j + 1) }
            var attribute = String.UnicodeScalarView([c])
            j += 1
            while j < s.count, !isSpace(s[j]), s[j] != "/", s[j] != ">", s[j] != "=" { attribute.append(s[j]); j += 1 }
            while j < s.count, isSpace(s[j]) { j += 1 }
            var value = ""
            if j < s.count, s[j] == "=" {
                j += 1
                while j < s.count, isSpace(s[j]) { j += 1 }
                if j < s.count, s[j] == "\"" || s[j] == "'" {
                    let quote = s[j]
                    var end = j + 1
                    while end < s.count, s[end] != quote { end += 1 }
                    guard end < s.count else { return nil }
                    value = String(String.UnicodeScalarView(s[(j + 1)..<end]))
                    j = end + 1
                } else {
                    var raw = String.UnicodeScalarView()
                    while j < s.count, !isSpace(s[j]), s[j] != ">" { raw.append(s[j]); j += 1 }
                    value = String(raw)
                }
            }
            let lowered = asciiLowercase(String(attribute))
            // The first of a repeated attribute wins.
            if !attributes.contains(where: { $0.name == lowered }) { attributes.append((lowered, decode(value, inAttribute: true))) }
        }
        return nil
    }

    // MARK: Character references

    static let named: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{A0}", "copy": "©", "reg": "®",
        "trade": "™", "hellip": "…", "mdash": "—", "ndash": "–", "lsquo": "‘", "rsquo": "’", "ldquo": "“",
        "rdquo": "”", "bull": "•", "middot": "·", "times": "×", "divide": "÷", "deg": "°", "plusmn": "±",
        "larr": "←", "rarr": "→", "uarr": "↑", "darr": "↓", "harr": "↔", "laquo": "«", "raquo": "»", "sect": "§",
        "para": "¶", "cent": "¢", "pound": "£", "euro": "€", "yen": "¥", "frac12": "½", "frac14": "¼", "frac34": "¾",
        "AMP": "&", "LT": "<", "GT": ">", "QUOT": "\"", "COPY": "©", "REG": "®",
    ]
    /// The references HTML still reads without their semicolon.
    static let legacy: [String] = [
        "AMP", "COPY", "GT", "LT", "QUOT", "REG", "amp", "cent", "copy", "deg", "divide", "frac12", "frac14", "frac34",
        "gt", "laquo", "lt", "middot", "nbsp", "para", "plusmn", "pound", "quot", "raquo", "reg", "sect", "times", "yen",
    ].sorted { $0.count > $1.count }

    /// Windows-1252's reading of the C1 range, which numeric references take.
    static let c1: [UInt32: UInt32] = [
        0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6,
        0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C,
        0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
        0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
    ]

    static func decode(_ text: String, inAttribute: Bool) -> String {
        guard text.contains("&") else { return text }
        let s = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        var i = 0
        func isAlphanumeric(_ c: Unicode.Scalar) -> Bool { isLetter(c) || (c >= "0" && c <= "9") }
        while i < s.count {
            guard s[i] == "&", i + 1 < s.count else { out.append(s[i]); i += 1; continue }
            if s[i + 1] == "#" {
                var j = i + 2
                let hex = j < s.count && (s[j] == "x" || s[j] == "X")
                if hex { j += 1 }
                var digits = ""
                while j < s.count, hex ? s[j].properties.isASCIIHexDigit : (s[j] >= "0" && s[j] <= "9") { digits.unicodeScalars.append(s[j]); j += 1 }
                guard !digits.isEmpty else { out.append(s[i]); i += 1; continue }
                if j < s.count, s[j] == ";" { j += 1 }
                var value = UInt32(digits.count > 8 ? "FFFFFFFF" : digits, radix: hex ? 16 : 10) ?? 0x110000
                if value == 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF) { value = 0xFFFD }
                value = c1[value] ?? value
                out.append(Unicode.Scalar(value) ?? "\u{FFFD}")
                i = j
                continue
            }
            var j = i + 1
            var name = ""
            while j < s.count, isAlphanumeric(s[j]), name.count < 32 { name.unicodeScalars.append(s[j]); j += 1 }
            if j < s.count, s[j] == ";", let value = named[name] {
                out.append(contentsOf: value.unicodeScalars)
                i = j + 1
                continue
            }
            // The longest legacy name the text starts with.
            if let match = legacy.first(where: { name.hasPrefix($0) }) {
                let after = i + 1 + match.unicodeScalars.count
                let next = after < s.count ? s[after] : nil
                if inAttribute, let next, next == "=" || isAlphanumeric(next) {
                    out.append(s[i]); i += 1; continue
                }
                out.append(contentsOf: named[match]!.unicodeScalars)
                i = after
                continue
            }
            out.append(s[i])
            i += 1
        }
        return String(out)
    }

    // MARK: Tree construction

    static let special: Set<String> = [
        "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote", "body", "br", "button",
        "caption", "center", "col", "colgroup", "dd", "details", "dir", "div", "dl", "dt", "embed", "fieldset", "figcaption",
        "figure", "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr",
        "html", "iframe", "img", "input", "keygen", "li", "link", "listing", "main", "marquee", "menu", "meta", "nav",
        "noembed", "noframes", "noscript", "object", "ol", "p", "param", "plaintext", "pre", "script", "search", "section",
        "select", "source", "style", "summary", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead",
        "title", "tr", "track", "ul", "wbr", "xmp",
    ]
    static let formatting: Set<String> = ["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"]
    static let closesParagraph: Set<String> = [
        "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset",
        "figcaption", "figure", "footer", "header", "hgroup", "main", "menu", "nav", "ol", "p", "search", "section",
        "summary", "ul", "pre", "listing", "form", "hr", "xmp", "plaintext",
    ]
    static let headings: Set<String> = ["h1", "h2", "h3", "h4", "h5", "h6"]
    static let void: Set<String> = ["area", "base", "basefont", "bgsound", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]
    /// What goes in the head while the body has not begun.
    static let headContent: Set<String> = ["base", "basefont", "bgsound", "link", "meta", "title", "noscript", "noframes", "style", "script", "template"]
    static let scoping: Set<String> = ["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"]
    static let impliedEnd: Set<String> = ["dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc"]
    static let blockEnds: Set<String> = [
        "address", "article", "aside", "blockquote", "button", "center", "details", "dialog", "dir", "div", "dl",
        "fieldset", "figcaption", "figure", "footer", "header", "hgroup", "listing", "main", "menu", "nav", "ol", "pre",
        "search", "section", "summary", "ul",
    ]

    /// The document's body, built from `html`.
    static func body(_ html: String) -> Element {
        var builder = Builder()
        for token in tokens(html) { builder.take(token) }
        return builder.body
    }

    struct Builder {
        let body = Element("body", [])
        var open: [Element]
        /// The active formatting elements; nil is a marker.
        var active: [Element?] = []
        var started = false
        /// A head element's content, left out until it closes.
        var discarding: (name: String, depth: Int)?

        init() { open = [body] }

        var current: Element { open[open.count - 1] }

        mutating func take(_ token: Token) {
            if let skip = discarding {
                switch token {
                case .start(let name, _) where name == skip.name: discarding = (name, skip.depth + 1)
                case .end(let name) where name == skip.name: discarding = skip.depth > 1 ? (name, skip.depth - 1) : nil
                default: break
                }
                return
            }
            if !started {
                switch token {
                case .text(let text):
                    // Whitespace before the body is not content.
                    let rest = String(text.unicodeScalars.drop { isSpace($0) })
                    guard !rest.isEmpty else { return }
                    started = true
                    take(.text(rest))
                    return
                case .end(let name):
                    guard name == "br" else { return }
                case .start(let name, _):
                    if name == "html" || name == "head" || name == "body" { if name == "body" { started = true }; return }
                    if headContent.contains(name) {
                        if !void.contains(name) { discarding = (name, 1) }
                        return
                    }
                }
                started = true
            }
            switch token {
            case .text(let text): insert(text: text)
            case .start(let name, let attributes): start(name == "image" ? "img" : name, attributes)
            case .end(let name): end(name)
            }
        }

        mutating func insert(text: String) {
            let kept = String(text.unicodeScalars.filter { $0 != "\0" })
            guard !kept.isEmpty else { return }
            reconstruct()
            current.append(text: kept)
        }

        @discardableResult
        mutating func insert(_ name: String, _ attributes: [(name: String, value: String)]) -> Element {
            let element = Element(name, attributes)
            current.append(element)
            open.append(element)
            return element
        }

        mutating func start(_ name: String, _ attributes: [(name: String, value: String)]) {
            switch name {
            case "html", "body", "head", "frameset":
                return
            case _ where headings.contains(name):
                closeParagraph()
                if headings.contains(current.name) { open.removeLast() }
                insert(name, attributes)
            case _ where closesParagraph.contains(name):
                closeParagraph()
                insert(name, attributes)
                if void.contains(name) { open.removeLast() }
            case "li", "dd", "dt":
                let matches: Set<String> = name == "li" ? ["li"] : ["dd", "dt"]
                for element in open.reversed() {
                    if matches.contains(element.name) {
                        generateImpliedEnds(except: element.name)
                        popThrough(element)
                        break
                    }
                    if special.contains(element.name), !["address", "div", "p"].contains(element.name) { break }
                }
                closeParagraph()
                insert(name, attributes)
            case "a":
                if let existing = lastActive(named: "a") {
                    adopt("a")
                    remove(active: existing)
                    open.removeAll { $0 === existing }
                }
                reconstruct()
                pushActive(insert(name, attributes))
            case "nobr":
                reconstruct()
                if inScope("nobr") {
                    adopt("nobr")
                    reconstruct()
                }
                pushActive(insert(name, attributes))
            case _ where formatting.contains(name):
                reconstruct()
                pushActive(insert(name, attributes))
            case "applet", "marquee", "object":
                reconstruct()
                insert(name, attributes)
                active.append(nil)
            case "table":
                // Without a doctype the document is in quirks mode, where a
                // table does not close a paragraph.
                insert(name, attributes)
            case _ where void.contains(name):
                reconstruct()
                insert(name, attributes)
                open.removeLast()
            default:
                reconstruct()
                insert(name, attributes)
            }
        }

        mutating func end(_ name: String) {
            switch name {
            case "body", "html":
                return
            case "br":
                start("br", [])
            case "p":
                if !inScope("p", button: true) { insert("p", []) }
                generateImpliedEnds(except: "p")
                popThrough(name: "p")
            case "li":
                guard inScope("li", list: true) else { return }
                generateImpliedEnds(except: "li")
                popThrough(name: "li")
            case "dd", "dt":
                guard inScope(name) else { return }
                generateImpliedEnds(except: name)
                popThrough(name: name)
            case _ where headings.contains(name):
                guard headings.contains(where: { inScope($0) }) else { return }
                generateImpliedEnds(except: nil)
                while let last = open.last, open.count > 1 {
                    open.removeLast()
                    if headings.contains(last.name) { break }
                }
            case _ where blockEnds.contains(name), "form":
                guard inScope(name) else { return }
                generateImpliedEnds(except: nil)
                popThrough(name: name)
            case _ where formatting.contains(name):
                adopt(name)
            case "applet", "marquee", "object":
                guard inScope(name) else { return }
                generateImpliedEnds(except: nil)
                popThrough(name: name)
                clearToMarker()
            default:
                otherEnd(name)
            }
        }

        /// "Any other end tag".
        mutating func otherEnd(_ name: String) {
            for index in open.indices.reversed() where index > 0 {
                let element = open[index]
                if element.name == name {
                    generateImpliedEnds(except: name)
                    open.removeSubrange(index...)
                    return
                }
                if special.contains(element.name) { return }
            }
        }

        mutating func closeParagraph() {
            guard inScope("p", button: true) else { return }
            generateImpliedEnds(except: "p")
            popThrough(name: "p")
        }

        mutating func generateImpliedEnds(except: String?) {
            while open.count > 1, impliedEnd.contains(current.name), current.name != except { open.removeLast() }
        }

        mutating func popThrough(name: String) {
            while open.count > 1 {
                let last = open.removeLast()
                if last.name == name { return }
            }
        }

        mutating func popThrough(_ element: Element) {
            while open.count > 1 {
                if open.removeLast() === element { return }
            }
        }

        func inScope(_ name: String, button: Bool = false, list: Bool = false) -> Bool {
            for element in open.reversed() {
                if element.name == name { return true }
                if scoping.contains(element.name) || element === body { return false }
                if button, element.name == "button" { return false }
                if list, element.name == "ol" || element.name == "ul" { return false }
            }
            return false
        }

        func elementInScope(_ target: Element) -> Bool {
            for element in open.reversed() {
                if element === target { return true }
                if scoping.contains(element.name) { return false }
            }
            return false
        }

        // MARK: Active formatting elements

        func lastActive(named name: String) -> Element? {
            for entry in active.reversed() {
                guard let element = entry else { return nil }
                if element.name == name { return element }
            }
            return nil
        }

        mutating func remove(active element: Element) {
            active.removeAll { $0 === element }
        }

        /// Pushes, keeping at most three alike since the last marker.
        mutating func pushActive(_ element: Element) {
            var alike: [Int] = []
            for index in active.indices.reversed() {
                guard let entry = active[index] else { break }
                if entry.name == element.name, entry.attributes.count == element.attributes.count,
                   entry.attributes.allSatisfy({ attribute in element.attribute(attribute.name) == attribute.value }) {
                    alike.append(index)
                }
            }
            if alike.count >= 3 { active.remove(at: alike.last!) }
            active.append(element)
        }

        mutating func clearToMarker() {
            while let last = active.popLast() { if last == nil { return } }
        }

        mutating func reconstruct() {
            guard let last = active.last, let element = last, !open.contains(where: { $0 === element }) else { return }
            var index = active.count - 1
            while index > 0 {
                guard let previous = active[index - 1], !open.contains(where: { $0 === previous }) else { break }
                index -= 1
            }
            for position in index..<active.count {
                guard let entry = active[position] else { continue }
                active[position] = insert(entry.name, entry.attributes)
            }
        }

        /// The adoption agency algorithm, for an end tag of `subject`.
        mutating func adopt(_ subject: String) {
            if current.name == subject, !active.contains(where: { $0 === current }) {
                open.removeLast()
                return
            }
            for _ in 0..<8 {
                guard let formatting = lastActive(named: subject) else { return otherEnd(subject) }
                guard let formattingIndex = open.firstIndex(where: { $0 === formatting }) else {
                    remove(active: formatting)
                    return
                }
                guard elementInScope(formatting) else { return }
                guard let furthestIndex = open.indices.first(where: { $0 > formattingIndex && special.contains(open[$0].name) }) else {
                    open.removeSubrange(formattingIndex...)
                    remove(active: formatting)
                    return
                }
                let furthest = open[furthestIndex]
                let common = open[formattingIndex - 1]
                var bookmark = active.firstIndex { $0 === formatting }!
                var node = furthest
                var nodeIndex = furthestIndex
                var lastNode = furthest
                var inner = 0
                while true {
                    inner += 1
                    nodeIndex -= 1
                    node = open[nodeIndex]
                    if node === formatting { break }
                    if inner > 3, let position = active.firstIndex(where: { $0 === node }) {
                        active.remove(at: position)
                        if position < bookmark { bookmark -= 1 }
                    }
                    guard let position = active.firstIndex(where: { $0 === node }) else {
                        open.remove(at: nodeIndex)
                        continue
                    }
                    let replacement = Element(node.name, node.attributes)
                    active[position] = replacement
                    open[nodeIndex] = replacement
                    node = replacement
                    if lastNode === furthest { bookmark = position + 1 }
                    node.append(lastNode)
                    lastNode = node
                }
                common.append(lastNode)
                let replacement = Element(formatting.name, formatting.attributes)
                for child in furthest.children {
                    if case .element(let element) = child { element.parent = replacement }
                }
                replacement.children = furthest.children
                furthest.children = []
                furthest.append(replacement)
                if let position = active.firstIndex(where: { $0 === formatting }) {
                    active.remove(at: position)
                    if position < bookmark { bookmark -= 1 }
                }
                active.insert(replacement, at: min(bookmark, active.count))
                open.removeAll { $0 === formatting }
                let below = open.firstIndex { $0 === furthest }!
                open.insert(replacement, at: below + 1)
            }
        }
    }
}
