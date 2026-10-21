import Foundation

/// app/(app)/session/[id]/file.tsx without the drawing: which file, how it
/// is read and decided binary, its uncommitted diff, and which view opens.
public enum FileViewer {
    /// A read file: its text, or binary with no text.
    public struct Content: Equatable, Sendable {
        public var content: String
        public var isBinary: Bool

        public init(content: String, isBinary: Bool) {
            self.content = content
            self.isBinary = isBinary
        }
    }

    /// The store's `sessionFileCache` entry, and a load's result.
    public struct Snapshot: Equatable, Sendable {
        public var content: Content
        /// `git diff` for the file, when it has uncommitted changes.
        public var diff: String?

        public init(content: Content, diff: String?) {
            self.content = content
            self.diff = diff
        }
    }

    public enum LoadResult: Equatable, Sendable {
        case loaded(Snapshot)
        /// The file couldn't be read. `diff` arrived before that, if any.
        case failed(Failure, diff: String?)
    }

    public enum Failure: Equatable, Sendable {
        /// readFile said no, with its error when it gave one ("Failed to
        /// read file" otherwise).
        case read(String?)
        /// The call itself threw ("Failed to load file").
        case load
    }

    public enum DisplayMode: Equatable, Sendable {
        case file, diff
    }

    /// The file the screen shows, resolved against the session root.
    public struct Target: Equatable, Sendable {
        public var filePath: String
        /// Relative to the root, for `git diff`; nil outside it.
        public var gitDiffPath: String?
        public var fileName: String

        public init(rawPath: String, sessionPath: String?) {
            let resolved = SessionFileLink.resolve(rawPath, sessionRoot: sessionPath)
            filePath = resolved?.absolutePath ?? rawPath
            gitDiffPath = resolved?.withinSessionRoot == true ? resolved?.relativePath : nil
            let last = filePath.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
            fileName = last.isEmpty ? filePath : last
        }
    }

    /// The header's path, with the requested line and column.
    public static func headerPath(_ filePath: String, line: Int?, column: Int?) -> String {
        guard let line, line > 0 else { return filePath }
        if let column, column > 0 { return "\(filePath):\(line):\(column)" }
        return "\(filePath):\(line)"
    }

    /// The file's last extension, lower-cased (`split('.').pop()`).
    static func fileExtension(_ path: String) -> String {
        (path.split(separator: ".", omittingEmptySubsequences: false).last.map(String.init) ?? "").lowercased()
    }

    /// `getFileLanguage`: the highlighter's language for a path.
    public static func language(_ path: String) -> String? {
        switch fileExtension(path) {
        case "js", "jsx": "javascript"
        case "ts", "tsx": "typescript"
        case "py": "python"
        case "html", "htm": "html"
        case "css": "css"
        case "json": "json"
        case "md": "markdown"
        case "xml": "xml"
        case "yaml", "yml": "yaml"
        case "sh", "bash": "bash"
        case "sql": "sql"
        case "go": "go"
        case "rust", "rs": "rust"
        case "java": "java"
        case "c": "c"
        case "cpp", "cc", "cxx": "cpp"
        case "php": "php"
        case "rb": "ruby"
        case "swift": "swift"
        case "kt": "kotlin"
        default: nil
        }
    }

