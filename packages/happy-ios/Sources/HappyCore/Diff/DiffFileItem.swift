import Foundation

/// components/diff/DiffFilesList.tsx `DiffFileItem`: one file in a changes
/// list. Header stats come from the caller, so a collapsed file costs
/// nothing; the body is built from `source` only when the file is open.
public struct DiffFileItem: Equatable, Sendable {
    /// useDiffDocument.ts `DiffSource`.
    public enum Source: Equatable, Sendable {
        case patch(String)
        case contents(path: String, oldText: String, newText: String, contextLines: Int? = nil, ignoreWhitespace: Bool? = nil, budget: DiffEngine.Budget? = nil)
    }

    /// Both sides of an image, decoded from base64; nil where the file
    /// doesn't exist on that side.
    public struct Image: Equatable, Sendable {
        public var before: Data?
        public var after: Data?

        public init(before: Data?, after: Data?) {
            self.before = before
            self.after = after
        }
    }

    /// Stable identity; `path` when nil.
    public var key: String?
    public var path: String
    public var kind: FileChangeKind
    public var additions: Int
    public var deletions: Int
    /// Nil while the body is still being fetched.
    public var source: Source?
    /// Set instead of `source` for pictures.
    public var image: Image?
    public var error: String?
    /// Copy for files with no text body.
    public var message: String?

    public init(key: String? = nil, path: String, kind: FileChangeKind, additions: Int, deletions: Int, source: Source? = nil, image: Image? = nil, error: String? = nil, message: String? = nil) {
        self.key = key
        self.path = path
        self.kind = kind
        self.additions = additions
        self.deletions = deletions
        self.source = source
        self.image = image
        self.error = error
        self.message = message
    }

    public var id: String { key ?? path }

    /// Builds through the account's document owner. A stopped owner returns
    /// empty; callers must discard its plans rather than show "no changes".
    public static func document(_ source: Source?, cache: DiffDocumentCache) -> DiffDocument {
        switch source {
        case nil:
            return .empty
        case .patch(let patch):
            return cache.build(patch: patch)
        case .contents(let path, let oldText, let newText, let contextLines, let ignoreWhitespace, let budget):
            var options = DiffEngine.Options()
            if let contextLines { options.contextLines = contextLines }
            if let ignoreWhitespace { options.ignoreWhitespace = ignoreWhitespace }
            options.budget = budget
            return cache.build(path: path, oldText: oldText, newText: newText, options: options)
        }
    }

    /// What an open FileSection shows, in DiffFilesList.tsx's order.
    public enum Body: Equatable, Sendable {
        case error(String)
        case message(String)
        case image(Image)
        case loading
        /// No text changes ("diff.noChanges").
        case noChanges
        case files([DiffFile])
    }

    /// The body of an open section. `document` is `document(source)`.
    public func body(_ document: DiffDocument) -> Body {
        if let error { return .error(error) }
        if let message { return .message(message) }
        if let image { return .image(image) }
        guard let source else { return .loading }
        if let error = document.error { return .error(error) }
        let hasTextRows = document.files.contains { $0.rows.contains { $0.line != nil } }
        if case .contents = source, !hasTextRows { return .noChanges }
        if document.files.isEmpty { return .noChanges }
        return .files(document.files)
    }
}

/// DiffFilesList.tsx's collapse rules.
public enum DiffFilesCollapse {
    /// Files with more changed lines than this start collapsed.
    public static let autoCollapseAbove = 2000

    public static func isTooBig(_ item: DiffFileItem, autoCollapseAbove: Int = autoCollapseAbove) -> Bool {
        item.additions + item.deletions > autoCollapseAbove
    }

    /// A reader's toggle wins; otherwise collapsed when everything starts
    /// collapsed or the file is too big.
    public static func isCollapsed(_ item: DiffFileItem, override: Bool?, defaultCollapsed: Bool, autoCollapseAbove: Int = autoCollapseAbove) -> Bool {
        override ?? (defaultCollapsed || isTooBig(item, autoCollapseAbove: autoCollapseAbove))
    }

    /// "N changed lines — tap to expand" only explains a size-forced close.
    public static func showsSizeHint(_ item: DiffFileItem, collapsed: Bool, autoCollapseAbove: Int = autoCollapseAbove) -> Bool {
        collapsed && isTooBig(item, autoCollapseAbove: autoCollapseAbove)
    }

    /// FileSection asks for a body once per expansion, while it has none.
    public static func needsContent(_ item: DiffFileItem, collapsed: Bool) -> Bool {
        !collapsed && item.source == nil && item.image == nil && item.error == nil && item.message == nil
    }
}
