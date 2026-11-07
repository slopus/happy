import Foundation
import HappyWire

/// The Happy links an agent writes as Markdown inline links,
/// `[label](happy://agents/…)`, `![alt](happy://artifacts/…)` or with a
/// title, `[label](happy://settings/providers "button")`: found the way
/// `@slopus/happy-agent-client`'s `parseHappyLinks` finds them. Never in
/// fenced code or a code span, never after a backslash, and never across
/// a blank line. Only destinations under the `happy` or `happy-file`
/// scheme are Happy links; every other link is left as written.
public enum HappyMarkdownLinks {
    public struct Match: Equatable, Sendable {
        /// The Markdown between the brackets, as written.
        public var label: String
        /// Nil when the destination is malformed.
        public var link: HappyLink?
        /// Titled exactly `button`.
        public var button: Bool
        /// The link exactly as written.
        public var source: String
        /// UTF-16 offsets of `source` in the text.
        var start: Int
        var end: Int
    }

    /// Every Happy link in `markdown`, in order.
    public static func matches(_ markdown: String) -> [Match] {
        guard markdown.range(of: "happy", options: .caseInsensitive) != nil else { return [] }
        let units = Array(markdown.utf16)
        var found: [Match] = []
        for block in HappyReferences.textBlocks(units) {
            var index = block.start
            while index < block.end {
                switch units[index] {
                case backslash:
                    index += 2
                case backtick:
                    index = HappyReferences.skipCodeSpan(units, index, block.end, open: false)
                case open:
                    let start = index > block.start && units[index - 1] == bang ? index - 1 : index
                    if let match = match(units, at: index, end: block.end, start: start) {
                        found.append(match)
                        index = match.end
                    } else {
                        index += 1
                    }
                default:
                    index += 1
                }
            }
        }
        return found
    }

    /// `markdown` with each Happy link replaced by `replace`'s text, or
    /// left as written where it answers nil.
    public static func replace(_ markdown: String, _ replace: (Match) -> String?) -> String {
        let found = matches(markdown)
        guard !found.isEmpty else { return markdown }
        let units = Array(markdown.utf16)
        var out = ""
        var position = 0
        for match in found {
            out += String(decoding: units[position..<match.start], as: UTF16.self)
            out += replace(match) ?? match.source
            position = match.end
        }
        out += String(decoding: units[position...], as: UTF16.self)
        return out
    }

    private static let backslash = UInt16(UInt8(ascii: "\\")), backtick = UInt16(UInt8(ascii: "`"))
    private static let open = UInt16(UInt8(ascii: "[")), close = UInt16(UInt8(ascii: "]")), bang = UInt16(UInt8(ascii: "!"))
    private static let paren = UInt16(UInt8(ascii: "(")), unparen = UInt16(UInt8(ascii: ")"))
    private static let lt = UInt16(UInt8(ascii: "<")), gt = UInt16(UInt8(ascii: ">"))
    private static let quote = UInt16(UInt8(ascii: "\"")), apostrophe = UInt16(UInt8(ascii: "'"))
    private static let space = UInt16(UInt8(ascii: " ")), tab = UInt16(UInt8(ascii: "\t"))
    private static let cr = UInt16(UInt8(ascii: "\r")), lf = UInt16(UInt8(ascii: "\n"))

    private static func isSpace(_ unit: UInt16) -> Bool { unit == space || unit == tab || unit == cr || unit == lf }

    /// The link whose `[` is at `at`: balanced brackets, then `(`, the
    /// destination bare or in `<>`, an optional title, and `)`.
    private static func match(_ units: [UInt16], at: Int, end: Int, start: Int) -> Match? {
        var index = at + 1
        var depth = 1
        while index < end {
            let unit = units[index]
            if unit == backslash { index += 2; continue }
            if unit == backtick { index = HappyReferences.skipCodeSpan(units, index, end, open: false); continue }
            if unit == open { depth += 1 }
            if unit == close { depth -= 1; if depth == 0 { break } }
            index += 1
        }
        guard index < end, depth == 0 else { return nil }
        let labelEnd = index
        index += 1
        guard index < end, units[index] == paren else { return nil }
        index += 1
        while index < end, isSpace(units[index]) { index += 1 }
        var destination: Range<Int>
        if index < end, units[index] == lt {
            let from = index + 1
            index = from
            while index < end, units[index] != gt, units[index] != lt, units[index] != lf { index += 1 }
            guard index < end, units[index] == gt else { return nil }
            destination = from..<index
            index += 1
        } else {
            let from = index
            var parens = 0
            while index < end, !isSpace(units[index]) {
                if units[index] == backslash { index += 2; continue }
                if units[index] == paren { parens += 1 }
                if units[index] == unparen { if parens == 0 { break }; parens -= 1 }
                index += 1
            }
            index = min(index, end)
            destination = from..<index
        }
        let url = String(decoding: units[destination], as: UTF16.self)
        guard HappyLink.isHappyURL(url) else { return nil }
        var title: String?
        let beforeTitle = index
        while index < end, isSpace(units[index]) { index += 1 }
        if index < end, index > beforeTitle, [quote, apostrophe, paren].contains(units[index]) {
            let opener = units[index]
            let closer = opener == paren ? unparen : opener
            let from = index + 1
            index = from
            while index < end, units[index] != closer {
                if units[index] == backslash { index += 1 }
                index += 1
            }
            guard index < end else { return nil }
            title = String(decoding: units[from..<index], as: UTF16.self)
            index += 1
            while index < end, isSpace(units[index]) { index += 1 }
        }
        guard index < end, units[index] == unparen else { return nil }
        index += 1
        return Match(
            label: String(decoding: units[(at + 1)..<labelEnd], as: UTF16.self),
            link: HappyLink(url),
            button: title == "button",
            source: String(decoding: units[start..<index], as: UTF16.self),
            start: start, end: index
        )
    }
}

/// The Happy links a conversation draws as links once
/// `HappyReferences.markdown` has read them: a reference it wrote, a
/// settings link, or a file link on this installation.
public enum ChatLinks {
    /// Drawn as a link, even where its page goes nowhere.
    public static func drawn(_ url: String) -> Bool {
        HappyReferences.reference(link: url) != nil || SettingsLinkPlace.page(url) != nil || file(url) != nil
    }

    /// Whether a tap on `url`, in a conversation on `server`, opens
    /// anything: a button whose link doesn't is its words.
    public static func opens(_ url: String, server: String?) -> Bool {
        SettingsLinkPlace.opens(url, server: server) || HappyReferences.reference(link: url) != nil || file(url) != nil
    }

    /// The file `url` links to on this installation.
    public static func file(_ url: String) -> HappyLink.File? {
        guard let link = HappyLink(url), link.instanceId == nil, case .file(let file) = link.target else { return nil }
        return file
    }
}
