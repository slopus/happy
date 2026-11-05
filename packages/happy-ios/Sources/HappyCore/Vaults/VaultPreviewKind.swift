import Foundation

/// How a vault entry is previewed on the phone: an artifact as its live
/// site, a file by what it holds, and anything else through the share
/// sheet.
public enum VaultPreviewKind: Equatable, Sendable {
    case site
    case markdown
    case image
    case video
    case audio
    case pdf
    /// Text or code, with the language its colours come from.
    case text(language: String?)
    /// Read whole and shown by Quick Look, or shared.
    case other

    /// Text past this is shown by Quick Look rather than measured line by line.
    public static let textLimit = 2 * 1024 * 1024

    public init(_ entry: VaultEntry) {
        switch entry.kind {
        case .folder: self = .other
        case .artifact: self = .site
        case .file: self = Self(mediaType: entry.mediaType ?? "", name: entry.name, size: entry.size ?? 0)
        }
    }

    public init(mediaType: String, name: String, size: Int) {
        let ext = (name as NSString).pathExtension.lowercased()
        if mediaType.hasPrefix("text/markdown") || ["md", "markdown"].contains(ext) { self = size <= Self.textLimit ? .markdown : .other; return }
        if mediaType.hasPrefix("image/"), mediaType != "image/svg+xml" { self = .image; return }
        if mediaType.hasPrefix("video/") { self = .video; return }
        if mediaType.hasPrefix("audio/") { self = .audio; return }
        if mediaType == "application/pdf" { self = .pdf; return }
        if Self.isCode(mediaType: mediaType, name: name) || mediaType.hasPrefix("text/") || Self.language[ext] != nil {
            self = size <= Self.textLimit ? .text(language: Self.language[ext]) : .other
            return
        }
        self = .other
    }

    /// Source and data formats people read as text, whatever media type the
    /// daemon's table gives their extension.
    public static func isCode(mediaType: String, name: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        if let language = language[ext] { return language != "plaintext" }
        return ["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml", "application/toml", "image/svg+xml"].contains(mediaType)
    }

    /// The highlighter's language names by extension.
    static let language: [String: String] = [
        "swift": "swift", "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript", "ts": "typescript", "tsx": "typescript",
        "json": "json", "py": "python", "rb": "ruby", "go": "go", "rs": "rust", "java": "java", "kt": "kotlin", "c": "c", "h": "c", "cpp": "cpp",
        "cc": "cpp", "hpp": "cpp", "m": "objectivec", "cs": "csharp", "php": "php", "sh": "bash", "bash": "bash", "zsh": "bash", "yml": "yaml",
        "yaml": "yaml", "toml": "toml", "xml": "xml", "html": "html", "htm": "html", "css": "css", "scss": "scss", "sql": "sql", "svg": "xml",
        "txt": "plaintext", "csv": "plaintext", "log": "plaintext", "ini": "ini", "lua": "lua", "dart": "dart", "r": "r", "vue": "html",
    ]
}
