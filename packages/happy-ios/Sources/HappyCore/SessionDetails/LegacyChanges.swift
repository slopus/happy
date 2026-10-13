import Foundation

/// components/AllFilesDiffView.tsx's legacy viewer without the drawing: a
/// CLI session's uncommitted files from its git status, each one's patch
/// (or contents, or both sides of an image) fetched over the session shell,
/// and the list items DiffFilesList draws.
public enum LegacyChanges {
    /// What one file's fetch brought back.
    public enum Content: Equatable, Sendable {
        case patch(String)
        case newFile(String)
        case image(before: Data?, after: Data?)
    }

    public struct Result: Equatable, Sendable {
        public var file: GitFileStatus
        public var content: Content?
        public var error: String?

        public init(file: GitFileStatus, content: Content?, error: String?) {
            self.file = file
            self.content = content
            self.error = error
        }
    }

    /// Staged and unstaged files, one per path (staged first), by path.
    public static func files(_ status: GitStatus?) -> [GitFileStatus] {
        guard let status else { return [] }
        var seen = Set<String>()
        var files: [GitFileStatus] = []
        for file in status.stagedFiles + status.unstagedFiles where seen.insert(file.fullPath).inserted {
            files.append(file)
        }
        return files.sorted { $0.fullPath.localizedCompare($1.fullPath) == .orderedAscending }
    }

    /// A file needs fetching again only when this changes.
    public static func signature(_ file: GitFileStatus, expanded: Bool, ignoreWhitespace: Bool) -> String {
        "\(file.status.rawValue)|\(file.isStaged ? 1 : 0)|\(file.linesAdded)|\(file.linesRemoved)|\(expanded ? "full" : "near")|\(ignoreWhitespace ? "w" : "")"
    }

    /// The session shell calls a fetch makes.
    public typealias Transport = SessionShellTransport

    /// Fetches one file's diff: both sides of an image, an untracked file's
    /// contents, or `git diff HEAD` for the rest.
    public static func fetch(
        _ file: GitFileStatus,
        sessionPath: String?,
        expanded: Bool,
        ignoreWhitespace: Bool,
        transport: Transport
    ) async -> Result {
        guard let sessionPath else {
            return Result(file: file, content: nil, error: "No session path")
        }
        guard let resolved = SessionFileLink.resolve(file.fullPath, sessionRoot: sessionPath),
              resolved.withinSessionRoot, let gitPath = resolved.relativePath else {
            return Result(file: file, content: nil, error: "File is outside the session root.")
        }

        // Images diff as pictures: read both sides instead of asking git
        // for a patch it can't make.
        if ImageFiles.isImage(file.fullPath) {
            async let head: String? = file.status == .untracked ? nil : headBase64(gitPath, cwd: sessionPath, transport: transport)
            async let working: String? = file.status == .deleted ? nil : readBase64(resolved.absolutePath, transport: transport)
            let (before, after) = await (head, working)
            return Result(
                file: file,
                content: .image(
                    before: before.flatMap { ImageFiles.data(file.fullPath, base64: $0) },
                    after: after.flatMap { ImageFiles.data(file.fullPath, base64: $0) }
                ),
                error: nil
            )
        }

        do {
            if file.status == .untracked {
                // readFile rather than `cat`, which PowerShell aliases away.
                let response = try await transport.readFile(resolved.absolutePath)
                guard response.success, let content = response.content, !content.isEmpty else {
                    return Result(file: file, content: nil, error: nonEmpty(response.error) ?? "Failed to read file")
                }
                guard let text = decodeText(content) else {
                    return Result(file: file, content: nil, error: "Failed to decode file")
                }
                return Result(file: file, content: .newFile(text), error: nil)
            }

            let command = GitDiffCommand.diff(gitPath, contextLines: expanded ? GitDiffCommand.fullFileContext : nil, ignoreWhitespace: ignoreWhitespace)
            let response = try await transport.bash(SessionBashRequest(command: command, cwd: sessionPath, timeout: 5000))
            guard response.success else {
                return Result(file: file, content: nil, error: nonEmpty(response.error) ?? "Failed to fetch diff")
            }
            return Result(file: file, content: .patch(response.stdout), error: nil)
        } catch {
            return Result(file: file, content: nil, error: opsError(error))
        }
    }

