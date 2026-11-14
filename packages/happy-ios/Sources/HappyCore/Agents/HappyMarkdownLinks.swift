import Foundation
import HappyWire

/// The Happy links an agent writes as Markdown inline links,
/// `[label](happy://agents/…)`, `![alt](happy://artifacts/…)` or with a
/// title, `[label](happy://settings/providers "button")`: found the way
/// `@slopus/happy-agent-client`'s `parseHappyLinks` finds them. Never in
/// fenced code or a code span, never after a backslash, and never across
/// a blank line. Only destinations under the `happy` or `happy-file`
/// scheme, and link.happy.page share links, are Happy links; every other
/// link is left as written.
public enum HappyMarkdownLinks {
    public struct Match: Equatable, Sendable {
        /// The Markdown between the brackets, as written.
        public var label: String
        /// The destination as written.
        public var url: String
        /// Nil when the destination is malformed; a share link's is the
        /// instance link it carries.
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
        let shared = HappyShareLink.parse(url)
        guard HappyLink.isHappyURL(url) || shared != nil else { return nil }
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
            url: url,
            link: shared.map { HappyLink($0.url) } ?? HappyLink(url),
            button: title == "button",
            source: String(decoding: units[start..<index], as: UTF16.self),
            start: start, end: index
        )
    }
}

/// Where a link in a conversation goes, read from its address as written
/// when it is drawn: the Markdown is never rewritten, so whatever is shown
/// or copied is what was written.
public enum ChatLinks {
    public enum Kind: Equatable, Sendable {
        /// An address on the web.
        case web
        /// What the conversation's installation holds: it opens in the app,
        /// `busy` while its agent works.
        case here(HappyLink, busy: Bool)
        /// A person the conversation names, set apart and opening nothing;
        /// `me` when it is the reader.
        case mention(me: Bool)
        /// A share link nothing here holds (another server's, or something
        /// archived or gone): its words, routed as an instance link on a
        /// tap, which opens it on its connection or says it can't.
        case elsewhere(HappyLink)
        /// Words only: a `happy://` link nothing here holds, a malformed
        /// one, a file found not to open, or anything that isn't a web
        /// address.
        case words
    }

    /// The Happy link `url` is, a share link read as the instance link it carries.
    public static func happyLink(_ url: String) -> HappyLink? {
        if let shared = HappyShareLink.parse(url) { return HappyLink(shared.url) }
        return HappyLink(url)
    }

    /// Where `url` goes in a conversation whose links `references` read.
    public static func kind(_ url: String, references: References) -> Kind {
        guard let link = happyLink(url) else {
            return LegacyMarkdown.isHTTPLink(url) && !HappyLink.isHappyURL(url) ? .web : .words
        }
        // Only a share link leaves the app, so only one is routed (desktop's rule).
        let unresolved: Kind = HappyLink.isHappyURL(url) ? .words : .elsewhere(link)
        if let named = link.instanceId, named != references.instanceId { return unresolved }
        switch link.target {
        case .settings:
            return .here(link, busy: false)
        case .file(let file):
            return references.opens(file) ? .here(link, busy: false) : .words
        case .reference(let named):
            let reference = HappyReferences.Reference(kind: named.kind.rawValue, id: named.id, version: named.version, workspaceId: named.workspaceId)
            switch references.view(reference) {
            case .link: return .here(link, busy: references.busy(reference))
            case .mention(_, let me): return .mention(me: me)
            // A deleted artifact's last title is words, as desktop keeps it.
            case .text(let label): return label == HappyReferences.placeholder(reference) ? unresolved : .words
            }
        }
    }

    /// Whether a button to `url`, in a conversation on `server`, does
    /// anything on a tap: one that doesn't is its words.
    public static func opens(_ url: String, references: References, server: String?) -> Bool {
        switch kind(url, references: references) {
        case .here(let link, _):
            guard case .settings(let page) = link.target else { return true }
            return SettingsLinkPlace.place(page, server: server) != nil
        case .elsewhere: return true
        case .web, .mention, .words: return false
        }
    }

    /// Drawn as a link where nothing says what a conversation holds (the
    /// relay's chat): a settings or file link, even where it goes nowhere.
    public static func drawn(_ url: String) -> Bool {
        SettingsLinkPlace.page(url) != nil || file(url) != nil
    }

    /// The file `url` links to on this installation.
    public static func file(_ url: String) -> HappyLink.File? {
        guard let link = HappyLink(url), link.instanceId == nil, case .file(let file) = link.target else { return nil }
        return file
    }
}
