import Foundation
import HappyWire

/// findActiveWord.ts: the prefixed word around the caret. Offsets are
/// UTF-16, as in JavaScript and `UITextView.selectedRange`.
public struct ActiveWord: Equatable, Sendable {
    /// From the prefix to the word's end ("@username").
    public var word: String
    /// From the prefix to the caret ("@use"): the query.
    public var activeWord: String
    public var offset: Int
    public var length: Int
    public var activeLength: Int
    public var endOffset: Int
}

/// The composer's autocomplete: findActiveWord.ts, applySuggestion.ts and
/// useActiveSuggestions' selection.
public enum ComposerAutocomplete {
    /// SessionView's AGENT_INPUT_AUTOCOMPLETE_PREFIXES.
    public static let chatPrefixes: [Character] = ["@", "/"]
    /// findActiveWord's default.
    public static let defaultPrefixes: [Character] = ["@", ":", "/"]

    private static let space: UInt16 = 0x20
    private static let newline: UInt16 = 0x0A
    private static let at: UInt16 = 0x40
    private static let stopCharacters = Set("\n,()[]{}<>;!?.".utf16)

    private static func units(_ prefixes: [Character]) -> Set<UInt16> {
        Set(prefixes.compactMap { $0.utf16.count == 1 ? $0.utf16.first : nil })
    }

    private static func string(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: units, as: UTF16.self)
    }

    public static func findActiveWord(
        _ content: String,
        selection: NSRange,
        prefixes: [Character] = defaultPrefixes
    ) -> ActiveWord? {
        findActiveWord(UnitArray(units: Array(content.utf16)), selection: selection, prefixes: prefixes)
    }

    /// The same, read straight from a text view's storage
    /// (`NSTextStorage.mutableString`): only the units the search visits
    /// are read, and only the word is copied out, so a long text isn't
    /// copied on every keystroke. Read it on the thread that owns it.
    public static func findActiveWord(
        units content: NSString,
        selection: NSRange,
        prefixes: [Character] = defaultPrefixes
    ) -> ActiveWord? {
        findActiveWord(UnitString(string: content), selection: selection, prefixes: prefixes)
    }

    private static func findActiveWord(
        _ text: some UTF16Units,
        selection: NSRange,
        prefixes: [Character]
    ) -> ActiveWord? {
        // Only at a caret, and not at the very start.
        guard selection.length == 0, selection.location > 0 else { return nil }
        let prefixSet = units(prefixes)
        let cursor = min(selection.location, text.count)
        let start = min(wordStart(text, cursor: selection.location, prefixes: prefixSet), cursor)
        guard start < cursor, text[cursor - 1] != space, prefixSet.contains(text[start]) else { return nil }
        // From the caret as given: substring clamps, the offset doesn't.
        let end = wordEnd(text, cursor: selection.location, wordStart: start)
        let wordEnd = min(end, text.count)
        return ActiveWord(
            word: text.string(start..<wordEnd),
            activeWord: text.string(start..<cursor),
            offset: start,
            length: wordEnd - start,
            activeLength: cursor - start,
            endOffset: end
        )
    }

    /// `findActiveWordStart`. A prefix only counts at the start of the text
    /// or after a space or newline; one space may come between it and the
    /// caret, two may not.
    private static func wordStart(_ text: some UTF16Units, cursor: Int, prefixes: Set<UInt16>) -> Int {
        var index = cursor - 1
        var spaceIndex = -1
        while index >= 0 {
            // charAt past the end is "", which is none of these.
            let unit: UInt16? = index < text.count ? text[index] : nil
            if unit == space {
                if spaceIndex >= 0 {
                    return spaceIndex + 1
                }
                spaceIndex = index
                index -= 1
            } else if let unit, prefixes.contains(unit),
                      index == 0 || text[index - 1] == space || text[index - 1] == newline {
                return index
            } else if let unit, stopCharacters.contains(unit) {
                return index + 1
            } else {
                index -= 1
            }
        }
        return (spaceIndex >= 0 ? spaceIndex : index) + 1
    }

    /// `findActiveWordEnd`: on to a space or stop character; a file path
    /// (`@…`) runs through slashes and dots.
    private static func wordEnd(_ text: some UTF16Units, cursor: Int, wordStart: Int) -> Int {
        let isFilePath = wordStart >= 0 && wordStart < text.count && text[wordStart] == at
        var end = cursor
        while end < text.count {
            let unit = text[end]
            if isFilePath, unit == 0x2F || unit == 0x2E {
                end += 1
                continue
            }
            if unit == space || stopCharacters.contains(unit) {
                break
            }
            end += 1
        }
        return end
    }

    /// applySuggestion.ts: the whole active word becomes `suggestion`, then
    /// a space unless one follows; with no active word it goes in at the
    /// caret. The caret lands after it.
    public static func applySuggestion(
        _ content: String,
        selection: NSRange,
        suggestion: String,
        prefixes: [Character] = defaultPrefixes,
        addSpace: Bool = true
    ) -> (text: String, cursor: Int) {
        let text = Array(content.utf16)
        guard let word = findActiveWord(content, selection: selection, prefixes: prefixes) else {
            let start = min(max(0, selection.location), text.count)
            let end = min(max(start, selection.location + selection.length), text.count)
            let insert = addSpace ? suggestion + " " : suggestion
            return (
                string(text[..<start]) + insert + string(text[end...]),
                selection.location + insert.utf16.count
            )
        }
        let after = text[word.endOffset...]
        var insert = suggestion
        if addSpace, after.first != space {
            insert += " "
        }
        return (string(text[..<word.offset]) + insert + string(after), word.offset + insert.utf16.count)
    }

    /// useActiveSuggestions with `clampSelection` and `autoSelectFirst`:
    /// the highlighted row after a new list arrives. -1 is none.
    public static func selection(previous: Int, previousCount: Int, count: Int) -> Int {
        if count == 0 { return -1 }
        if previousCount == 0 { return 0 }
        if previous >= count { return count - 1 }
        if previous < 0 { return 0 }
        return previous
    }
}