    private static let binaryExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico",
        "mp4", "avi", "mov", "wmv", "flv", "webm",
        "mp3", "wav", "flac", "aac", "ogg",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "zip", "tar", "gz", "rar", "7z",
        "exe", "dmg", "deb", "rpm",
        "woff", "woff2", "ttf", "otf",
        "db", "sqlite", "sqlite3",
    ]

    /// `isBinaryFile`: files never read, by extension.
    public static func isBinaryPath(_ path: String) -> Bool {
        binaryExtensions.contains(fileExtension(path))
    }

    /// readFile's base64 as the screen shows it: binary when it doesn't
    /// decode, holds a NUL byte, or more than a tenth of it is control
    /// characters other than tab, newline and return.
    public static func decode(base64: String) -> Content {
        guard let bytes = JSBase64.decode(base64) else { return Content(content: "", isBinary: true) }
        let text = JSBase64.utf8(bytes)
        let units = text.utf16
        let nonPrintable = units.reduce(0) { count, unit in
            unit < 32 && unit != 9 && unit != 10 && unit != 13 ? count + 1 : count
        }
        // 0 / 0 is NaN in JavaScript, and NaN > 0.1 is false.
        let isBinary = bytes.contains(0) || (!units.isEmpty && Double(nonPrintable) / Double(units.count) > 0.1)
        return Content(content: isBinary ? "" : text, isBinary: isBinary)
    }

    /// `git diff --no-ext-diff -- "path"`, for changes not yet staged. The
    /// path is quoted with `GitDiffCommand.quoteShellPath`, where file.tsx
    /// wraps it in bare quotes.
    public static func gitDiffCommand(_ relativePath: String) -> String {
        "git diff --no-ext-diff -- \(GitDiffCommand.quoteShellPath(relativePath))"
    }

    /// file.tsx's `loadFile`: binary extensions are never read; otherwise
    /// the diff (within the root) and then the file itself.
    public static func load(_ target: Target, sessionPath: String?, transport: SessionShellTransport) async -> LoadResult {
        if isBinaryPath(target.filePath) {
            return .loaded(Snapshot(content: Content(content: "", isBinary: true), diff: nil))
        }
        var diff: String?
        if let sessionPath, let gitPath = target.gitDiffPath, gitPath != "." {
            let request = SessionBashRequest(command: gitDiffCommand(gitPath), cwd: sessionPath, timeout: 5000)
            if let response = try? await transport.bash(request), response.success, !DiffText.trim(response.stdout).isEmpty {
                diff = response.stdout
            }
        }
        do {
            let response = try await transport.readFile(target.filePath)
            // An empty file reads as "" and fails here too, as in file.tsx.
            guard response.success, let content = response.content, !content.isEmpty else {
                return .failed(.read(response.error.flatMap { $0.isEmpty ? nil : $0 }), diff: diff)
            }
            return .loaded(Snapshot(content: decode(base64: content), diff: diff))
        } catch {
            return .failed(.load, diff: diff)
        }
    }

    /// `load`, keeping a fresh read in the account's `cache` (file.tsx's
    /// `applyFileCache`); a failed one leaves the kept copy as it was.
    public static func load(
        _ target: Target,
        sessionPath: String?,
        transport: SessionShellTransport,
        cache: SessionFileCache,
        sessionId: String
    ) async -> LoadResult {
        let result = await load(target, sessionPath: sessionPath, transport: transport)
        if case .loaded(let snapshot) = result {
            cache.set(sessionId: sessionId, path: target.filePath, snapshot)
        }
        return result
    }

    /// The view the screen opens on: the file when a line was asked for,
    /// else the diff when there is one, else the file once it has loaded.
    public static func displayMode(requestedLine: Int?, hasDiff: Bool, hasContent: Bool, current: DisplayMode) -> DisplayMode {
        if let requestedLine, requestedLine > 0 { return .file }
        if hasDiff { return .diff }
        if hasContent { return .file }
        return current
    }

    /// What the scrolling content holds, in file.tsx's order.
    public enum Body: Equatable, Sendable {
        /// DiffDisplay.
        case diff
        /// SimpleSyntaxHighlighter over the file.
        case code
        /// "File is empty".
        case fileEmpty
        /// "No changes to display".
        case noChanges
        /// Nothing: the diff was asked for and there is none, but the file
        /// has text.
        case none

        public init(mode: DisplayMode, diff: String?, content: Content?) {
            let hasDiff = !(diff ?? "").isEmpty
            let hasText = !(content?.content ?? "").isEmpty
            if mode == .diff, hasDiff {
                self = .diff
            } else if mode == .file, hasText {
                self = .code
            } else if mode == .file, content != nil {
                self = .fileEmpty
            } else if !hasDiff, !hasText {
                self = .noChanges
            } else {
                self = .none
            }
        }
    }

    /// Where a requested line scrolls to: two lines above it, at 20pt a line.
    public static func scrollOffset(line: Int) -> Double {
        max(0, Double(line - 1) * 20 - 40)
    }

    /// How DiffDisplay draws a line of `git diff` output.
    public enum DiffLineKind: Equatable, Sendable {
        case added, removed, hunk, fileHeader, context

        public init(_ line: String) {
            if DiffText.hasPrefix(line, "+"), !DiffText.hasPrefix(line, "+++") {
                self = .added
            } else if DiffText.hasPrefix(line, "-"), !DiffText.hasPrefix(line, "---") {
                self = .removed
            } else if DiffText.hasPrefix(line, "@@") {
                self = .hunk
            } else if DiffText.hasPrefix(line, "+++") || DiffText.hasPrefix(line, "---") {
                self = .fileHeader
            } else {
                self = .context
            }
        }

        /// Added and removed lines carry a 3pt bar on the left.
        public var hasBar: Bool { self == .added || self == .removed }
        /// Hunk and file headers are semibold.
        public var isBold: Bool { self == .hunk || self == .fileHeader }
    }

    /// DiffDisplay's rows: `split('\n')`, an empty line drawn as a space.
    /// A CRLF line's carriage return is left off the text it draws.
    public static func diffLines(_ diff: String) -> [(text: String, kind: DiffLineKind)] {
        DiffText.lines(diff, dropTrailingEmpty: false).map { line in
            let shown = dropCarriageReturn(line)
            return (shown.isEmpty ? " " : shown, DiffLineKind(line))
        }
    }

    /// SimpleSyntaxHighlighter's tokens for the whole file (the account's
    /// `CodeSyntaxService`'s, or the file as one plain token), split into
    /// its lines (`split('\n')`) so each can be measured and drawn on its
    /// own. The one Text block wraps each line in turn, so this draws the
    /// same. A CRLF line's carriage return, which ends the paragraph with
    /// the newline there, is left off.
    public static func codeLines(_ tokens: [SyntaxToken]) -> [[SyntaxToken]] {
        var lines: [[SyntaxToken]] = [[]]
        for token in tokens {
            for (index, part) in token.text.jsSplit("\n").enumerated() {
                if index > 0 { lines.append([]) }
                if !part.isEmpty {
                    lines[lines.count - 1].append(SyntaxToken(part, token.kind, nestLevel: token.nestLevel))
                }
            }
        }
        for index in lines.indices {
            guard var last = lines[index].last, last.text.utf16.last == 13 else { continue }
            last.text = dropCarriageReturn(last.text)
            if last.text.isEmpty { lines[index].removeLast() } else { lines[index][lines[index].count - 1] = last }
        }
        return lines
    }

    private static func dropCarriageReturn(_ line: String) -> String {
        line.utf16.last == 13 ? String(line.utf16.dropLast()) ?? line : line
    }
}
