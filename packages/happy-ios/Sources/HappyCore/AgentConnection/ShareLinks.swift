import Foundation

/// Share links: a Happy instance link carried in the fragment of an https
/// URL on link.happy.page, so it can be pasted to anyone with access to the
/// same thing and opens the app from a browser.
///
///     https://link.happy.page/#1/<instanceId>/<rest>[?<param>=<value>&…]
///
/// opens `happy://<instanceId>/<rest>`. The parameters are `as` (what an
/// agent is, for the page to say), `version` (an artifact's), and `lines`
/// (a file's); nothing else, no titles and no actions. The grammar is the
/// page's own, `link.happy.page/src/link.ts` in slopus/happy-link, as
/// happy-desktop's `happyShareLink.ts` ports it: anything else is rejected
/// whole, and the Happy URL is always rebuilt from the parsed link, so a
/// share link can only ever open a canonical instance link.
public enum HappyShareLink {
    /// Where share links live; everything after `#` stays in the browser.
    public static let origin = "https://link.happy.page"

    /// What an agent is, as the row or screen its link was copied from
    /// names it. Display only.
    public enum Role: String, CaseIterable, Sendable {
        case task, bot, subtask, subagent, session
    }

    /// What a share link opens.
    public struct Target: Equatable, Sendable {
        /// The canonical instance link, `happy://<instanceId>/…`.
        public var url: String
        public var instanceId: String
        public var role: Role?
    }

    /// The share link for an instance link, `happy://<instanceId>/…`, or
    /// nil for anything else: a link with no instance has no form that
    /// leaves the app. `role` says what an agent is and is refused on
    /// anything but an agent.
    public static func format(_ happyURL: String, as role: Role? = nil) -> String? {
        guard let link = instanceURLParse(happyURL, role: role), let payload = payloadEncode(link) else { return nil }
        return prefix + payload
    }

    /// What a share link opens, or nil for anything that is not exactly
    /// one: another host, a fragment the grammar refuses, or one naming no
    /// instance.
    public static func parse(_ url: String) -> Target? {
        guard url.hasPrefix(prefix), let link = payloadDecode(utf16(url, from: prefix.utf16.count)),
              let happyURL = happyURLFormat(link) else { return nil }
        let role: Role? = if case .agent(_, let role) = link.target { role } else { nil }
        return Target(url: happyURL, instanceId: link.instanceId, role: role)
    }

    /// Markdown with every share link outside code whose instance `here`
    /// accepts written as the instance link it opens, so it reads exactly
    /// as that `happy://` link would: a link's destination is replaced, and
    /// a bare or angle-bracketed URL becomes an empty-label link that takes
    /// its target's title. Any other share link stays as written: it is a
    /// web address.
    public static func rewrite(_ markdown: String, here: (String) -> Bool) -> String {
        guard markdown.contains(prefix) else { return markdown }
        func opened(_ candidate: String) -> String? {
            guard let target = parse(candidate), here(target.instanceId) else { return nil }
            return target.url
        }
        return outsideCode(markdown) { text in
            // `<url>`: the brackets are the link.
            let angled = replacing(shareURLAngled, in: text) { match, whole in
                let url = whole.substring(with: match.range(at: 1))
                return opened(url).map { "[](\($0))" }
            }
            return replacing(shareURLInText, in: angled) { match, whole in
                let found = whole.substring(with: match.range)
                let before = whole.substring(to: match.range.location)
                // Inside angle brackets another server's link stays one; a
                // link's label is its words.
                if before.hasSuffix("<") || before.hasSuffix("[") { return nil }
                // A link's destination is replaced as it stands.
                if before.hasSuffix("](") { return opened(found) }
                let url = trimmingTrailingPunctuation(found)
                return opened(url).map { "[](\($0))" + found.dropFirst(url.count) }
            }
        }
    }

    // MARK: Grammar

    private static let prefix = origin + "/#"
    private static let payloadVersion = 1
    private static let maxPayloadLength = 4096
    private static let maxNumber = 999_999_999

    private struct Lines: Equatable {
        var start: Int
        var end: Int
    }

    private enum ShareTarget: Equatable {
        case agent(id: String, role: Role?)
        case artifact(id: String, version: Int?)
        /// A workspace, project, surface or user, by its host (`workspaces`).
        case entity(host: String, id: String)
        case service(workspaceId: String, id: String)
        /// `path` decoded, relative to the workspace root; `owner` is `agents` or `workspaces`.
        case file(owner: String, ownerId: String, path: String, lines: Lines?)
    }

