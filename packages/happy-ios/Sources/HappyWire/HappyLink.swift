import Foundation

/// What a Happy URL names: an entity (`happy://artifacts/<id>`) or a file
/// (`happy://agents/<id>/files/Foo.tsx#L42`, or the API's
/// `happy-file://agents/<id>/Foo.tsx#L42`). A port of
/// `@slopus/happy-agent-client`'s `happyLinks.ts`, so the two agree on
/// exactly what a link names.
///
/// An instance link, `happy://<instanceId>/artifacts/<id>`, puts an
/// installation's 24-character health `instanceId` in front, so the link
/// names that one installation outside Happy. Hosts are plural nouns, or a
/// 24-character instance ID, so neither collides with the app's own
/// `happy://` routes (`direct`, `terminal`, `oauth`). The grammar is
/// strict: anything else is malformed and never partly read.
public struct HappyLink: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case artifact, agent, workspace, project, service, surface, user

        var host: String { rawValue + "s" }
    }

    public struct Reference: Equatable, Sendable {
        public var kind: Kind
        public var id: String
        /// An artifact's version.
        public var version: Int?
        /// The workspace a service runs in; every service has one.
        public var workspaceId: String?

        public init(kind: Kind, id: String, version: Int? = nil, workspaceId: String? = nil) {
            self.kind = kind; self.id = id; self.version = version; self.workspaceId = workspaceId
        }
    }

    public struct File: Equatable, Sendable {
        public enum Target: Equatable, Sendable { case agent(String), workspace(String) }
        public var target: Target
        /// Decoded, relative to the workspace root.
        public var path: String
        /// Inclusive: `#L42` is 42...42.
        public var lines: ClosedRange<Int>?

        public init(target: Target, path: String, lines: ClosedRange<Int>? = nil) {
            self.target = target; self.path = path; self.lines = lines
        }
    }

    public enum Target: Equatable, Sendable {
        case reference(Reference)
        case file(File)
    }

    public var target: Target
    /// Present only on an instance link: the installation it names.
    public var instanceId: String?

    public init(_ target: Target, instanceId: String? = nil) {
        self.target = target; self.instanceId = instanceId
    }

    public static let maxLength = 4096

    /// Whether `id` is an installation's health `instanceId` (a cuid2).
    public static func isInstanceID(_ id: String) -> Bool {
        id.utf8.count == 24 && id.utf8.first.map { (97...122).contains($0) } == true
            && id.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) }
    }

    /// Whether `text` uses the `happy` or `happy-file` scheme at all,
    /// well-formed or not.
    public static func isHappyURL(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.hasPrefix("happy:") || lower.hasPrefix("happy-file:")
    }

    /// The link `text` is exactly, or nil.
    public init?(_ text: String) {
        guard text.utf16.count <= Self.maxLength else { return nil }
        let prefix = "happy://"
        if text.hasPrefix(prefix) {
            let rest = text.dropFirst(prefix.count)
            if let slash = rest.firstIndex(of: "/"), Self.isInstanceID(String(rest[..<slash])) {
                // Only the `happy://` forms follow an instance ID.
                guard let target = Self.parse(prefix + rest[rest.index(after: slash)...]) else { return nil }
                self.init(target, instanceId: String(rest[..<slash]))
                return
            }
        }
        guard let target = Self.parse(text) else { return nil }
        self.init(target)
    }

    /// The canonical URL; nil for a link the grammar can't express.
    public var url: String? {
        let inner: String?
        switch target {
        case .reference(let reference): inner = Self.format(reference)
        case .file(let file): inner = Self.format(file)
        }
        guard let inner else { return nil }
        guard let instanceId else { return inner }
        guard Self.isInstanceID(instanceId) else { return nil }
        let url = "happy://\(instanceId)/" + inner.dropFirst("happy://".count)
        return url.utf16.count <= Self.maxLength ? url : nil
    }

    // MARK: Reading

    private static let id = "[A-Za-z0-9_-]{1,128}"
    private static let number = "[1-9][0-9]{0,8}"
    private static let encodedPath = "[A-Za-z0-9\\-._~!$&'*+,;=:@%/]+"
    private static let lines = "#L(\(number))(?:-L(\(number)))?"
    private static let entity = try! NSRegularExpression(pattern: "^happy://(artifacts|agents|workspaces|projects|surfaces|users)/(\(id))(?:\\?version=(\(number)))?$")
    private static let service = try! NSRegularExpression(pattern: "^happy://workspaces/(\(id))/services/(\(id))$")
    private static let file = try! NSRegularExpression(pattern: "^happy://(agents|workspaces)/(\(id))/files/(\(encodedPath))(?:\(lines))?$")
    private static let happyFile = try! NSRegularExpression(pattern: "^happy-file://(agents|workspaces)/(\(id))/(\(encodedPath))(?:\(lines))?$")

    private static func groups(_ regex: NSRegularExpression, _ text: String) -> [String?]? {
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
    }

    private static func parse(_ text: String) -> Target? {
        if let parts = groups(entity, text), let host = parts[1], let id = parts[2] {
            guard let kind = Kind.allCases.first(where: { $0.host == host }) else { return nil }
            let version = parts[3].flatMap { Int($0) }
            if version != nil, kind != .artifact { return nil }
            return .reference(Reference(kind: kind, id: id, version: version))
        }
        if let parts = groups(service, text), let workspace = parts[1], let id = parts[2] {
            return .reference(Reference(kind: .service, id: id, workspaceId: workspace))
        }
        guard let parts = groups(file, text) ?? groups(happyFile, text),
              let host = parts[1], let id = parts[2], let encoded = parts[3],
              let path = decode(encoded) else { return nil }
        var link = File(target: host == "agents" ? .agent(id) : .workspace(id), path: path)
        if let start = parts[4].flatMap({ Int($0) }) {
            let end = parts[5].flatMap { Int($0) } ?? start
            guard end >= start else { return nil }
            link.lines = start...end
        }
        return isValid(link) ? .file(link) : nil
    }

    /// Each segment percent-decoded as UTF-8; nil for an empty or invalid one.
    private static func decode(_ encoded: String) -> String? {
        var segments: [String] = []
        for segment in encoded.split(separator: "/", omittingEmptySubsequences: false) {
            guard !segment.isEmpty else { return nil }
            var bytes: [UInt8] = []
            var utf8 = Array(segment.utf8)[...]
            while let byte = utf8.popFirst() {
                guard byte == UInt8(ascii: "%") else { bytes.append(byte); continue }
                let hex = utf8.prefix(2)
                guard hex.count == 2, hex.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
                      let value = UInt8(String(decoding: hex, as: UTF8.self), radix: 16) else { return nil }
                bytes.append(value)
                utf8 = utf8.dropFirst(2)
            }
            // Invalid UTF-8 decodes with replacements, so it doesn't round-trip.
            let decoded = String(decoding: bytes, as: UTF8.self)
            guard Array(decoded.utf8) == bytes, !decoded.contains("/") else { return nil }
            segments.append(decoded)
        }
        return segments.joined(separator: "/")
    }

    private static func isID(_ text: String) -> Bool {
        (1...128).contains(text.utf8.count) && text.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }
    }

    private static func isValid(_ file: File) -> Bool {
        let targetID: String
        switch file.target { case .agent(let id), .workspace(let id): targetID = id }
        guard isID(targetID), file.path.utf16.count <= maxLength else { return false }
        if let lines = file.lines, lines.lowerBound < 1 || lines.upperBound > 999_999_999 { return false }
        // Never `.` or `..`, and no `\` or control character.
        return file.path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { segment in
            !segment.isEmpty && segment != "." && segment != ".."
                && !segment.unicodeScalars.contains { $0 == "\\" || $0.value < 0x20 || (0x7F...0x9F).contains($0.value) }
        }
    }

    // MARK: Writing

    private static func format(_ reference: Reference) -> String? {
        guard isID(reference.id), reference.version.map({ (1...999_999_999).contains($0) }) ?? true,
              reference.version == nil || reference.kind == .artifact,
              (reference.workspaceId == nil) != (reference.kind == .service) else { return nil }
        if reference.kind == .service {
            guard let workspace = reference.workspaceId, isID(workspace) else { return nil }
            return "happy://workspaces/\(workspace)/services/\(reference.id)"
        }
        return "happy://\(reference.kind.host)/\(reference.id)" + (reference.version.map { "?version=\($0)" } ?? "")
    }

    private static func format(_ file: File) -> String? {
        guard isValid(file) else { return nil }
        let target = switch file.target {
        case .agent(let id): "agents/\(id)"
        case .workspace(let id): "workspaces/\(id)"
        }
        let path = file.path.split(separator: "/").map(encode).joined(separator: "/")
        let lines = file.lines.map { $0.lowerBound == $0.upperBound ? "#L\($0.lowerBound)" : "#L\($0.lowerBound)-L\($0.upperBound)" } ?? ""
        let url = "happy://\(target)/files/\(path)\(lines)"
        return url.utf16.count <= maxLength ? url : nil
    }

    /// Every byte but the unreserved characters percent-encoded, in uppercase hex.
    private static func encode(_ segment: Substring) -> String {
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
}