/// Text as UTF-16 units, read by offset.
private protocol UTF16Units {
    var count: Int { get }
    subscript(_ index: Int) -> UInt16 { get }
    func string(_ range: Range<Int>) -> String
}

private struct UnitArray: UTF16Units {
    let units: [UInt16]
    var count: Int { units.count }
    subscript(_ index: Int) -> UInt16 { units[index] }
    func string(_ range: Range<Int>) -> String {
        String(decoding: units[range], as: UTF16.self)
    }
}

private struct UnitString: UTF16Units {
    let string: NSString
    var count: Int { string.length }
    subscript(_ index: Int) -> UInt16 { string.character(at: index) }
    /// Decoded as the array's are, so half a surrogate pair reads the same.
    func string(_ range: Range<Int>) -> String {
        var units = [UInt16](repeating: 0, count: range.count)
        string.getCharacters(&units, range: NSRange(location: range.lowerBound, length: range.count))
        return String(decoding: units, as: UTF16.self)
    }
}

/// A row in the suggestion list (AgentInputSuggestionView.tsx).
public struct ComposerSuggestion: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case command(name: String, description: String?)
        case file(name: String, path: String, isFolder: Bool)
    }

    public var key: String
    /// What replaces the active word.
    public var text: String
    public var kind: Kind

    public init(key: String, text: String, kind: Kind) {
        self.key = key
        self.text = text
        self.kind = kind
    }
}

/// suggestionCommands.ts: the slash commands a session offers.
public enum ComposerCommands {
    public struct Command: Equatable, Sendable {
        public var command: String
        public var description: String?

        public init(_ command: String, _ description: String? = nil) {
            self.command = command
            self.description = description
        }
    }

    public static let ignored: Set<String> = [
        "add-dir", "agents", "config", "statusline", "bashes", "settings", "cost", "doctor", "exit", "help", "ide",
        "init", "install-github-app", "memory", "migrate-installer", "model", "pr-comments", "release-notes",
        "resume", "status", "bug", "review", "security-review", "terminal-setup", "upgrade", "vim", "permissions",
        "hooks", "export", "logout", "login",
    ]