    private struct ShareLink {
        var instanceId: String
        var target: ShareTarget
    }

    private static let id = "[A-Za-z0-9_-]{1,128}"
    private static let number = "[1-9][0-9]{0,8}"
    private static let instance = "[a-z][a-z0-9]{23}"
    private static let encodedPath = "[A-Za-z0-9\\-._~!$&'*+,;=:@%/]+"
    private static let hosts = "agents|artifacts|workspaces|projects|surfaces|users"

    // `\z`, not `$`: ICU's `$` also matches before a final line break.
    private static let versioned = regex("^([0-9]+)/")
    private static let instancePrefix = regex("^(\(instance))/")
    private static let entity = regex("^(\(hosts))/(\(id))\\z")
    private static let service = regex("^workspaces/(\(id))/services/(\(id))\\z")
    private static let file = regex("^(agents|workspaces)/(\(id))/files/(\(encodedPath))\\z")
    private static let param = regex("^([a-z]+)=([A-Za-z0-9\\-._~%]+)\\z")
    private static let numberOnly = regex("^\(number)\\z")
    private static let lines = regex("^(\(number))(?:-(\(number)))?\\z")
    private static let idOnly = regex("^\(id)\\z")
    private static let instanceOnly = regex("^\(instance)\\z")

    private static let happyInstanceURL = regex("^happy://(\(instance))/(.+)\\z", [.dotMatchesLineSeparators])
    private static let happyEntity = regex("^(\(hosts))/(\(id))(?:\\?version=(\(number)))?\\z")
    private static let happyFile = regex("^(agents|workspaces)/(\(id))/files/(\(encodedPath))(?:#L(\(number))(?:-L(\(number)))?)?\\z")

    // A share link as Markdown can hold it: up to what the grammar allows,
    // which never includes whitespace, brackets, parentheses, or quotes.
    private static let shareURLInText = regex("https://link\\.happy\\.page/#1/[A-Za-z0-9\\-._~!$&'*+,;=:@%/?]+")
    private static let shareURLAngled = regex("<(https://link\\.happy\\.page/#1/[^\\s<>]+)>")
    private static let fenceOpener = regex("^ {0,3}(`{3,}|~{3,})")

    private static func payloadDecode(_ payload: String) -> ShareLink? {
        guard !payload.isEmpty, payload.utf16.count <= maxPayloadLength,
              let versioned = groups(versioned, payload), versioned[1] == String(payloadVersion) else { return nil }
        let body = utf16(payload, from: versioned[0]!.utf16.count)
        guard let instance = groups(instancePrefix, body), let instanceId = instance[1],
              let target = bodyParse(utf16(body, from: instance[0]!.utf16.count)) else { return nil }
        return ShareLink(instanceId: instanceId, target: target)
    }

    private static func payloadEncode(_ link: ShareLink) -> String? {
        // Formatting validates the whole link.
        guard happyURLFormat(link) != nil else { return nil }
        var params: [String] = []
        let rest: String
        switch link.target {
        case .agent(let id, let role):
            rest = "agents/\(id)"
            if let role { params.append("as=\(role.rawValue)") }
        case .artifact(let id, let version):
            rest = "artifacts/\(id)"
            if let version { params.append("version=\(version)") }
        case .entity(let host, let id):
            rest = "\(host)/\(id)"
        case .service(let workspaceId, let id):
            rest = "workspaces/\(workspaceId)/services/\(id)"
        case .file(let owner, let ownerId, let path, let lines):
            rest = "\(owner)/\(ownerId)/files/" + split(path, "/").map(segmentEncode).joined(separator: "/")
            if let lines { params.append("lines=\(linesFormat(lines, ""))") }
        }
        let query = params.isEmpty ? "" : "?" + params.joined(separator: "&")
        let payload = "\(payloadVersion)/\(link.instanceId)/\(rest)\(query)"
        return payload.utf16.count <= maxPayloadLength ? payload : nil
    }