    private static func headBase64(_ path: String, cwd: String, transport: Transport) async -> String? {
        let request = SessionBashRequest(command: GitDiffCommand.showBase64(path), cwd: cwd, timeout: 8000)
        guard let response = try? await transport.bash(request), response.success else { return nil }
        return response.stdout
    }

    private static func readBase64(_ path: String, transport: Transport) async -> String? {
        guard let response = try? await transport.readFile(path), response.success else { return nil }
        return response.content
    }

    /// `atob` then `new TextDecoder().decode`; nil where `atob` throws.
    static func decodeText(_ base64: String) -> String? {
        JSBase64.decode(base64).map(JSBase64.utf8)
    }

    /// `x || fallback` for an optional string.
    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// Lines in a blob, not counting the terminator after the last one.
    public static func countLines(_ text: String) -> Int {
        if text.isEmpty { return 0 }
        let count = DiffText.lines(text, dropTrailingEmpty: false).count
        return text.utf8.last == UInt8(ascii: "\n") ? count - 1 : count
    }

    /// The list items. Stats start from git status, so an unfetched file
    /// still has a header, and are recounted from the content once it
    /// arrives (`git status` has no counts for untracked files).
    public static func items(_ files: [GitFileStatus], results: [String: Result]) -> [DiffFileItem] {
        files.map { file in
            let result = results[file.fullPath]
            let content = result?.content
            let stats: DiffStats.Counts
            switch content {
            case .patch(let patch)?: stats = DiffStats.countPatch(patch)
            case .newFile(let contents)?: stats = DiffStats.Counts(additions: countLines(contents), deletions: 0)
            case .image?, nil: stats = DiffStats.Counts(additions: file.linesAdded, deletions: file.linesRemoved)
            }
            var item = DiffFileItem(
                path: file.fullPath,
                kind: file.status == .untracked ? .added : file.status == .deleted ? .deleted : .modified,
                additions: stats.additions,
                deletions: stats.deletions,
                error: result?.error
            )
            switch content {
            case .image(let before, let after)?:
                item.image = DiffFileItem.Image(before: before, after: after)
            case .patch(let patch)?:
                item.source = .patch(patch)
            case .newFile(let contents)?:
                item.source = .contents(path: file.fullPath, oldText: "", newText: contents)
            case nil:
                break
            }
            return item
        }
    }

    /// The fetched results kept across file-set changes, so open sections
    /// stay on screen while updated files refresh behind them.
    public struct State: Equatable, Sendable {
        public private(set) var results: [String: Result] = [:]
        public private(set) var hasLoadedOnce = false
        private var signatures: [String: String] = [:]
        private var inFlight: Set<String> = []

        public init() {}

        /// Drops files that are gone and returns the ones to fetch now,
        /// marked in flight.
        public mutating func reconcile(_ files: [GitFileStatus], expanded: Set<String>, ignoreWhitespace: Bool) -> [GitFileStatus] {
            guard !files.isEmpty else {
                results = [:]
                signatures = [:]
                inFlight = []
                hasLoadedOnce = true
                return []
            }
            let paths = Set(files.map(\.fullPath))
            for key in results.keys where !paths.contains(key) { results[key] = nil }
            signatures = signatures.filter { paths.contains($0.key) }
            inFlight = inFlight.filter { paths.contains($0) }

            let toFetch = files.filter { file in
                !inFlight.contains(file.fullPath)
                    && signatures[file.fullPath] != LegacyChanges.signature(file, expanded: expanded.contains(file.fullPath), ignoreWhitespace: ignoreWhitespace)
            }
            if toFetch.isEmpty {
                hasLoadedOnce = true
                return []
            }
            for file in toFetch {
                inFlight.insert(file.fullPath)
                signatures[file.fullPath] = LegacyChanges.signature(file, expanded: expanded.contains(file.fullPath), ignoreWhitespace: ignoreWhitespace)
            }
            return toFetch
        }

        /// Takes in a finished batch. Files dropped meanwhile are ignored.
        public mutating func receive(_ fetched: [Result]) {
            for result in fetched where signatures[result.file.fullPath] != nil {
                results[result.file.fullPath] = result
                inFlight.remove(result.file.fullPath)
            }
            hasLoadedOnce = true
        }

        /// The first-load spinner: shown only until anything has arrived.
        public func isLoading(fileCount: Int) -> Bool {
            !hasLoadedOnce && results.isEmpty && fileCount > 0
        }
    }
}
