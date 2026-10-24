import Foundation

/// The sidebar document: one `<nav>` of custom elements, every one of them
/// an item the person can drag, parsed into a typed tree and written back in
/// one canonical form. A port of `@slopus/happy-agent-client`'s
/// `spaceSidebarDocument.ts`, so iOS and the daemon read the same skeleton
/// from the same text. `SpaceSidebarFixtureTests` pins it against the
/// TypeScript output.
///
/// Offsets and lengths count UTF-16 code units, as JavaScript does.
public struct SpaceSidebarDocument: Equatable, Sendable {
    public var foldRibbon: SpaceSidebarFoldRibbon?
    public var items: [SpaceSidebarNode]

    public init(foldRibbon: SpaceSidebarFoldRibbon? = nil, items: [SpaceSidebarNode]) {
        self.foldRibbon = foldRibbon
        self.items = items
    }
}

public enum SpaceSidebarFoldRibbon: String, Equatable, Sendable, Codable {
    case hover, always
}

/// One node: a top-level item, or a row or session nested under a row.
/// Fields a kind does not have keep their defaults.
public struct SpaceSidebarNode: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case search, create, section, separator, space, widget
    }

    public var kind: Kind
    public var id: String
    /// A section's heading.
    public var label = ""
    /// A section folds the items after it.
    public var collapsed = false
    /// A row or session draws what is nested under it.
    public var expanded = false
    public var foldRibbon: SpaceSidebarFoldRibbon?
    /// A widget's verbatim content.
    public var html = ""
    /// A row's or session's nested rows and sessions.
    public var children: [SpaceSidebarNode] = []

    public init(kind: Kind, id: String, label: String = "", collapsed: Bool = false, expanded: Bool = false, foldRibbon: SpaceSidebarFoldRibbon? = nil, html: String = "", children: [SpaceSidebarNode] = []) {
        self.kind = kind
        self.id = id
        self.label = label
        self.collapsed = collapsed
        self.expanded = expanded
        self.foldRibbon = foldRibbon
        self.html = html
        self.children = children
    }

    public static let search = SpaceSidebarNode(kind: .search, id: "happy-search")
    public static let create = SpaceSidebarNode(kind: .create, id: "happy-create")
    public static func section(_ id: String, label: String, collapsed: Bool = false) -> SpaceSidebarNode {
        SpaceSidebarNode(kind: .section, id: id, label: label, collapsed: collapsed)
    }
    public static func separator(_ id: String) -> SpaceSidebarNode { SpaceSidebarNode(kind: .separator, id: id) }
    public static func space(_ id: String, expanded: Bool = false, foldRibbon: SpaceSidebarFoldRibbon? = nil, children: [SpaceSidebarNode] = []) -> SpaceSidebarNode {
        SpaceSidebarNode(kind: .space, id: id, expanded: expanded, foldRibbon: foldRibbon, children: children)
    }
    public static func widget(_ id: String, html: String) -> SpaceSidebarNode { SpaceSidebarNode(kind: .widget, id: id, html: html) }
}

public struct SpaceSidebarDiagnostic: Equatable, Sendable {
    public var message: String
    public var offset: Int
}

/// Why a document or an operation was refused, with where in the text.
public struct SpaceSidebarError: Error, Equatable, Sendable, CustomStringConvertible {
    public var message: String
    public var offset: Int
    /// Set for an operation that cannot apply: its zero-based place in the batch.
    public var operationIndex: Int?

    public init(_ message: String, offset: Int = 0, operationIndex: Int? = nil) {
        self.message = message
        self.offset = offset
        self.operationIndex = operationIndex
    }

    public var diagnostics: [SpaceSidebarDiagnostic] { [SpaceSidebarDiagnostic(message: message, offset: offset)] }
    public var description: String { message }
}

public enum SpaceSidebar {
    public static let maxBytes = 128 * 1024
    public static let maxElements = 1000
    public static let maxDepth = 16
    public static let maxWidgetBytes = 16 * 1024
    /// The IDs of the nodes named by their tags; no other node may use them.
    public static let reservedIDs = ["nav", "happy-search", "happy-create"]

    // MARK: Schemas

