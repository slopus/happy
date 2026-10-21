import Foundation

// components/diff/engine/types.ts: the diff renderer's data model.
// Theme-independent and immutable: parsing, word diffing and span merging
// run once per input and are cached, so drawing is all that is left.
// Text offsets everywhere in this engine are UTF-16 units, as JavaScript
// counts them.

/// Prism-ish token classes, collapsed to a small palette.
public enum DiffSpanKind: String, Equatable, Hashable, Sendable, CaseIterable {
    case plain, keyword, string, comment, number, function, `operator`, punctuation, type, variable, tag, attr
}

/// Intra-line emphasis: which side of a word-level change a run belongs to.
public enum DiffEmphasis: UInt8, Equatable, Sendable {
    case none = 0
    case inserted = 1
    case deleted = 2
}

/// One styled run of text inside a rendered line.
public struct DiffSpan: Equatable, Sendable {
    public var text: String
    public var kind: DiffSpanKind
    public var emphasis: DiffEmphasis

    public init(_ text: String, _ kind: DiffSpanKind = .plain, _ emphasis: DiffEmphasis = .none) {
        self.text = text
        self.kind = kind
        self.emphasis = emphasis
    }
}

public enum DiffLineType: String, Equatable, Hashable, Sendable {
    case add, del, ctx
}

public struct DiffLine: Equatable, Sendable {
    /// Stable key, unique within a file.
    public var key: String
    public var type: DiffLineType
    /// 1-based line number on the old side; nil for additions.
    public var oldNo: Int?
    /// 1-based line number on the new side; nil for deletions.
    public var newNo: Int?
    /// Raw text without the +/- marker, tabs expanded.
    public var text: String
    public var spans: [DiffSpan]

    public init(key: String, type: DiffLineType, oldNo: Int? = nil, newNo: Int? = nil, text: String, spans: [DiffSpan]) {
        self.key = key
        self.type = type
        self.oldNo = oldNo
        self.newNo = newNo
        self.text = text
        self.spans = spans
    }
}

public struct DiffHunk: Equatable, Sendable {
    public var key: String
    /// `@@ -1,7 +1,9 @@`
    public var text: String
    /// What git puts after the closing `@@`, usually the enclosing function.
    public var section: String
    /// Unchanged lines hidden above this hunk, when known.
    public var hidden: Int?

    public init(key: String, text: String, section: String, hidden: Int? = nil) {
        self.key = key
        self.text = text
        self.section = section
        self.hidden = hidden
    }
}

public enum DiffMessageCode: String, Equatable, Sendable {
    case binary, empty
}

/// One rendered row. Rows are flat so lists can virtualize them directly.
public enum DiffRow: Equatable, Sendable {
    case line(DiffLine)
    case hunk(DiffHunk)
    case message(key: String, code: DiffMessageCode)

    public var key: String {
        switch self {
        case .line(let line): line.key
        case .hunk(let hunk): hunk.key
        case .message(let key, _): key
        }
    }

    public var line: DiffLine? {
        if case .line(let line) = self { return line }
        return nil
    }

    /// What Copy takes from a `selectable` row (DiffRowCode's Text): a
    /// line's text as drawn, a space for an empty one. Hunk and message
    /// rows aren't selectable.
    public var selectableText: String? {
        guard case .line(let line) = self else { return nil }
        let text = line.spans.map(\.text).joined()
        return text.isEmpty ? " " : text
    }
}

public enum FileChangeKind: String, Equatable, Hashable, Sendable {
    case modified, added, deleted, renamed, binary
}

/// One file's diff, ready to render.
public struct DiffFile: Equatable, Sendable {
    /// The path shown (the new path for renames).
    public var path: String
    /// The previous path, for renames only.
    public var oldPath: String?
    public var kind: FileChangeKind
    /// The detected language id, for syntax highlighting.
    public var language: String?
    public var additions: Int
    public var deletions: Int
    public var rows: [DiffRow]
    /// The longest row in UTF-16 units: the horizontal scroll width.
    public var maxColumns: Int
    /// The widest line number: the gutter width.
    public var maxLineNo: Int

    public init(path: String, oldPath: String? = nil, kind: FileChangeKind, language: String?, additions: Int, deletions: Int, rows: [DiffRow], maxColumns: Int, maxLineNo: Int) {
        self.path = path
        self.oldPath = oldPath
        self.kind = kind
        self.language = language
        self.additions = additions
        self.deletions = deletions
        self.rows = rows
        self.maxColumns = maxColumns
        self.maxLineNo = maxLineNo
    }
}

/// A built diff. A class so the cache hands back the same instance, as the
/// JavaScript engine does, and callers can compare by identity.
public final class DiffDocument: Sendable {
    public let files: [DiffFile]
    public let additions: Int
    public let deletions: Int
    /// Milliseconds spent building it.
    public let buildMs: Double
    /// An informational failure, such as a diff budget running out.
    public let error: String?

    public init(files: [DiffFile], additions: Int, deletions: Int, buildMs: Double, error: String? = nil) {
        self.files = files
        self.additions = additions
        self.deletions = deletions
        self.buildMs = buildMs
        self.error = error
    }

    public static let empty = DiffDocument(files: [], additions: 0, deletions: 0, buildMs: 0)
}