    /// The canonical `happy://<instanceId>/…` URL for a link; nil for an invalid one.
    private static func happyURLFormat(_ link: ShareLink) -> String? {
        guard matches(instanceOnly, link.instanceId) else { return nil }
        let rest: String
        switch link.target {
        case .agent(let id, _):
            guard matches(idOnly, id) else { return nil }
            rest = "agents/\(id)"
        case .artifact(let id, let version):
            guard matches(idOnly, id), version.map(numberValid) ?? true else { return nil }
            rest = "artifacts/\(id)" + (version.map { "?version=\($0)" } ?? "")
        case .entity(let host, let id):
            guard ["workspaces", "projects", "surfaces", "users"].contains(host), matches(idOnly, id) else { return nil }
            rest = "\(host)/\(id)"
        case .service(let workspaceId, let id):
            guard matches(idOnly, workspaceId), matches(idOnly, id) else { return nil }
            rest = "workspaces/\(workspaceId)/services/\(id)"
        case .file(let owner, let ownerId, let path, let lines):
            guard owner == "agents" || owner == "workspaces", matches(idOnly, ownerId) else { return nil }
            let segments = split(path, "/")
            guard segments.allSatisfy(segmentValid) else { return nil }
            var suffix = ""
            if let lines {
                guard numberValid(lines.start), numberValid(lines.end), lines.end >= lines.start else { return nil }
                suffix = "#" + linesFormat(lines, "L")
            }
            rest = "\(owner)/\(ownerId)/files/" + segments.map(segmentEncode).joined(separator: "/") + suffix
        }
        let url = "happy://\(link.instanceId)/\(rest)"
        return url.utf16.count <= maxPayloadLength ? url : nil
    }

    /// An instance link as a share link, or nil for anything that is not exactly one.
    private static func instanceURLParse(_ url: String, role: Role?) -> ShareLink? {
        guard url.utf16.count <= maxPayloadLength, let instance = groups(happyInstanceURL, url),
              let instanceId = instance[1], let rest = instance[2] else { return nil }
        var target: ShareTarget?
        if let entity = groups(happyEntity, rest) {
            target = entityTarget(entity[1] ?? "", entity[2] ?? "")
            if case .artifact(let id, _)? = target, let version = entity[3] {
                target = .artifact(id: id, version: Int(version))
            } else if entity[3] != nil {
                return nil
            }
        } else if let service = groups(service, rest) {
            target = .service(workspaceId: service[1] ?? "", id: service[2] ?? "")
        } else if let file = groups(happyFile, rest) {
            target = fileTarget(file[1] ?? "", file[2] ?? "", file[3] ?? "", file[4], file[5])
        }
        guard var target else { return nil }
        if let role {
            guard case .agent(let id, _) = target else { return nil }
            target = .agent(id: id, role: role)
        }
        let link = ShareLink(instanceId: instanceId, target: target)
        return happyURLFormat(link) == url ? link : nil
    }

    private static func bodyParse(_ body: String) -> ShareTarget? {
        let units = Array(body.utf16)
        let question = units.firstIndex(of: UInt16(UInt8(ascii: "?")))
        let rest = question.map { String(decoding: units[..<$0], as: UTF16.self) } ?? body
        guard let params = paramsParse(question.map { String(decoding: units[($0 + 1)...], as: UTF16.self) }) else { return nil }

        var allowed = Set<String>()
        var target: ShareTarget?
        if let entity = groups(entity, rest) {
            target = entityTarget(entity[1] ?? "", entity[2] ?? "")
            switch target {
            case .agent(let id, _)?:
                allowed.insert("as")
                if let value = params["as"] {
                    guard let role = Role(rawValue: value) else { return nil }
                    target = .agent(id: id, role: role)
                }
            case .artifact(let id, _)?:
                allowed.insert("version")
                if let value = params["version"] {
                    guard matches(numberOnly, value) else { return nil }
                    target = .artifact(id: id, version: Int(value))
                }
            default:
                break
            }
        } else if let service = groups(service, rest) {
            target = .service(workspaceId: service[1] ?? "", id: service[2] ?? "")
        } else if let file = groups(file, rest) {
            allowed.insert("lines")
            var range: [String?]?
            if let value = params["lines"] {
                guard let found = groups(lines, value) else { return nil }
                range = found
            }
            target = fileTarget(file[1] ?? "", file[2] ?? "", file[3] ?? "", range?[1] ?? nil, range?[2] ?? nil)
        }
        guard let target, params.keys.allSatisfy(allowed.contains) else { return nil }
        return target
    }