    /// `spaceSidebarIdSchema`: 1–128 UTF-16 units, no whitespace or control.
    static func isValidID(_ id: String) -> Bool {
        let units = Array(id.utf16)
        guard (1...128).contains(units.count) else { return false }
        return units.allSatisfy { !JS.isWhitespace($0) && $0 > 0x1F && $0 != 0x7F }
    }

    /// `spaceSidebarLabelSchema`: 1–256 UTF-16 units with something that is not whitespace.
    static func isValidLabel(_ label: String) -> Bool {
        let units = Array(label.utf16)
        guard (1...256).contains(units.count) else { return false }
        return units.contains { !JS.isWhitespace($0) }
    }

    // MARK: Parse

    private static let tags = ["nav", "happy-search", "happy-create", "happy-section", "happy-separator", "happy-space", "happy-widget"]
    private static let attributes: [String: (allowed: Set<String>, required: Set<String>)] = [
        "nav": (["fold-ribbon"], []),
        "happy-search": ([], []),
        "happy-create": ([], []),
        "happy-section": (["id", "label", "collapsed"], ["id", "label"]),
        "happy-separator": (["id"], ["id"]),
        "happy-space": (["id", "expanded", "fold-ribbon"], ["id"]),
        "happy-widget": (["id"], ["id"]),
    ]
    private static let children: [String: [String]] = [
        "nav": ["happy-search", "happy-create", "happy-section", "happy-separator", "happy-space", "happy-widget"],
        "happy-space": ["happy-space"],
    ]
    private static let widgetClose = "</happy-widget"

    private final class Element {
        let tag: String
        let attrs: [String: String]
        let start: Int
        var children: [Element] = []
        var content = ""
        init(tag: String, attrs: [String: String], start: Int) {
            self.tag = tag
            self.attrs = attrs
            self.start = start
        }
    }

    /// Parses and validates a whole document; throws `SpaceSidebarError`.
    public static func parse(_ html: String) throws -> SpaceSidebarDocument {
        let text = Array(html.utf16)
        if text.contains(0) { throw SpaceSidebarError("The sidebar must contain valid Unicode text without null characters.") }
        if html.utf8.count > maxBytes { throw SpaceSidebarError("The sidebar exceeds 128 KiB.") }
        var stack: [Element] = []
        var root: Element?
        var count = 0
        var at = 0
        func fail(_ message: String, _ offset: Int? = nil) -> SpaceSidebarError { SpaceSidebarError(message, offset: offset ?? at) }

        while at < text.count {
            if text[at] != 0x3C {
                var next = at
                while next < text.count && text[next] != 0x3C { next += 1 }
                if text[at..<next].contains(where: { !JS.isWhitespace($0) }) { throw fail("The sidebar holds elements, not text.") }
                at = next
                continue
            }
            let start = at
            if let (name, length) = JS.matchClose(text, at) {
                guard let node = stack.popLast(), node.tag == name else { throw fail("Closing element does not match the open element.") }
                at += length
                continue
            }
            guard let (tag, openLength) = JS.matchOpen(text, at) else { throw fail("Expected an allowed element.") }
            guard let schema = attributes[tag] else { throw fail("Element \(tag) is not allowed.") }
            at += openLength
            var attrs: [String: String] = [:]
            while at < text.count {
                let whitespace = JS.whitespaceRun(text, at)
                at += whitespace
                if at < text.count && (text[at] == 0x3E || (text[at] == 0x2F && at + 1 < text.count && text[at + 1] == 0x3E)) { break }
                if whitespace == 0 { throw fail("Attributes must be separated by whitespace.") }
                guard let (key, value, length) = JS.matchAttribute(text, at) else { throw fail("Attribute values must be quoted.") }
                if attrs[key] != nil { throw fail("Duplicate attribute \(key).") }
                attrs[key] = decodeEntities(value)
                at += length
            }
            guard attributesValid(attrs, schema) else { throw fail("Invalid attributes on \(tag).", start) }
            let selfClosing = at + 1 < text.count && text[at] == 0x2F && text[at + 1] == 0x3E
            if selfClosing && tag == "nav" { throw fail("The nav cannot be self-closing.") }
            if !(at < text.count && text[at] == 0x3E) && !selfClosing { throw fail("The opening element is incomplete.") }
            at += selfClosing ? 2 : 1
            let parent = stack.last
            if tag == "nav" && (parent != nil || root != nil) { throw fail("The sidebar needs exactly one nav root.", start) }
            if parent == nil && tag != "nav" { throw fail("The sidebar needs a nav root.", start) }
            if let parent, !(children[parent.tag] ?? []).contains(tag) {
                throw fail(parent.tag == "happy-space" ? "A happy-space may contain only happy-space elements." : "A \(parent.tag) cannot contain \(tag).", start)
            }
            count += 1
            if count > maxElements || stack.count >= maxDepth { throw fail("The sidebar exceeds 1,000 elements or depth 16.", start) }
            let node = Element(tag: tag, attrs: attrs, start: start)
            if let parent { parent.children.append(node) } else { root = node }
            if tag == "happy-widget" && !selfClosing {
                // A widget's content runs verbatim to its closing tag, which it may never contain.
                let end = JS.indexOfCaseInsensitive(text, Array(widgetClose.utf16), from: at)
                let contentStart = at
                at = end ?? start
                guard let end, let closing = JS.matchWidgetEnd(text, end) else {
                    throw fail("A widget's content may not contain \(widgetClose) other than its own closing tag.")
                }
                node.content = String(decoding: text[contentStart..<end], as: UTF16.self)
                try widgetCheck(node.content, offset: contentStart)
                at = end + closing
                continue
            }
            if !selfClosing { stack.append(node) }
        }
        guard stack.isEmpty, let root else { throw fail("The sidebar has unclosed elements or no nav root.") }
        return try documentOf(root)
    }

