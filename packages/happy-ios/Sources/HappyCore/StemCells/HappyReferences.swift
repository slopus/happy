import Foundation

/// Happy reference tags (`<happy-KIND id="…"/>`) an agent writes inline in
/// its Markdown: a tag carries only identity, and the reader shows the live
/// name of what it names. A port of `@slopus/happy-agent-client`'s
/// `happyReferences.ts` and the `markdownBlocks.ts` it scans with, over
/// UTF-16 as the reference counts, so the two agree on exactly what is a
/// tag: never inside a code span or fenced code, never after a backslash,
/// and a malformed tag is ordinary text.
public enum HappyReferences {
    public struct Reference: Equatable, Hashable, Sendable {
        public var kind: String
        public var id: String
        /// An artifact's version.
        public var version: Int?
        /// A service's workspace.
        public var workspaceId: String?

        public init(kind: String, id: String, version: Int? = nil, workspaceId: String? = nil) {
            self.kind = kind
            self.id = id
            self.version = version
            self.workspaceId = workspaceId
        }
    }

    public enum Segment: Equatable, Sendable {
        case text(String)
        /// `source` is the tag exactly as written.
        case reference(Reference, source: String)
    }

    /// The kinds a reader resolves; any other well-formed kind reads as inert text.
    public static let knownKinds: Set<String> = ["artifact", "agent", "workspace", "project", "service"]

    static let maxTagLength = 512
    static let maxValueLength = 256

    /// Splits Markdown into text and references. Still `streaming`, a
    /// trailing tag that has only partly arrived is held back.
    public static func parse(_ markdown: String, streaming: Bool = false) -> [Segment] {
        let units = Array(markdown.utf16)
        let (tags, end) = scan(units, streaming: streaming)
        var segments: [Segment] = []
        var position = 0
        func text(_ from: Int, _ to: Int) -> String { String(decoding: units[from..<to], as: UTF16.self) }
        for tag in tags {
            if tag.start > position { segments.append(.text(text(position, tag.start))) }
            segments.append(.reference(tag.reference, source: text(tag.start, tag.end)))
            position = tag.end
        }
        if end > position { segments.append(.text(text(position, end))) }
        return segments
    }

    /// Every complete tag outside code replaced by `replace`'s text.
    public static func replace(_ markdown: String, streaming: Bool = false, _ replace: (Reference) -> String) -> String {
        guard markdown.contains("<") else { return markdown }
        return parse(markdown, streaming: streaming).map { segment in
            switch segment {
            case .text(let text): text
            case .reference(let reference, _): replace(reference)
            }
        }.joined()
    }

    /// Words for a reference nobody can resolve, such as "an unavailable artifact".
    public static func placeholder(_ reference: Reference) -> String {
        knownKinds.contains(reference.kind) ? "an unavailable \(reference.kind)" : "an unavailable reference"
    }

    /// Streaming text without a trailing tag still arriving, held back
    /// rather than flashed as raw text.
    public static func droppingPartialTag(_ text: String) -> String {
        guard text.contains("<") else { return text }
        let units = Array(text.utf16)
        let end = scan(units, streaming: true).end
        return end == units.count ? text : String(decoding: units[..<end], as: UTF16.self)
    }

    // MARK: Reading

    /// The scheme of the links written for references. Minted once per
    /// launch, as desktop's is, so a link an agent wrote by hand never
    /// passes for one: only a tag the grammar accepted becomes one.
    public static let linkPrefix = "happy-reference-\(UUID().uuidString.prefix(8).lowercased()):"

    /// `kind/id`, and `/version` when the reference pins one.
    public static func link(_ reference: Reference) -> String {
        "\(linkPrefix)\(reference.kind)/\(reference.id)" + (reference.version.map { "/\($0)" } ?? "")
    }

    /// The reference a link written by `markdown` points at.
    public static func reference(link: String) -> Reference? {
        guard link.hasPrefix(linkPrefix) else { return nil }
        let parts = link.dropFirst(linkPrefix.count).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 || parts.count == 3, isID(parts[1]) else { return nil }
        var reference = Reference(kind: parts[0], id: parts[1])
        if parts.count == 3 {
            guard isVersion(parts[2]) else { return nil }
            reference.version = Int(parts[2])
        }
        return reference
    }

