import Foundation

/// How an HTML artifact's page asks to be shown, declared in its `<head>`,
/// as desktop, Android and the agent docs read it:
///
///     <meta name="happy-page-mode" content="app">
///
/// makes it an app: full screen, edge to edge, never scrolling, with the
/// host's close button the way out. Any other value, or none, is a page.
public enum ArtifactPageMode: Equatable, Sendable {
    case page
    case app

    /// How much of a file's start is read for its `<head>`.
    public static let probeLength = 64 * 1024

    /// What the start of an HTML document declares: the first
    /// `happy-page-mode` meta before `<body>`, outside comments.
    public static func declared(in head: Data) -> ArtifactPageMode {
        declared(in: String(decoding: head, as: UTF8.self))
    }

    public static func declared(in html: String) -> ArtifactPageMode {
        meta("happy-page-mode", in: html) == "app" ? .app : .page
    }

    /// The content of the first `name` meta before `<body>`, outside
    /// comments, trimmed and lowercased; nil when there is none.
    static func meta(_ name: String, in html: String) -> String? {
        var text = html.replacingOccurrences(of: "<!--[\\s\\S]*?(-->|$)", with: "", options: .regularExpression)
        if let body = text.range(of: "<body[\\s>/]", options: [.regularExpression, .caseInsensitive]) {
            text = String(text[..<body.lowerBound])
        }
        var start = text.startIndex
        while let tag = text.range(of: "<meta\\b[^>]*>", options: [.regularExpression, .caseInsensitive], range: start..<text.endIndex) {
            start = tag.upperBound
            let attributes = Self.attributes(String(text[tag]))
            guard attributes["name"]?.lowercased() == name else { continue }
            return (attributes["content"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        return nil
    }

    /// A tag's attributes, names lowercased: quoted either way or bare.
    static func attributes(_ tag: String) -> [String: String] {
        guard let pattern = try? NSRegularExpression(pattern: "([^\\s\"'<>/=]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))") else { return [:] }
        var found: [String: String] = [:]
        let range = NSRange(tag.startIndex..., in: tag)
        for match in pattern.matches(in: tag, range: range) {
            guard let name = Range(match.range(at: 1), in: tag) else { continue }
            let value = (2...4).lazy.compactMap { Range(match.range(at: $0), in: tag) }.first.map { String(tag[$0]) } ?? ""
            let key = tag[name].lowercased()
            if found[key] == nil { found[key] = value }
        }
        return found
    }

    /// Whether a file is a web page: the only kind that can be an app.
    public static func isPage(path: String, mimeType: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return mimeType.lowercased().hasPrefix("text/html") || ext == "html" || ext == "htm"
    }
}

/// Where an app's close button sits, declared beside its mode:
///
///     <meta name="happy-app-close" content="top-end">
///
/// A corner, logical (start is the leading side), or `none`: no button,
/// for a game that draws its own exit and calls `happyApp.close()`; a
/// swipe down from the top edge still shows it for a moment. Anything
/// else, or no tag, is `top-start`.
public enum ArtifactAppClose: String, Equatable, Sendable, CaseIterable {
    case topStart = "top-start"
    case topEnd = "top-end"
    case bottomStart = "bottom-start"
    case bottomEnd = "bottom-end"
    case none

    public static func declared(in head: Data) -> ArtifactAppClose {
        declared(in: String(decoding: head, as: UTF8.self))
    }

    public static func declared(in html: String) -> ArtifactAppClose {
        ArtifactPageMode.meta("happy-app-close", in: html).flatMap(ArtifactAppClose.init(rawValue:)) ?? .topStart
    }

    public var isTop: Bool { self == .topStart || self == .topEnd }
    public var isBottom: Bool { self == .bottomStart || self == .bottomEnd }
    public var isEnd: Bool { self == .topEnd || self == .bottomEnd }
}

/// What the start of a page declares: its mode, and an app's close button.
public struct ArtifactPageDeclaration: Equatable, Sendable {
    public var mode: ArtifactPageMode
    public var close: ArtifactAppClose

    public init(mode: ArtifactPageMode, close: ArtifactAppClose = .topStart) {
        self.mode = mode
        self.close = close
    }

    public static func declared(in head: Data) -> ArtifactPageDeclaration {
        let html = String(decoding: head, as: UTF8.self)
        return ArtifactPageDeclaration(mode: .declared(in: html), close: .declared(in: html))
    }
}

/// The page modes read so far through one client. A version's files never
/// change, so a read holds for good; the newest version read of each
/// artifact is kept too, for what opens an artifact at its latest.
public final class ArtifactPageModes: @unchecked Sendable {
    public struct Read: Equatable, Sendable {
        public var version: Int
        public var entry: String
        public var mode: ArtifactPageMode
        public var close: ArtifactAppClose = .topStart
    }

    private struct File: Hashable {
        var artifactId: String
        var version: Int
        var path: String
    }

    private struct Version: Hashable {
        var artifactId: String
        var version: Int
    }

    private let lock = NSLock()
    private var files: [File: ArtifactPageDeclaration] = [:]
    private var entries: [Version: Read] = [:]
    private var newest: [String: Read] = [:]

    public init() {}

    public func known(_ artifactId: String, version: Int, path: String) -> ArtifactPageDeclaration? {
        lock.withLock { files[File(artifactId: artifactId, version: version, path: path)] }
    }

    /// The app `artifactId` opens as, if it is known to be one: the newest
    /// version read when it opens at its latest, else exactly `version`.
    public func app(_ artifactId: String, version: Int, opensLatest: Bool) -> Read? {
        lock.withLock {
            let read = opensLatest ? newest[artifactId] : entries[Version(artifactId: artifactId, version: version)]
            return read?.mode == .app ? read : nil
        }
    }

    /// `isEntry`: `path` is the version's entry, what opening it opens.
    public func remember(_ artifactId: String, version: Int, path: String, declared: ArtifactPageDeclaration, isEntry: Bool) {
        lock.withLock {
            files[File(artifactId: artifactId, version: version, path: path)] = declared
            guard isEntry else { return }
            let read = Read(version: version, entry: path, mode: declared.mode, close: declared.close)
            entries[Version(artifactId: artifactId, version: version)] = read
            if (newest[artifactId]?.version ?? .min) <= version { newest[artifactId] = read }
        }
    }
}

extension AgentClient {
    /// How a version's HTML file asks to be shown, from the start of the
    /// file; read once (`pageModes`). `isEntry`: the version's entry, so
    /// opening the artifact at that version opens it.
    public func artifactPage(_ artifactId: String, version: Int, path: String, isEntry: Bool = true) async throws -> ArtifactPageDeclaration {
        if let known = pageModes.known(artifactId, version: version, path: path) {
            if isEntry { pageModes.remember(artifactId, version: version, path: path, declared: known, isEntry: true) }
            return known
        }
        let head: Data
        do {
            head = try await artifactFile(artifactId, version: version, path: path, range: "bytes=0-\(ArtifactPageMode.probeLength - 1)").body
        } catch AgentClientError.status(416, _, _) {
            // An empty file.
            head = Data()
        }
        let declared = ArtifactPageDeclaration.declared(in: head)
        pageModes.remember(artifactId, version: version, path: path, declared: declared, isEntry: isEntry)
        return declared
    }
}
