import Foundation

/// utils/sessionFileLinks.ts `resolveSessionFilePath`: a path (optionally
/// `:line[:column]`) resolved against the session's root.
public struct SessionFileLink: Equatable, Sendable {
    public var path: String
    public var absolutePath: String
    /// Relative to the session root; "." for the root itself; nil outside it.
    public var relativePath: String?
    public var withinSessionRoot: Bool
    public var line: Int?
    public var column: Int?

    public init(path: String, absolutePath: String, relativePath: String?, withinSessionRoot: Bool, line: Int?, column: Int?) {
        self.path = path
        self.absolutePath = absolutePath
        self.relativePath = relativePath
        self.withinSessionRoot = withinSessionRoot
        self.line = line
        self.column = column
    }

    public static func resolve(_ path: String, sessionRoot: String?) -> SessionFileLink? {
        let parsed = parseLineAndColumn(path)
        guard let absolute = resolvePath(parsed.path, sessionRoot) else { return nil }
        return SessionFileLink(
            path: normalizePath(parsed.path),
            absolutePath: absolute,
            relativePath: relativePath(absolute, sessionRoot),
            withinSessionRoot: isWithinRoot(absolute, sessionRoot),
            line: parsed.line,
            column: parsed.column
        )
    }

    // MARK: Helpers

    /// `^(.*):(\d+):(\d+)$`, then `^(.*):(\d+)$`, on the trimmed value.
    static func parseLineAndColumn(_ value: String) -> (path: String, line: Int?, column: Int?) {
        let trimmed = DiffText.trim(value)
        func splitNumber(_ text: String) -> (String, Int)? {
            guard let colon = text.lastIndex(of: ":") else { return nil }
            let digits = text[text.index(after: colon)...]
            guard !digits.isEmpty, digits.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
            return (String(text[..<colon]), Int(digits) ?? Int.max)
        }
        if let (rest, column) = splitNumber(trimmed), let (path, line) = splitNumber(rest) {
            return (path, line, column)
        }
        if let (path, line) = splitNumber(trimmed) {
            return (path, line, nil)
        }
        return (trimmed, nil, nil)
    }

    static func isWindowsAbsolute(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars.prefix(3))
        guard scalars.count == 3 else { return false }
        return isASCIILetter(scalars[0]) && scalars[1] == ":" && (scalars[2] == "/" || scalars[2] == "\\")
    }

    private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar)
    }

    /// `file://` URLs become paths, percent-decoded when they decode.
    static func decodeFileURL(_ value: String) -> String {
        guard value.lowercased().hasPrefix("file://") else { return value }
        let stripped = String(value.dropFirst(7))
        let normalized = stripped.hasPrefix("/") ? stripped : "/" + stripped
        return normalized.removingPercentEncoding ?? normalized
    }

    /// The home directory a session root lives under, for `~/` paths.
    static func inferHomeDirectory(_ sessionRoot: String?) -> String? {
        guard let sessionRoot else { return nil }
        let parts = normalizePath(sessionRoot).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.count >= 3, parts[0].isEmpty, parts[1] == "Users" || parts[1] == "home", !parts[2].isEmpty {
            return "/\(parts[1])/\(parts[2])"
        }
        if parts.count >= 3, isWindowsAbsolute(parts[0] + "/"), parts[1] == "Users", !parts[2].isEmpty {
            return "\(parts[0])/Users/\(parts[2])"
        }
        return nil
    }

    static func expandHomePath(_ value: String, _ sessionRoot: String?) -> String {
        guard value.hasPrefix("~/"), let home = inferHomeDirectory(sessionRoot) else { return value }
        return home + "/" + value.dropFirst(2)
    }

    /// Forward slashes, `.` and `..` resolved, no doubled or trailing slash.
    public static func normalizePath(_ value: String) -> String {
        let slashes = value.replacingOccurrences(of: "\\", with: "/")
        let windows = isWindowsAbsolute(slashes)
        let posix = slashes.hasPrefix("/")
        let prefix = windows ? String(slashes.prefix(2)) + "/" : posix ? "/" : ""
        let remainder: Substring = windows ? slashes.dropFirst(3) : posix ? slashes.drop(while: { $0 == "/" }) : Substring(slashes)

        var parts: [Substring] = []
        for part in remainder.split(separator: "/", omittingEmptySubsequences: false) {
            if part.isEmpty || part == "." { continue }
            if part == ".." {
                if let last = parts.last, last != ".." {
                    parts.removeLast()
                } else if prefix.isEmpty {
                    parts.append(part)
                }
                continue
            }
            parts.append(part)
        }
        if prefix.isEmpty { return parts.joined(separator: "/") }
        return prefix + parts.joined(separator: "/")
    }

    static func resolvePath(_ path: String, _ sessionRoot: String?) -> String? {
        let expanded = expandHomePath(decodeFileURL(path), sessionRoot)
        guard !expanded.isEmpty else { return nil }
        if isWindowsAbsolute(expanded) || expanded.hasPrefix("/") {
            return normalizePath(expanded)
        }
        guard let sessionRoot else { return nil }
        return normalizePath(normalizePath(sessionRoot) + "/" + expanded)
    }

    /// Compared by code unit, as `startsWith` does.
    static func isWithinRoot(_ path: String, _ root: String?) -> Bool {
        guard let root, !root.isEmpty else { return false }
        let path = normalizePath(path)
        let normalizedRoot = normalizePath(root)
        return path.utf8.elementsEqual(normalizedRoot.utf8) || path.utf8.starts(with: (normalizedRoot + "/").utf8)
    }

    static func relativePath(_ path: String, _ root: String?) -> String? {
        guard let root, isWithinRoot(path, root) else { return nil }
        let path = normalizePath(path)
        let normalizedRoot = normalizePath(root)
        if path.utf8.elementsEqual(normalizedRoot.utf8) { return "." }
        return String(Substring(path.utf8.dropFirst(normalizedRoot.utf8.count + 1)))
    }
}