    private static func attributesValid(_ attrs: [String: String], _ schema: (allowed: Set<String>, required: Set<String>)) -> Bool {
        guard Set(attrs.keys).isSubset(of: schema.allowed), schema.required.isSubset(of: Set(attrs.keys)) else { return false }
        for (key, value) in attrs {
            switch key {
            case "id": if !isValidID(value) { return false }
            case "label": if !isValidLabel(value) { return false }
            case "collapsed", "expanded": if value != "true" && value != "false" { return false }
            case "fold-ribbon": if SpaceSidebarFoldRibbon(rawValue: value) == nil { return false }
            default: return false
            }
        }
        return true
    }

    /// Checks a widget's content, as parsing and every operation do.
    public static func widgetCheck(_ html: String, offset: Int = 0) throws {
        if html.utf16.contains(0) { throw SpaceSidebarError("A widget must contain valid Unicode text without null characters.", offset: offset) }
        if html.utf8.count > maxWidgetBytes { throw SpaceSidebarError("A widget's content exceeds 16 KiB.", offset: offset) }
        if JS.indexOfCaseInsensitive(Array(html.utf16), Array(widgetClose.utf16), from: 0) != nil {
            throw SpaceSidebarError("A widget's content may not contain \(widgetClose).", offset: offset)
        }
    }

    private static func documentOf(_ root: Element) throws -> SpaceSidebarDocument {
        var seen = Set(reservedIDs)
        var searches = 0
        var creates = 0
        func identify(_ node: Element) throws -> String {
            let id = node.attrs["id"]!
            if seen.contains(id) {
                throw SpaceSidebarError(reservedIDs.contains(id) ? "The ID \(id) is reserved." : "Duplicate ID \(id).", offset: node.start)
            }
            seen.insert(id)
            return id
        }
        func space(_ node: Element) throws -> SpaceSidebarNode {
            let id = try identify(node)
            return SpaceSidebarNode(
                kind: .space, id: id, expanded: node.attrs["expanded"] == "true",
                foldRibbon: node.attrs["fold-ribbon"].flatMap(SpaceSidebarFoldRibbon.init(rawValue:)),
                children: try node.children.map(space)
            )
        }
        var items: [SpaceSidebarNode] = []
        for node in root.children {
            switch node.tag {
            case "happy-search":
                searches += 1
                items.append(.search)
            case "happy-create":
                creates += 1
                items.append(.create)
            case "happy-section":
                items.append(.section(try identify(node), label: node.attrs["label"]!, collapsed: node.attrs["collapsed"] == "true"))
            case "happy-separator":
                items.append(.separator(try identify(node)))
            case "happy-widget":
                items.append(.widget(try identify(node), html: node.content))
            default:
                items.append(try space(node))
            }
        }
        if searches != 1 { throw SpaceSidebarError("The sidebar needs exactly one happy-search.") }
        if creates != 1 { throw SpaceSidebarError("The sidebar needs exactly one happy-create.") }
        return SpaceSidebarDocument(foldRibbon: root.attrs["fold-ribbon"].flatMap(SpaceSidebarFoldRibbon.init(rawValue:)), items: items)
    }