    /// The Markdown a message is drawn from (desktop's
    /// `messageReferencesResolve`): a reference that opens is a link with
    /// its name, any other its words; a kind this build doesn't know is
    /// never asked about.
    public static func markdown(_ text: String, view: (Reference) -> StemCellReferences.View) -> String {
        replace(text) { reference in
            let shown = knownKinds.contains(reference.kind) ? view(reference) : .text(placeholder(reference))
            let name = label(shown.label).isEmpty ? label(placeholder(reference)) : label(shown.label)
            guard case .link = shown else { return name }
            return "[\(name)](\(link(reference)))"
        }
    }

    /// The same words as plain text, for what is read aloud or copied
    /// (`messageReferencesPlainText`).
    public static func plain(_ text: String, view: (Reference) -> StemCellReferences.View) -> String {
        replace(text) { reference in
            knownKinds.contains(reference.kind) ? view(reference).label : placeholder(reference)
        }
    }

    /// A name as running words on one line. The chat's Markdown has no
    /// escapes, so what would open a span or end the link goes instead.
    static func label(_ text: String) -> String {
        let oneLine = text.replacingOccurrences(of: "\\s*[\\r\\n]+\\s*", with: " ", options: .regularExpression)
        return String(oneLine.compactMap { character -> Character? in
            switch character {
            case "[": "("
            case "]": ")"
            case "*", "`": nil
            default: character
            }
        }).trimmingCharacters(in: .whitespaces)
    }

    // MARK: Scan

    private struct Tag {
        var start: Int
        var end: Int
        var reference: Reference
    }

    private static let lt = UInt16(UInt8(ascii: "<")), gt = UInt16(UInt8(ascii: ">"))
    private static let backslash = UInt16(UInt8(ascii: "\\")), backtick = UInt16(UInt8(ascii: "`")), tilde = UInt16(UInt8(ascii: "~"))
    private static let quote = UInt16(UInt8(ascii: "\"")), slash = UInt16(UInt8(ascii: "/")), equals = UInt16(UInt8(ascii: "="))
    private static let dash = UInt16(UInt8(ascii: "-")), underscore = UInt16(UInt8(ascii: "_"))
    private static let space = UInt16(UInt8(ascii: " ")), tab = UInt16(UInt8(ascii: "\t"))
    private static let cr = UInt16(UInt8(ascii: "\r")), lf = UInt16(UInt8(ascii: "\n"))
    private static let open = Array("<happy-".utf16)