/// utils/gitDiffCommand.ts: the `git` invocations the diff views run over
/// the session shell.
public enum GitDiffCommand {
    /// Context wide enough to swallow any real file, for "show everything".
    public static let fullFileContext = 100_000

    /// A double-quoted shell argument: `\`, `"`, `$` and backticks escaped.
    public static func quoteShellPath(_ path: String) -> String {
        var out = "\""
        for character in path {
            if character == "\\" || character == "\"" || character == "$" || character == "`" { out.append("\\") }
            out.append(character)
        }
        return out + "\""
    }

    public static func diff(_ path: String, contextLines: Int? = nil, ignoreWhitespace: Bool = false) -> String {
        var flags = ["--no-ext-diff"]
        if let contextLines { flags.append("-U\(contextLines)") }
        if ignoreWhitespace { flags.append("-w") }
        return "git -c core.quotepath=false diff HEAD \(flags.joined(separator: " ")) -- \(quoteShellPath(path))"
    }

    /// The file as HEAD has it, base64 so binary survives.
    public static func showBase64(_ path: String) -> String {
        "git -c core.quotepath=false show HEAD:\(quoteShellPath(path)) | base64"
    }
}

/// utils/imageFiles.ts: files shown as pictures rather than "binary file".
public enum ImageFiles {
    private static let mimeTypes: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
        // SVG is text and diffs perfectly well as text.
    ]

    public static func mimeType(_ path: String) -> String? {
        guard let dot = path.lastIndex(of: ".") else { return nil }
        return mimeTypes[path[path.index(after: dot)...].lowercased()]
    }

    public static func isImage(_ path: String) -> Bool {
        mimeType(path) != nil
    }

    /// `imageDataUri` without the URI: the decoded bytes of base64 a shell
    /// pipeline may have wrapped, or nil for an empty or non-image file.
    public static func data(_ path: String, base64: String) -> Data? {
        guard mimeType(path) != nil else { return nil }
        let clean = String(base64.unicodeScalars.filter { !DiffText.isJSWhitespace($0) })
        guard !clean.isEmpty else { return nil }
        return Data(base64Encoded: clean)
    }

    /// The bytes of a `data:<mime>;base64,<payload>` URI.
    public static func data(dataURI: String) -> Data? {
        guard dataURI.hasPrefix("data:"), let comma = dataURI.firstIndex(of: ","),
              dataURI[..<comma].hasSuffix(";base64") else { return nil }
        return Data(base64Encoded: String(dataURI[dataURI.index(after: comma)...]))
    }
}