    /// `&#…;`, `&#x…;` and the five named entities, any letter case.
    static func decodeEntities(_ value: String) -> String {
        guard value.contains("&") else { return value }
        let units = Array(value.utf16)
        var out: [UInt16] = []
        var index = 0
        while index < units.count {
            if units[index] == 0x26, let semicolon = units[index...].firstIndex(of: 0x3B) {
                let body = String(decoding: units[(index + 1)..<semicolon], as: UTF16.self)
                if let replacement = entity(body) {
                    out += Array(replacement.utf16)
                    index = semicolon + 1
                    continue
                }
            }
            out.append(units[index])
            index += 1
        }
        return String(decoding: out, as: UTF16.self)
    }

    private static func entity(_ body: String) -> String? {
        let lower = body.lowercased()
        switch lower {
        case "amp": return "&"
        case "lt": return "<"
        case "gt": return ">"
        case "quot": return "\""
        case "apos": return "'"
        default: break
        }
        guard lower.hasPrefix("#") else { return nil }
        let digits = lower.dropFirst()
        let hex = digits.first == "x"
        let number = hex ? digits.dropFirst() : digits
        guard !number.isEmpty, number.allSatisfy({ hex ? $0.isHexDigit && $0.isASCII : ("0"..."9").contains($0) }) else { return nil }
        // Too large for a code point reads as one; it decodes like any other unusable value.
        let code = Int(number, radix: hex ? 16 : 10) ?? Int.max
        if code > 0 && code <= 0x10FFFF && !(0xD800...0xDFFF).contains(code), let scalar = Unicode.Scalar(code) {
            return String(Character(scalar))
        }
        return "\u{FFFD}"
    }

    // MARK: Format

    /// The canonical text: one element a line, two spaces a level, attributes
    /// in grammar order, false switches and defaults left out, empty elements
    /// self-closed, widget content verbatim. With `widgets: false` widgets
    /// are left out.
    public static func format(_ document: SpaceSidebarDocument, widgets: Bool = true) -> String {
        func attribute(_ name: String, _ value: String) -> String {
            let escaped = value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
            return " \(name)=\"\(escaped)\""
        }
        func ribbon(_ value: SpaceSidebarFoldRibbon?) -> String { value.map { attribute("fold-ribbon", $0.rawValue) } ?? "" }
        func space(_ node: SpaceSidebarNode, _ indent: String) -> String {
            let open = "\(indent)<happy-space\(attribute("id", node.id))\(node.expanded ? attribute("expanded", "true") : "")\(ribbon(node.foldRibbon))"
            if node.children.isEmpty { return "\(open)/>\n" }
            return "\(open)>\n" + node.children.map { space($0, indent + "  ") }.joined() + "\(indent)</happy-space>\n"
        }
        var out = "<nav\(ribbon(document.foldRibbon))>\n"
        for node in document.items {
            switch node.kind {
            case .search: out += "  <happy-search/>\n"
            case .create: out += "  <happy-create/>\n"
            case .section:
                out += "  <happy-section\(attribute("id", node.id))\(attribute("label", node.label))\(node.collapsed ? attribute("collapsed", "true") : "")/>\n"
            case .separator: out += "  <happy-separator\(attribute("id", node.id))/>\n"
            case .widget:
                guard widgets else { continue }
                out += node.html.isEmpty ? "  <happy-widget\(attribute("id", node.id))/>\n" : "  <happy-widget\(attribute("id", node.id))>\(node.html)</happy-widget>\n"
            case .space: out += space(node, "  ")
            }
        }
        return out + "</nav>\n"
    }
}