    private static func isLower(_ c: UInt16) -> Bool { c >= 0x61 && c <= 0x7A }
    private static func isUpper(_ c: UInt16) -> Bool { c >= 0x41 && c <= 0x5A }
    private static func isDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }
    private static func isBlank(_ c: UInt16) -> Bool { c == space || c == tab }

    /// The complete tags outside code, and where the text ends once a streaming partial is dropped.
    private static func scan(_ units: [UInt16], streaming: Bool) -> (tags: [Tag], end: Int) {
        var tags: [Tag] = []
        for block in textBlocks(units) {
            let last = block.end == units.count
            var index = block.start
            while index < block.end {
                let character = units[index]
                if character == backslash {
                    index += 2
                } else if character == backtick {
                    index = skipCodeSpan(units, index, block.end, open: streaming && last)
                } else if character == lt {
                    if let tag = matchTag(units, index) {
                        tags.append(tag)
                        index = tag.end
                    } else if streaming, last, isTagPrefix(units[index...]) {
                        return (tags, index)
                    } else {
                        index += 1
                    }
                } else {
                    index += 1
                }
            }
        }
        return (tags, units.count)
    }

    /// `^[ \t]*(?:>[ \t]?)*[ \t]*`: where a line's quote markers end.
    private static func afterQuotes(_ line: ArraySlice<UInt16>) -> Int {
        var index = line.startIndex
        while index < line.endIndex, isBlank(line[index]) { index += 1 }
        while index < line.endIndex, line[index] == gt {
            index += 1
            if index < line.endIndex, isBlank(line[index]) { index += 1 }
        }
        while index < line.endIndex, isBlank(line[index]) { index += 1 }
        return index
    }

    private static func run(_ units: ArraySlice<UInt16>, from: Int, of character: UInt16) -> Int {
        var index = from
        while index < units.endIndex, units[index] == character { index += 1 }
        return index - from
    }

    /// `textBlocks`: the runs that are neither fenced code nor blank lines,
    /// each with its line endings. A fence never closed runs to the end.
    static func textBlocks(_ units: [UInt16]) -> [(start: Int, end: Int)] {
        var blocks: [(start: Int, end: Int)] = []
        var blockStart: Int?
        var fence: (marker: UInt16, length: Int)?
        var lineStart = 0
        while lineStart < units.count {
            let newline = units[lineStart...].firstIndex(of: lf)
            let lineEnd = newline.map { $0 + 1 } ?? units.count
            let line = units[lineStart..<(newline ?? units.count)]
            if let open = fence {
                // `^…(`+|~+)[ \t\r]*$`
                let at = afterQuotes(line)
                if at < line.endIndex, line[at] == open.marker {
                    let length = run(line, from: at, of: open.marker)
                    if length >= open.length, line[(at + length)...].allSatisfy({ isBlank($0) || $0 == cr }) { fence = nil }
                }
            } else {
                let at = afterQuotes(line)
                var opened = false
                if at < line.endIndex, line[at] == backtick || line[at] == tilde {
                    let marker = line[at]
                    let length = run(line, from: at, of: marker)
                    let info = line[(at + length)...]
                    // `(.*)$` crosses no line terminator; a backtick fence's info has no backtick.
                    let terminated = info.contains { $0 == cr || $0 == 0x2028 || $0 == 0x2029 }
                    if length >= 3, !terminated, !(marker == backtick && info.contains(backtick)) {
                        if let start = blockStart { blocks.append((start, lineStart)) }
                        blockStart = nil
                        fence = (marker, length)
                        opened = true
                    }
                }
                if !opened {
                    if line.allSatisfy({ isBlank($0) || $0 == cr }) {
                        if let start = blockStart { blocks.append((start, lineStart)) }
                        blockStart = nil
                    } else if blockStart == nil {
                        blockStart = lineStart
                    }
                }
            }
            lineStart = lineEnd
        }
        if let start = blockStart { blocks.append((start, units.count)) }
        return blocks
    }

    /// `skipCodeSpan`: past a code span opening at `start`. Backticks with
    /// no closing run of the same length are literal, except at the end of
    /// streaming text, where everything after the opening run is code.
    static func skipCodeSpan(_ units: [UInt16], _ start: Int, _ end: Int, open: Bool) -> Int {
        let all = units[...]
        let length = run(all, from: start, of: backtick)
        var index = start + length
        while index < end {
            guard let next = units[index..<end].firstIndex(of: backtick) else { break }
            let closing = run(all, from: next, of: backtick)
            if closing == length { return next + closing }
            index = next + closing
        }
        return open ? end : start + length
    }

    /// The tag starting at `start`: `<happy-KIND (name="value")+ />`.
    private static func matchTag(_ units: [UInt16], _ start: Int) -> Tag? {
        let count = units.count
        guard start + open.count <= count, Array(units[start..<(start + open.count)]) == open else { return nil }
        var index = start + open.count
        // KIND: [a-z][a-z0-9]*(?:-[a-z0-9]+)*
        let kindStart = index
        guard index < count, isLower(units[index]) else { return nil }
        index += 1
        while index < count {
            if isLower(units[index]) || isDigit(units[index]) {
                index += 1
            } else if units[index] == dash, index + 1 < count, isLower(units[index + 1]) || isDigit(units[index + 1]) {
                index += 2
            } else {
                break
            }
        }
        let kind = String(decoding: units[kindStart..<index], as: UTF16.self)
        var attributes: [String: String] = [:]
        var duplicate = false
        var seen = 0
        while true {
            let blanks = index
            while index < count, isBlank(units[index]) { index += 1 }
            guard index < count else { return nil }
            if units[index] == slash {
                guard seen > 0, index + 1 < count, units[index + 1] == gt else { return nil }
                index += 2
                break
            }
            // Another attribute, after at least one blank.
            guard index > blanks, isLower(units[index]) else { return nil }
            let nameStart = index
            index += 1
            while index < count, isLower(units[index]) || isDigit(units[index]) || units[index] == dash { index += 1 }
            let name = String(decoding: units[nameStart..<index], as: UTF16.self)
            guard index + 1 < count, units[index] == equals, units[index + 1] == quote else { return nil }
            index += 2
            let valueStart = index
            while index < count, units[index] != quote, units[index] != lt, units[index] != gt, units[index] != cr, units[index] != lf { index += 1 }
            guard index < count, units[index] == quote, index - valueStart <= maxValueLength else { return nil }
            let value = String(decoding: units[valueStart..<index], as: UTF16.self)
            index += 1
            if attributes[name] != nil { duplicate = true }
            attributes[name] = value
            seen += 1
        }
        guard index - start <= maxTagLength, !duplicate else { return nil }
        guard let id = attributes["id"], isID(id) else { return nil }
        var version: Int?
        if let value = attributes["version"] {
            guard isVersion(value) else { return nil }
            version = Int(value)
        }
        let workspaceId = attributes["workspace"]
        if let workspaceId, !isID(workspaceId) { return nil }
        return Tag(start: start, end: index, reference: Reference(kind: kind, id: id, version: version, workspaceId: workspaceId))
    }

    /// `[A-Za-z0-9_-]{1,128}`
    private static func isID(_ value: String) -> Bool {
        let units = Array(value.utf16)
        return (1...128).contains(units.count) && units.allSatisfy { isLower($0) || isUpper($0) || isDigit($0) || $0 == underscore || $0 == dash }
    }

    /// `[1-9][0-9]{0,8}`
    private static func isVersion(_ value: String) -> Bool {
        let units = Array(value.utf16)
        guard let first = units.first, (1...9).contains(units.count), first != 0x30 else { return false }
        return units.allSatisfy(isDigit)
    }

    /// Whether `text`, which starts at a `<`, could still grow into a
    /// complete tag. It walks code points, as the reference does.
    private static func isTagPrefix(_ text: ArraySlice<UInt16>) -> Bool {
        if text.count >= maxTagLength { return false }
        if text.count <= open.count { return open.starts(with: text) }
        guard text.starts(with: open) else { return false }
        enum State { case kindStart, kind, kindDash, space, name, equals, value, afterValue, slash }
        var state = State.kindStart
        var attributeSeen = false
        var valueLength = 0
        let rest = String(decoding: text.dropFirst(open.count), as: UTF16.self)
        for scalar in rest.unicodeScalars {
            let lower = scalar.value >= 0x61 && scalar.value <= 0x7A
            let digit = scalar.value >= 0x30 && scalar.value <= 0x39
            let blank = scalar == " " || scalar == "\t"
            switch state {
            case .kindStart, .kindDash:
                guard lower || (digit && state == .kindDash) else { return false }
                state = .kind
            case .kind:
                if scalar == "-" { state = .kindDash } else if blank { state = .space } else if !lower && !digit { return false }
            case .space:
                if lower { state = .name } else if scalar == "/" && attributeSeen { state = .slash } else if !blank { return false }
            case .name:
                if scalar == "=" { state = .equals } else if !lower && !digit && scalar != "-" { return false }
            case .equals:
                guard scalar == "\"" else { return false }
                state = .value
                valueLength = 0
            case .value:
                if scalar == "\"" {
                    attributeSeen = true
                    state = .afterValue
                    break
                }
                if "<>\r\n".unicodeScalars.contains(scalar) { return false }
                valueLength += 1
                if valueLength > maxValueLength { return false }
            case .afterValue:
                // A closed value is followed by a blank or `/>`, never directly by a name.
                if blank { state = .space } else if scalar == "/" { state = .slash } else { return false }
            case .slash:
                return false
            }
        }
        return true
    }
}
