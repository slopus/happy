import Foundation

/// components/HappyAgentDiffView.tsx and hooks/useHappyAgentGitFiles.ts
/// without the drawing: a Happy Agent session's workspace compared with its
/// branch base, one file read at a time as the reader opens it.
public enum HappyAgentChanges {
    /// The phone runs the line diff itself; the edit length bounds Myers'
    /// cost and the timeout is a wall-clock backstop for slow devices.
    public static let diffBudget = DiffEngine.Budget(timeoutMs: 200, maxEditLength: 2000)

    /// One file's read: its content, or why it failed.
    public enum FileResult: Equatable, Sendable {
        case content(HappyAgentFileContent)
        case error(String)
    }

    /// What the screen shows for a loaded state.
    public enum Body: Equatable, Sendable {
        /// A centred message with Retry.
        case unavailable
        case files
    }

    /// `comparison !== 'ready' || !base` shows the "not available" message.
    public static func base(_ state: HappyAgentGitState) -> String? {
        guard state.comparison == .ready, let base = state.base, !base.isEmpty else { return nil }
        return base
    }

    /// The notices over the list, in order.
    public static func notices(_ state: HappyAgentGitState) -> [String] {
        var notices: [String] = []
        if state.filesTruncated {
            notices.append("Showing \(state.files.count) of \(state.changedFiles) changed files. Open the workspace on your computer to see the full list.")
        }
        if !state.countsExact { notices.append("Change counts are approximate for this workspace.") }
        if state.conflicted { notices.append("This workspace has unresolved merge conflicts.") }
        return notices
    }

    /// A truly clean workspace says "no changes"; anything else with no
    /// files says the details are missing.
    public static func isClean(_ state: HappyAgentGitState) -> Bool {
        state.changedFiles == 0 && state.countsExact && !state.filesTruncated && !state.conflicted
    }

    public static func kind(_ status: HappyAgentGitFileStatus) -> FileChangeKind {
        switch status {
        case .added, .untracked, .copied: .added
        case .deleted: .deleted
        case .renamed: .renamed
        default: .modified
        }
    }

    /// The list items. `matchText` and `emptyText` are the copy for a file
    /// whose two sides are identical (non-empty and empty).
    public static func items(
        _ files: [HappyAgentGitFile],
        results: [String: FileResult],
        expandedContext: Set<String>,
        ignoreWhitespace: Bool,
        matchText: String,
        emptyText: String
    ) -> [DiffFileItem] {
        files.map { file in
            var item = DiffFileItem(
                path: file.path,
                kind: kind(file.status),
                additions: file.insertions ?? 0,
                deletions: file.deletions ?? 0
            )
            switch results[file.path] {
            case .error(let error)?:
                item.error = error
            case .content(.image(let before, let after))?:
                item.image = DiffFileItem.Image(
                    before: before.flatMap { ImageFiles.data(dataURI: $0) },
                    after: after.flatMap { ImageFiles.data(dataURI: $0) }
                )
            case .content(.message(let message))?:
                item.message = message
            case .content(.text(let oldText, let newText))?:
                if oldText == newText {
                    item.message = newText.isEmpty ? emptyText : matchText
                }
                item.source = .contents(
                    path: file.path,
                    oldText: oldText,
                    newText: newText,
                    contextLines: expandedContext.contains(file.path) ? GitDiffCommand.fullFileContext : nil,
                    ignoreWhitespace: ignoreWhitespace,
                    budget: diffBudget
                )
            case nil:
                break
            }
            return item
        }
    }

    /// useHappyAgentGitFiles' queue for one displayed snapshot: nothing is
    /// read until a file is opened, each file is read once, at most two at
    /// a time, and a failed file is never retried by itself. A new
    /// snapshot gets a new queue, so replies for an old one are dropped by
    /// the caller along with it.
    public struct FileQueue: Equatable, Sendable {
        public private(set) var results: [String: FileResult] = [:]
        /// In the order they were asked for, like a JS Set.
        private var requested: [String] = []
        private var inFlight: Set<String> = []
        private let paths: Set<String>

        public static let maxInFlight = 2

        public init(files: [HappyAgentGitFile]) {
            paths = Set(files.map(\.path))
        }

        /// Marks a file wanted. Unknown paths are ignored.
        public mutating func request(_ path: String) {
            guard paths.contains(path), !requested.contains(path) else { return }
            requested.append(path)
        }

        /// The files to start reading now, marked in flight.
        public mutating func start() -> [String] {
            var started: [String] = []
            for path in requested {
                if inFlight.count >= Self.maxInFlight { break }
                if results[path] != nil || inFlight.contains(path) { continue }
                inFlight.insert(path)
                started.append(path)
            }
            return started
        }

        public mutating func finish(_ path: String, _ result: FileResult) {
            guard inFlight.remove(path) != nil else { return }
            results[path] = result
        }

        public func isInFlight(_ path: String) -> Bool {
            inFlight.contains(path)
        }
    }
}
