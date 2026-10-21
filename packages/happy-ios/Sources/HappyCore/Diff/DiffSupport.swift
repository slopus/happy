import Foundation

/// engine/lru.ts: a small bounded cache, least recently read out first,
/// with an optional total weight. Thread-safe, because documents are built
/// off the main thread.
public final class DiffLRUCache<Value>: @unchecked Sendable {
    private let limit: Int
    private let maxWeight: Int
    private let lock = NSLock()
    private var entries: [String: (value: Value, weight: Int, tick: UInt64)] = [:]
    private var weight = 0
    private var tick: UInt64 = 0

    public init(limit: Int, maxWeight: Int = .max) {
        self.limit = limit
        self.maxWeight = maxWeight
    }

    public func get(_ key: String) -> Value? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = entries[key] else { return nil }
        tick += 1
        entries[key] = (entry.value, entry.weight, tick)
        return entry.value
    }

    public func set(_ key: String, _ value: Value, weight: Int = 1) {
        lock.lock()
        defer { lock.unlock() }
        if let previous = entries.removeValue(forKey: key) {
            self.weight -= previous.weight
        }
        if weight > maxWeight { return }
        tick += 1
        entries[key] = (value, weight, tick)
        self.weight += weight
        while entries.count > limit || self.weight > maxWeight {
            guard let oldest = entries.min(by: { $0.value.tick < $1.value.tick }) else { break }
            self.weight -= oldest.value.weight
            entries.removeValue(forKey: oldest.key)
        }
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
        weight = 0
    }

    /// Retained payload accounting for owner lifecycle checks and diagnostics.
    var retainedUsage: (count: Int, bytes: Int) {
        lock.withLock { (entries.count, weight) }
    }
}

/// engine/language.ts: the Prism grammar id for a file name.
public enum DiffLanguage {
    private static let byExtension: [String: String] = [
        "ts": "typescript", "tsx": "tsx", "mts": "typescript", "cts": "typescript",
        "js": "javascript", "jsx": "jsx", "mjs": "javascript", "cjs": "javascript",
        "json": "json", "jsonc": "json", "json5": "json",
        "py": "python", "pyi": "python", "rb": "ruby", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin", "kts": "kotlin", "swift": "swift",
        "m": "objectivec", "mm": "objectivec", "c": "c", "h": "c",
        "cc": "cpp", "cpp": "cpp", "cxx": "cpp", "hpp": "cpp", "cs": "csharp", "php": "php",
        "sh": "bash", "bash": "bash", "zsh": "bash", "fish": "bash", "ps1": "powershell",
        "sql": "sql", "css": "css", "scss": "scss", "sass": "scss", "less": "less",
        "html": "markup", "htm": "markup", "xml": "markup", "svg": "markup", "vue": "markup",
        "md": "markdown", "mdx": "markdown", "yml": "yaml", "yaml": "yaml", "toml": "toml",
        "ini": "ini", "cfg": "ini", "env": "bash", "dart": "dart", "ex": "elixir", "exs": "elixir",
        "erl": "erlang", "hs": "haskell", "lua": "lua", "r": "r", "scala": "scala",
        "graphql": "graphql", "gql": "graphql", "proto": "protobuf", "tf": "hcl", "hcl": "hcl",
        "zig": "zig", "nim": "nim", "pl": "perl", "diff": "diff", "patch": "diff",
    ]

    private static let byFileName: [String: String] = [
        "dockerfile": "docker", "makefile": "makefile", "cmakelists.txt": "cmake",
        "gemfile": "ruby", "rakefile": "ruby", ".gitignore": "ignore", ".npmrc": "ini", ".editorconfig": "ini",
    ]

    public static func detect(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let name = (path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path).lowercased()
        if let language = byFileName[name] { return language }
        guard let dot = name.lastIndex(of: "."), name.index(after: dot) != name.endIndex else { return nil }
        return byExtension[String(name[name.index(after: dot)...])]
    }
}

/// engine/stats.ts: `+N −M` without building anything.
public enum DiffStats {
    public struct Counts: Equatable, Sendable {
        public var additions: Int
        public var deletions: Int

        public init(additions: Int, deletions: Int) {
            self.additions = additions
            self.deletions = deletions
        }
    }

    /// Changed lines in a patch, counted in one pass.
    public static func countPatch(_ patch: String) -> Counts {
        var additions = 0
        var deletions = 0
        var inHunk = false
        for line in DiffText.lines(patch, dropTrailingEmpty: false) {
            let bytes = line.utf8
            guard let first = bytes.first else { continue }
            if first == UInt8(ascii: "@"), bytes.starts(with: "@@".utf8) {
                inHunk = true
            } else if inHunk {
                if first == UInt8(ascii: "+"), !bytes.starts(with: "+++".utf8) {
                    additions += 1
                } else if first == UInt8(ascii: "-"), !bytes.starts(with: "---".utf8) {
                    deletions += 1
                } else if first == UInt8(ascii: "d"), bytes.starts(with: "diff ".utf8) {
                    inHunk = false
                }
            }
        }
        return Counts(additions: additions, deletions: deletions)
    }

    /// The same numbers for two blobs, from the line diff the renderer uses.
    public static func countContents(_ oldText: String, _ newText: String) -> Counts {
        var additions = 0
        var deletions = 0
        for change in MyersDiff.diffLines(oldText, newText) ?? [] where change.added || change.removed {
            let count = DiffText.lines(change.value, dropTrailingEmpty: true).count
            if change.added { additions += count } else { deletions += count }
        }
        return Counts(additions: additions, deletions: deletions)
    }
}

/// String helpers that count and split the way JavaScript does: by UTF-16
/// unit, never by grapheme (Swift's Character joins `\r\n` into one).
enum DiffText {
    /// `text.split('\n')`, minus the empty piece a final newline leaves when
    /// `dropTrailingEmpty` (`splitKeep` in parsePatch.ts).
    static func lines(_ text: String, dropTrailingEmpty: Bool) -> [String] {
        var parts = text.utf8.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false).map { slice in
            String(Substring(slice))
        }
        if dropTrailingEmpty, parts.last == "" { parts.removeLast() }
        return parts
    }

    static func hasPrefix(_ text: String, _ prefix: String) -> Bool {
        text.utf8.starts(with: prefix.utf8)
    }

    /// `text.slice(n)` for a prefix of `n` ASCII characters.
    static func droppingASCII(_ text: String, _ count: Int) -> String {
        String(Substring(text.utf8.dropFirst(count)))
    }

    /// JavaScript's `String.prototype.trim`.
    static func trim(_ text: String) -> String {
        let scalars = text.unicodeScalars
        guard let start = scalars.firstIndex(where: { !isJSWhitespace($0) }),
              let end = scalars.lastIndex(where: { !isJSWhitespace($0) }) else { return "" }
        return String(scalars[start...end])
    }

    /// `\s` in JavaScript.
    static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    static func utf16Length(_ text: String) -> Int {
        text.utf16.count
    }

    /// The text of UTF-16 units `range` of `units`.
    static func string(_ units: [UInt16], _ range: Range<Int>) -> String {
        String(decoding: units[range], as: UTF16.self)
    }
}