    /// Strict `key=value&…`: lowercase keys, each once, values non-empty.
    private static func paramsParse(_ query: String?) -> [String: String]? {
        var params: [String: String] = [:]
        guard let query else { return params }
        for pair in split(query, "&") {
            guard let match = groups(param, pair), let key = match[1], let encoded = match[2],
                  let value = valueDecode(encoded), params[key] == nil else { return nil }
            params[key] = value
        }
        return params
    }

    private static func entityTarget(_ host: String, _ id: String) -> ShareTarget? {
        switch host {
        case "agents": .agent(id: id, role: nil)
        case "artifacts": .artifact(id: id, version: nil)
        case "workspaces", "projects", "surfaces", "users": .entity(host: host, id: id)
        default: nil
        }
    }

    private static func fileTarget(_ host: String, _ ownerId: String, _ encodedPath: String, _ start: String?, _ end: String?) -> ShareTarget? {
        var segments: [String] = []
        for segment in split(encodedPath, "/") {
            // An encoded `%2F` is never a separator, and `.`, `..`, `\`, and control characters are out.
            guard let decoded = valueDecode(segment), segmentValid(decoded) else { return nil }
            segments.append(decoded)
        }
        var lines: Lines?
        if let start, let first = Int(start) {
            let last = end.flatMap { Int($0) } ?? first
            guard last >= first else { return nil }
            lines = Lines(start: first, end: last)
        }
        return .file(owner: host == "agents" ? "agents" : "workspaces", ownerId: ownerId, path: segments.joined(separator: "/"), lines: lines)
    }

    private static func linesFormat(_ lines: Lines, _ prefix: String) -> String {
        lines.start == lines.end ? "\(prefix)\(lines.start)" : "\(prefix)\(lines.start)-\(prefix)\(lines.end)"
    }

    /// `decodeURIComponent`: nil for an empty value, a `%` that starts no
    /// escape, or bytes that are not UTF-8.
    private static func valueDecode(_ value: String) -> String? {
        guard !value.isEmpty else { return nil }
        var bytes: [UInt8] = []
        var utf8 = Array(value.utf8)[...]
        while let byte = utf8.popFirst() {
            guard byte == UInt8(ascii: "%") else { bytes.append(byte); continue }
            let hex = utf8.prefix(2)
            guard hex.count == 2, hex.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
                  let decoded = UInt8(String(decoding: hex, as: UTF8.self), radix: 16) else { return nil }
            bytes.append(decoded)
            utf8 = utf8.dropFirst(2)
        }
        // Invalid UTF-8 decodes with replacements, so it doesn't round-trip.
        let decoded = String(decoding: bytes, as: UTF8.self)
        return Array(decoded.utf8) == bytes ? decoded : nil
    }

    /// A decoded path segment: never `.` or `..`, and no `/`, `\`, or control character.
    private static func segmentValid(_ segment: String) -> Bool {
        !segment.isEmpty && segment != "." && segment != ".."
            && !segment.unicodeScalars.contains { $0 == "/" || $0 == "\\" || $0.value < 0x20 || (0x7F...0x9F).contains($0.value) }
    }