/// The few JavaScript text rules the port must follow exactly.
enum JS {
    /// `\s` and `String.prototype.trim`'s whitespace, by UTF-16 unit.
    static func isWhitespace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }

    static func isLower(_ unit: UInt16) -> Bool { (0x61...0x7A).contains(unit) }
    static func isNameUnit(_ unit: UInt16) -> Bool { isLower(unit) || (0x30...0x39).contains(unit) || unit == 0x2D }
    /// `\w`: ASCII letters, digits and `_`.
    static func isWordUnit(_ unit: UInt16) -> Bool {
        (0x61...0x7A).contains(unit) || (0x41...0x5A).contains(unit) || (0x30...0x39).contains(unit) || unit == 0x5F
    }

    static func whitespaceRun(_ text: [UInt16], _ at: Int) -> Int {
        var end = at
        while end < text.count && isWhitespace(text[end]) { end += 1 }
        return end - at
    }

    /// `[a-z][a-z0-9-]*` at `at`; its length.
    static func name(_ text: [UInt16], _ at: Int) -> Int {
        guard at < text.count, isLower(text[at]) else { return 0 }
        var end = at + 1
        while end < text.count && isNameUnit(text[end]) { end += 1 }
        return end - at
    }

    /// `/<\/([a-z][a-z0-9-]*)\s*>/y`
    static func matchClose(_ text: [UInt16], _ at: Int) -> (String, Int)? {
        guard at + 1 < text.count, text[at] == 0x3C, text[at + 1] == 0x2F else { return nil }
        let length = name(text, at + 2)
        guard length > 0 else { return nil }
        var end = at + 2 + length
        end += whitespaceRun(text, end)
        guard end < text.count, text[end] == 0x3E else { return nil }
        return (String(decoding: text[(at + 2)..<(at + 2 + length)], as: UTF16.self), end + 1 - at)
    }

    /// `/<([a-z][a-z0-9-]*)\b/y`, backtracking the name to a word boundary.
    static func matchOpen(_ text: [UInt16], _ at: Int) -> (String, Int)? {
        guard at < text.count, text[at] == 0x3C else { return nil }
        var length = name(text, at + 1)
        while length > 0 {
            let last = text[at + length]
            let next = at + 1 + length < text.count ? text[at + 1 + length] : nil
            if isWordUnit(last) != (next.map(isWordUnit) ?? false) { break }
            length -= 1
        }
        guard length > 0 else { return nil }
        return (String(decoding: text[(at + 1)..<(at + 1 + length)], as: UTF16.self), 1 + length)
    }

    /// `/([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y`
    static func matchAttribute(_ text: [UInt16], _ at: Int) -> (String, String, Int)? {
        let length = name(text, at)
        guard length > 0 else { return nil }
        var cursor = at + length
        cursor += whitespaceRun(text, cursor)
        guard cursor < text.count, text[cursor] == 0x3D else { return nil }
        cursor += 1
        cursor += whitespaceRun(text, cursor)
        guard cursor < text.count, text[cursor] == 0x22 || text[cursor] == 0x27 else { return nil }
        let quote = text[cursor]
        guard let close = text[(cursor + 1)...].firstIndex(of: quote) else { return nil }
        let key = String(decoding: text[at..<(at + length)], as: UTF16.self)
        let value = String(decoding: text[(cursor + 1)..<close], as: UTF16.self)
        return (key, value, close + 1 - at)
    }

    /// `/<\/happy-widget\s*>/y`
    static func matchWidgetEnd(_ text: [UInt16], _ at: Int) -> Int? {
        let tag = Array("</happy-widget".utf16)
        guard at + tag.count <= text.count, Array(text[at..<(at + tag.count)]) == tag else { return nil }
        var end = at + tag.count
        end += whitespaceRun(text, end)
        guard end < text.count, text[end] == 0x3E else { return nil }
        return end + 1 - at
    }

    /// The first ASCII-case-insensitive occurrence of `needle` from `from`.
    static func indexOfCaseInsensitive(_ text: [UInt16], _ needle: [UInt16], from: Int) -> Int? {
        func fold(_ unit: UInt16) -> UInt16 { (0x41...0x5A).contains(unit) ? unit + 0x20 : unit }
        guard needle.count <= text.count else { return nil }
        var index = from
        while index + needle.count <= text.count {
            var matches = true
            for offset in 0..<needle.count where fold(text[index + offset]) != fold(needle[offset]) {
                matches = false
                break
            }
            if matches { return index }
            index += 1
        }
        return nil
    }
}
