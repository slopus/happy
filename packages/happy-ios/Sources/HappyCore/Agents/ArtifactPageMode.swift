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
        var text = html.replacingOccurrences(of: "<!--[\\s\\S]*?(-->|$)", with: "", options: .regularExpression)
        if let body = text.range(of: "<body[\\s>/]", options: [.regularExpression, .caseInsensitive]) {
            text = String(text[..<body.lowerBound])
        }
        var start = text.startIndex
        while let tag = text.range(of: "<meta\\b[^>]*>", options: [.regularExpression, .caseInsensitive], range: start..<text.endIndex) {
            start = tag.upperBound
            let attributes = Self.attributes(String(text[tag]))
            guard attributes["name"]?.lowercased() == "happy-page-mode" else { continue }
            return attributes["content"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "app" ? .app : .page
        }
        return .page
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

/// The page modes read so far through one client. A version's files never
/// change, so a read holds for good; the newest version read of each
/// artifact is kept too, for what opens an artifact at its latest.
public final class ArtifactPageModes: @unchecked Sendable {
    public struct Read: Equatable, Sendable {
        public var version: Int
        public var entry: String
        public var mode: ArtifactPageMode
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
    private var files: [File: ArtifactPageMode] = [:]
    private var entries: [Version: Read] = [:]
    private var newest: [String: Read] = [:]

    public init() {}

    public func known(_ artifactId: String, version: Int, path: String) -> ArtifactPageMode? {
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
    public func remember(_ artifactId: String, version: Int, path: String, mode: ArtifactPageMode, isEntry: Bool) {
        lock.withLock {
            files[File(artifactId: artifactId, version: version, path: path)] = mode
            guard isEntry else { return }
            let read = Read(version: version, entry: path, mode: mode)
            entries[Version(artifactId: artifactId, version: version)] = read
            if (newest[artifactId]?.version ?? .min) <= version { newest[artifactId] = read }
        }
    }
}

extension AgentClient {
    /// How a version's HTML file asks to be shown, from the start of the
    /// file; read once (`pageModes`). `isEntry`: the version's entry, so
    /// opening the artifact at that version opens it.
    public func artifactPageMode(_ artifactId: String, version: Int, path: String, isEntry: Bool = true) async throws -> ArtifactPageMode {
        if let known = pageModes.known(artifactId, version: version, path: path) {
            if isEntry { pageModes.remember(artifactId, version: version, path: path, mode: known, isEntry: true) }
            return known
        }
        let head: Data
        do {
            head = try await artifactFile(artifactId, version: version, path: path, range: "bytes=0-\(ArtifactPageMode.probeLength - 1)").body
        } catch AgentClientError.status(416, _, _) {
            // An empty file.
            head = Data()
        }
        let mode = ArtifactPageMode.declared(in: head)
        pageModes.remember(artifactId, version: version, path: path, mode: mode, isEntry: isEntry)
        return mode
    }
}