    /// Percent-encodes every byte but the unreserved characters.
    private static func segmentEncode(_ segment: String) -> String {
        var out = ""
        for byte in segment.utf8 {
            if (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 45 || byte == 46 || byte == 95 || byte == 126 {
                out.unicodeScalars.append(UnicodeScalar(byte))
            } else {
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    private static func numberValid(_ value: Int) -> Bool { (1...maxNumber).contains(value) }

    // MARK: Markdown

    /// What GFM leaves off the end of a bare URL as the sentence around it.
    private static func trimmingTrailingPunctuation(_ url: String) -> String {
        var trimmed = Substring(url)
        while let last = trimmed.last, "?!.,:*_~'".contains(last) { trimmed = trimmed.dropLast() }
        return String(trimmed)
    }

    /// Applies `map` to every run of `markdown` outside fenced code and
    /// inline code spans, which stay literal as Markdown reads them.
    private static func outsideCode(_ markdown: String, _ map: (String) -> String) -> String {
        var fence: String?
        var prose: [String] = []
        var out: [String] = []
        func flush() {
            guard !prose.isEmpty else { return }
            out.append(inlineOutsideCode(prose.joined(separator: "\n"), map))
            prose = []
        }
        for line in split(markdown, "\n") {
            if fence == nil, let opener = groups(fenceOpener, line)?[1] {
                flush()
                fence = opener
                out.append(line)
            } else if let open = fence {
                if closes(open, line) { fence = nil }
                out.append(line)
            } else {
                prose.append(line)
            }
        }
        flush()
        return out.joined(separator: "\n")
    }

    /// Whether `line` closes the fence `open` opened: up to three spaces,
    /// at least as many of its marks, and only whitespace after.
    private static func closes(_ open: String, _ line: String) -> Bool {
        let mark = open.unicodeScalars.first == "`" ? Unicode.Scalar("`") : Unicode.Scalar("~")
        var scalars = line.unicodeScalars[...]
        var spaces = 0
        while scalars.first == " ", spaces < 3 { scalars = scalars.dropFirst(); spaces += 1 }
        let run = scalars.prefix { $0 == mark }.count
        return run >= open.unicodeScalars.count && scalars.dropFirst(run).allSatisfy(\.properties.isWhitespace)
    }

    /// Applies `map` outside inline code spans: a run of backticks closed by the same run.
    private static func inlineOutsideCode(_ text: String, _ map: (String) -> String) -> String {
        let units = Array(text.utf16)
        let backslash = UInt16(UInt8(ascii: "\\")), backtick = UInt16(UInt8(ascii: "`"))
        func slice(_ from: Int, _ to: Int) -> String { String(decoding: units[from..<to], as: UTF16.self) }
        func find(_ run: Int, from: Int) -> Int? {
            var index = from
            while index + run <= units.count {
                if units[index..<(index + run)].allSatisfy({ $0 == backtick }) { return index }
                index += 1
            }
            return nil
        }
        var out = ""
        var index = 0
        var start = 0
        while index < units.count {
            if units[index] == backslash { index += 2; continue }
            if units[index] != backtick { index += 1; continue }
            var run = 1
            while index + run < units.count, units[index + run] == backtick { run += 1 }
            var close = find(run, from: index + run)
            while let found = close, found + run < units.count, units[found + run] == backtick {
                var after = found + run
                while after < units.count, units[after] == backtick { after += 1 }
                close = find(run, from: after)
            }
            guard let close else { index += run; continue }
            out += map(slice(start, index)) + slice(index, close + run)
            index = close + run
            start = index
        }
        return out + map(slice(min(start, units.count), units.count))
    }

    // MARK: Text

    /// `text` split at every `separator`, as JavaScript's `split` does: by
    /// scalar, not by character, so `\r\n` still ends at `\n`.
    private static func split(_ text: String, _ separator: Unicode.Scalar) -> [String] {
        text.unicodeScalars.split(separator: separator, omittingEmptySubsequences: false).map { part in
            var piece = ""
            piece.unicodeScalars.append(contentsOf: part)
            return piece
        }
    }

    /// `text` from its `offset`th UTF-16 unit, as JavaScript's `slice` counts.
    private static func utf16(_ text: String, from offset: Int) -> String {
        String(decoding: Array(text.utf16).dropFirst(offset), as: UTF16.self)
    }

    // MARK: Regular expressions

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    private static func groups(_ regex: NSRegularExpression, _ text: String) -> [String?]? {
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
    }

    /// `text` with each match of `regex` replaced by `transform`'s text, or
    /// left as it is where that answers nil. `transform` sees the match and
    /// the whole text it was found in, as a JavaScript replacer does.
    private static func replacing(_ regex: NSRegularExpression, in text: String, _ transform: (NSTextCheckingResult, NSString) -> String?) -> String {
        let ns = text as NSString
        let found = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !found.isEmpty else { return text }
        var out = ""
        var position = 0
        for match in found {
            out += ns.substring(with: NSRange(location: position, length: match.range.location - position))
            out += transform(match, ns) ?? ns.substring(with: match.range)
            position = match.range.location + match.range.length
        }
        return out + ns.substring(from: position)
    }
}

extension HappyShareLink.Role {
    /// What the conversation a sidebar row opens is, as the row names it:
    /// a bot, a task, a subtask under one, or a session; nil for a row that
    /// opens no conversation.
    public init?(_ row: Row) {
        guard row.agentId != nil else { return nil }
        switch (row.kind, row.targetKind) {
        case (.session, _): self = .subtask
        case (.space, "bot"): self = .bot
        case (.space, "task"): self = .task
        case (.space, "agent"): self = .session
        default: return nil
        }
    }
}