    public static let defaults: [Command] = [
        Command("compact", "Compact the conversation history"),
        Command("clear", "Clear the conversation"),
        Command("goal", "Set a session goal"),
        Command("mcp", "Show connected MCP servers"),
        Command("skills", "Show available skills"),
    ]

    static let descriptions: [String: String] = [
        "compact": "Compact the conversation history",
        "goal": "Set a session goal",
        "help": "Show available commands",
        "clear": "Clear the conversation",
        "reset": "Reset the session",
        "export": "Export conversation",
        "debug": "Show debug information",
        "status": "Show connection status",
        "stop": "Stop current operation",
        "abort": "Abort current operation",
        "cancel": "Cancel current operation",
    ]

    /// `getCommandsFromSession`: the defaults, then the metadata's
    /// slashCommands and skills, minus the ignored and the repeated.
    public static func commands(metadata: JSONValue?) -> [Command] {
        guard let metadata, metadata.objectValue != nil else { return defaults }
        var commands = defaults
        let listed = (metadata["slashCommands"]?.arrayValue ?? []) + (metadata["skills"]?.arrayValue ?? [])
        for name in listed.compactMap(\.stringValue) where !ignored.contains(name) {
            if !commands.contains(where: { $0.command == name }) {
                commands.append(Command(name, descriptions[name]))
            }
        }
        return commands
    }

    /// `searchCommands`: all of them for an empty query, else Fuse on the
    /// name (0.7) and description (0.3) at 0.3.
    public static func search(_ query: String, metadata: JSONValue?, limit: Int = 10) -> [Command] {
        let commands = commands(metadata: metadata)
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Array(commands.prefix(limit))
        }
        let fuse = FuzzySearch(commands, keys: [
            .init(weight: 0.7) { $0.command },
            .init(weight: 0.3) { $0.description },
        ])
        return fuse.search(query, limit: limit)
    }

    /// suggestions.ts `getCommandSuggestions`, for an active word "/…".
    public static func suggestions(_ activeWord: String, metadata: JSONValue?) -> [ComposerSuggestion] {
        search(String(activeWord.dropFirst()), metadata: metadata, limit: 50).map {
            ComposerSuggestion(key: "cmd-\($0.command)", text: "/\($0.command)", kind: .command(name: $0.command, description: $0.description))
        }
    }
}

/// suggestionFile.ts: a session's files and folders, from ripgrep.
public enum ComposerFiles {
    public struct Item: Equatable, Sendable {
        public var fileName: String
        /// The folder, with a trailing slash, or "".
        public var filePath: String
        public var fullPath: String
        public var isFolder: Bool
    }

    /// `rg --files` output: every file, then every folder above them (in
    /// first-seen order), folders with a trailing slash.
    public static func items(ripgrepOutput stdout: String) -> [Item] {
        let paths = stdout.components(separatedBy: "\n").filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        var items: [Item] = []
        for path in paths {
            let parts = path.components(separatedBy: "/")
            let name = parts.last.flatMap { $0.isEmpty ? nil : $0 } ?? path
            let folder = parts.dropLast().joined(separator: "/")
            items.append(Item(fileName: name, filePath: folder.isEmpty ? "" : folder + "/", fullPath: path, isFolder: false))
        }
        var seen: Set<String> = []
        var folders: [String] = []
        for path in paths {
            let parts = path.components(separatedBy: "/")
            guard parts.count > 1 else { continue }
            for end in 1...(parts.count - 1) {
                let folder = parts[..<end].joined(separator: "/")
                if !folder.isEmpty, seen.insert(folder).inserted {
                    folders.append(folder)
                }
            }
        }
        for folder in folders {
            let parts = folder.components(separatedBy: "/")
            let parent = parts.dropLast().joined(separator: "/")
            items.append(Item(
                fileName: (parts.last ?? "") + "/",
                filePath: parent.isEmpty ? "" : parent + "/",
                fullPath: folder + "/",
                isFolder: true
            ))
        }
        return items
    }

    /// Fuse on the name (0.7) and the full path (0.3) at 0.3.
    public static func index(_ items: [Item]) -> FuzzySearch<Item> {
        FuzzySearch(items, keys: [
            .init(weight: 0.7) { $0.fileName },
            .init(weight: 0.3) { $0.fullPath },
        ])
    }

    /// `search`: the first `limit` for an empty query, else the matches.
    public static func search(_ query: String, in index: FuzzySearch<Item>, items: [Item], limit: Int = 10) -> [Item] {
        guard !items.isEmpty else { return [] }
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Array(items.prefix(limit))
        }
        return index.search(query, limit: limit)
    }

    static func suggestion(_ item: Item) -> ComposerSuggestion {
        ComposerSuggestion(
            key: "file-\(item.fullPath)",
            text: "@\(item.fullPath)",
            kind: .file(name: item.fileName, path: item.filePath, isFolder: item.isFolder)
        )
    }
}

/// suggestionFile.ts's FileSearchCache: each session's file list, fetched
/// with `rg --files --follow` and kept five minutes. Refreshes don't
/// overlap, and one within a second of the last is skipped. A failed
/// fetch keeps what was there. One per account
/// (`AccountSession.composerFileIndex`), keyed by session id within it.
public actor ComposerFileIndex {
    /// `sessionRipgrep(sessionId, ['--files', '--follow'])`; nil if it threw.
    public typealias Fetch = @Sendable (_ sessionId: String) async -> SessionRipgrepResponse?

    public static let ripgrepArguments = ["--files", "--follow"]

    private struct Cache {
        var items: [ComposerFiles.Item] = []
        var index: FuzzySearch<ComposerFiles.Item>?
        var lastRefresh: Date = .distantPast
        var refreshing: Task<Void, Never>?
    }

    public static let lifetime: TimeInterval = 5 * 60

    private var caches: [String: Cache] = [:]
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

    /// suggestions.ts `getFileMentionSuggestions`, for an active word "@…".
    public func suggestions(_ activeWord: String, sessionId: String, fetch: @escaping Fetch) async -> [ComposerSuggestion] {
        await search(String(activeWord.dropFirst()), sessionId: sessionId, limit: 50, fetch: fetch).map(ComposerFiles.suggestion)
    }

    public func search(_ query: String, sessionId: String, limit: Int = 10, fetch: @escaping Fetch) async -> [ComposerFiles.Item] {
        await ensureValid(sessionId, fetch: fetch)
        guard let cache = caches[sessionId], let index = cache.index else { return [] }
        let items = cache.items
        // Off the actor: a large tree takes a moment to score.
        return await Task.detached {
            ComposerFiles.search(query, in: index, items: items, limit: limit)
        }.value
    }

    public func clear(sessionId: String? = nil) {
        if let sessionId {
            caches[sessionId] = nil
        } else {
            caches = [:]
        }
    }

    private func ensureValid(_ sessionId: String, fetch: @escaping Fetch) async {
        let cache = caches[sessionId, default: Cache()]
        if now().timeIntervalSince(cache.lastRefresh) <= Self.lifetime, !cache.items.isEmpty {
            return
        }
        // The lock: wait out a refresh in flight, then look again.
        while let refreshing = caches[sessionId]?.refreshing {
            await refreshing.value
        }
        if now().timeIntervalSince(caches[sessionId]?.lastRefresh ?? .distantPast) < 1 {
            return
        }
        let task = Task { await self.refresh(sessionId, fetch: fetch) }
        caches[sessionId, default: Cache()].refreshing = task
        await task.value
        caches[sessionId]?.refreshing = nil
    }

    private func refresh(_ sessionId: String, fetch: Fetch) async {
        guard let response = await fetch(sessionId), response.success,
              let stdout = response.stdout, !stdout.isEmpty else { return }
        let items = await Task.detached { ComposerFiles.items(ripgrepOutput: stdout) }.value
        let index = items.isEmpty ? nil : ComposerFiles.index(items)
        caches[sessionId, default: Cache()].items = items
        caches[sessionId]?.index = index
        caches[sessionId]?.lastRefresh = now()
    }
}
