import Foundation
@testable import HappyCore
import HappyWire
import XCTest

// Expected values are what Fuse.js 7.1.0 returns with suggestionCommands.ts's
// and suggestionFile.ts's options, for the same lists and queries.

final class ComposerCommandSearchTests: XCTestCase {
    private let metadata = try! JSONDecoder().decode(JSONValue.self, from: Data(#"""
    { "slashCommands": ["compact", "clear", "context", "cost", "init", "review", "pr-comments", "release-notes", "todos", "agents", "add-dir", "bashes", "hooks", "ide", "mcp", "memory", "model", "output-style", "permissions", "resume", "status", "statusline", "upgrade", "vim", "doctor", "export", "help", "login", "logout", "install-github-app", "migrate-installer", "security-review", "terminal-setup", "rewind", "usage", "plugin", "sandbox", "reset", "debug", "stop", "abort", "cancel"], "skills": ["frontend-design", "pdf", "release", "dev", "sessions", "control-flow", "clear"] }
    """#.utf8))

    private let commands: [(String, String?)] = [
        ("compact", "Compact the conversation history"),
        ("clear", "Clear the conversation"),
        ("goal", "Set a session goal"),
        ("mcp", "Show connected MCP servers"),
        ("skills", "Show available skills"),
        ("context", nil),
        ("todos", nil),
        ("output-style", nil),
        ("rewind", nil),
        ("usage", nil),
        ("plugin", nil),
        ("sandbox", nil),
        ("reset", "Reset the session"),
        ("debug", "Show debug information"),
        ("stop", "Stop current operation"),
        ("abort", "Abort current operation"),
        ("cancel", "Cancel current operation"),
        ("frontend-design", nil),
        ("pdf", nil),
        ("release", nil),
        ("dev", nil),
        ("sessions", nil),
        ("control-flow", nil),
    ]

    private let cases: [(query: String, commands: [String])] = [
        ("c", ["clear", "cancel", "compact", "mcp", "context", "control-flow", "stop", "abort"]),
        ("co", ["compact", "context", "control-flow", "clear", "mcp"]),
        ("com", ["compact"]),
        ("cmpact", ["compact"]),
        ("clr", []),
        ("ses", ["sessions", "reset", "goal"]),
        ("rel", ["release"]),
        ("goal", ["goal"]),
        ("skil", ["skills"]),
        ("xyz", []),
        ("mcp", ["mcp"]),
        ("con", ["context", "control-flow", "clear", "compact", "mcp"]),
        ("s", ["skills", "reset", "stop", "todos", "output-style", "usage", "sandbox", "frontend-design", "release", "sessions", "clear", "debug", "compact", "goal", "mcp"]),
        ("'comp", ["compact"]),
        ("^c", ["clear", "cancel", "compact", "context", "control-flow"]),
        ("act$", ["compact"]),
        ("=clear", ["clear"]),
        ("comp|rel", ["compact", "release"]),
        ("history", ["compact"]),
        ("conversation", ["clear", "compact"]),
        ("contxt", ["context"]),
        ("operation", ["stop", "abort", "cancel"]),
        ("show", ["skills", "debug", "mcp"]),
        ("Compact", ["compact"]),
        ("sess goal", ["goal"]),
        ("!c", ["skills", "reset", "debug", "goal", "todos", "output-style", "rewind", "usage", "plugin", "sandbox", "stop", "abort", "frontend-design", "pdf", "release", "dev", "sessions"]),
        ("cancel current", ["cancel"]),
        ("\"clear\"", ["clear"]),
        ("a", ["clear", "abort", "cancel", "compact", "goal", "usage", "sandbox", "release", "skills", "debug", "stop"]),
        ("the", ["clear", "reset", "compact"]),
        ("ab", ["abort", "skills"]),
        ("sandbx", ["sandbox"]),
    ]

    func testTheSessionsCommands() {
        let listed = ComposerCommands.commands(metadata: metadata)
        XCTAssertEqual(listed.map(\.command), commands.map(\.0))
        XCTAssertEqual(listed.map(\.description), commands.map(\.1))
    }

    func testWithoutMetadataTheDefaults() {
        XCTAssertEqual(ComposerCommands.commands(metadata: nil).map(\.command), ["compact", "clear", "goal", "mcp", "skills"])
    }

    func testFuseRanksTheSame() {
        for c in cases {
            XCTAssertEqual(ComposerCommands.search(c.query, metadata: metadata, limit: 50).map(\.command), c.commands, c.query)
        }
    }

    func testAnEmptyQueryListsThemAll() {
        XCTAssertEqual(ComposerCommands.search("", metadata: metadata, limit: 3).map(\.command), ["compact", "clear", "goal"])
        let suggestions = ComposerCommands.suggestions("/", metadata: nil)
        XCTAssertEqual(suggestions.map(\.text), ["/compact", "/clear", "/goal", "/mcp", "/skills"])
        XCTAssertEqual(suggestions.first?.key, "cmd-compact")
        XCTAssertEqual(suggestions.first?.kind, .command(name: "compact", description: "Compact the conversation history"))
    }
}

final class ComposerFileSearchTests: XCTestCase {
    private let paths: [String] = ["README.md", "package.json", "src/index.ts", "src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx", "src/components/MultiTextInput.tsx", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts", "src/sync/suggestionFile.ts", "src/sync/suggestionCommands.ts", "packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "packages/happy-ios/Package.swift", "docs/my notes.md", "docs/FEATURES.md", "a/b/c/d.txt", "Makefile", ".github/workflows/ci.yml"]

    private let files: [(String, String, String, Bool)] = [
        ("README.md", "", "README.md", false),
        ("package.json", "", "package.json", false),
        ("index.ts", "src/", "src/index.ts", false),
        ("AgentInput.tsx", "src/components/", "src/components/AgentInput.tsx", false),
        ("AgentInputAutocomplete.tsx", "src/components/", "src/components/AgentInputAutocomplete.tsx", false),
        ("MultiTextInput.tsx", "src/components/", "src/components/MultiTextInput.tsx", false),
        ("findActiveWord.ts", "src/components/autocomplete/", "src/components/autocomplete/findActiveWord.ts", false),
        ("applySuggestion.ts", "src/components/autocomplete/", "src/components/autocomplete/applySuggestion.ts", false),
        ("suggestionFile.ts", "src/sync/", "src/sync/suggestionFile.ts", false),
        ("suggestionCommands.ts", "src/sync/", "src/sync/suggestionCommands.ts", false),
        ("SessionComposerView.swift", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", false),
        ("ComposerModes.swift", "packages/happy-ios/Sources/HappyCore/Composer/", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", false),
        ("Package.swift", "packages/happy-ios/", "packages/happy-ios/Package.swift", false),
        ("my notes.md", "docs/", "docs/my notes.md", false),
        ("FEATURES.md", "docs/", "docs/FEATURES.md", false),
        ("d.txt", "a/b/c/", "a/b/c/d.txt", false),
        ("Makefile", "", "Makefile", false),
        ("ci.yml", ".github/workflows/", ".github/workflows/ci.yml", false),
        ("src/", "", "src/", true),
        ("components/", "src/", "src/components/", true),
        ("autocomplete/", "src/components/", "src/components/autocomplete/", true),
        ("sync/", "src/", "src/sync/", true),
        ("packages/", "", "packages/", true),
        ("happy-ios/", "packages/", "packages/happy-ios/", true),
        ("Sources/", "packages/happy-ios/", "packages/happy-ios/Sources/", true),
        ("HappyUI/", "packages/happy-ios/Sources/", "packages/happy-ios/Sources/HappyUI/", true),
        ("Composer/", "packages/happy-ios/Sources/HappyUI/", "packages/happy-ios/Sources/HappyUI/Composer/", true),
        ("HappyCore/", "packages/happy-ios/Sources/", "packages/happy-ios/Sources/HappyCore/", true),
        ("Composer/", "packages/happy-ios/Sources/HappyCore/", "packages/happy-ios/Sources/HappyCore/Composer/", true),
        ("docs/", "", "docs/", true),
        ("a/", "", "a/", true),
        ("b/", "a/", "a/b/", true),
        ("c/", "a/b/", "a/b/c/", true),
        (".github/", "", ".github/", true),
        ("workflows/", ".github/", ".github/workflows/", true),
    ]

    private let cases: [(query: String, paths: [String])] = [
        ("src", ["src/", "src/index.ts", "src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx", "src/components/MultiTextInput.tsx", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts", "src/sync/suggestionFile.ts", "src/sync/suggestionCommands.ts", "src/components/", "src/components/autocomplete/", "src/sync/"]),
        ("comp", ["src/components/AgentInputAutocomplete.tsx", "packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "src/components/", "src/components/autocomplete/", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyCore/Composer/", "src/components/AgentInput.tsx", "src/components/MultiTextInput.tsx", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts", "src/sync/suggestionCommands.ts"]),
        ("index", ["src/index.ts"]),
        ("readme", ["README.md"]),
        ("AgentInput", ["src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx", "src/components/MultiTextInput.tsx"]),
        ("agnt", ["src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx"]),
        ("sources/comp", ["packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "packages/happy-ios/Sources/HappyUI/", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyCore/", "packages/happy-ios/Sources/HappyCore/Composer/"]),
        ("tsx", ["src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx", "src/components/MultiTextInput.tsx"]),
        (".ts$", ["src/index.ts", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts", "src/sync/suggestionFile.ts", "src/sync/suggestionCommands.ts"]),
        ("^src", ["src/", "src/index.ts", "src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx", "src/components/MultiTextInput.tsx", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts", "src/sync/suggestionFile.ts", "src/sync/suggestionCommands.ts", "src/components/", "src/components/autocomplete/", "src/sync/"]),
        ("pakage", ["package.json", "packages/happy-ios/Package.swift", "packages/", "packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "packages/happy-ios/", "packages/happy-ios/Sources/", "packages/happy-ios/Sources/HappyUI/", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyCore/", "packages/happy-ios/Sources/HappyCore/Composer/"]),
        ("Composer.swift", ["packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift"]),
        ("packages/happy-ios/Sources/HappyUI/Composer", ["packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "packages/happy-ios/Sources/HappyCore/Composer/", "packages/happy-ios/Sources/HappyUI/", "packages/happy-ios/Sources/HappyCore/", "packages/happy-ios/Sources/"]),
        ("packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", ["packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "packages/happy-ios/Sources/HappyUI/", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyCore/", "packages/happy-ios/Sources/HappyCore/Composer/", "packages/happy-ios/Sources/"]),
        ("notes", ["docs/my notes.md"]),
        ("my notes", ["docs/my notes.md"]),
        ("auto", ["src/components/AgentInputAutocomplete.tsx", "src/components/autocomplete/", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts"]),
        ("sugestion", ["src/components/autocomplete/applySuggestion.ts", "src/sync/suggestionFile.ts", "src/sync/suggestionCommands.ts"]),
        ("FEATURES", ["docs/FEATURES.md"]),
        ("yml", [".github/workflows/ci.yml"]),
        ("d", ["README.md", "src/index.ts", "src/components/autocomplete/findActiveWord.ts", "src/sync/suggestionCommands.ts", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "docs/FEATURES.md", "a/b/c/d.txt", "docs/", "docs/my notes.md"]),
        ("a/b", ["a/b/c/d.txt", "a/b/", "a/b/c/"]),
        ("composer|auto", ["packages/happy-ios/Sources/HappyUI/Composer/SessionComposerView.swift", "packages/happy-ios/Sources/HappyCore/Composer/ComposerModes.swift", "packages/happy-ios/Sources/HappyUI/Composer/", "packages/happy-ios/Sources/HappyCore/Composer/", "src/components/AgentInputAutocomplete.tsx", "src/components/autocomplete/", "src/components/", "src/components/AgentInput.tsx", "src/components/MultiTextInput.tsx", "src/components/autocomplete/findActiveWord.ts", "src/components/autocomplete/applySuggestion.ts"]),
        ("'Input", ["src/components/AgentInput.tsx", "src/components/AgentInputAutocomplete.tsx", "src/components/MultiTextInput.tsx"]),
        (".github", [".github/", ".github/workflows/ci.yml", ".github/workflows/"]),
    ]

    func testRipgrepOutputBecomesFilesThenFolders() {
        let items = ComposerFiles.items(ripgrepOutput: paths.joined(separator: "\n") + "\n\n")
        XCTAssertEqual(items.map(\.fileName), files.map(\.0))
        XCTAssertEqual(items.map(\.filePath), files.map(\.1))
        XCTAssertEqual(items.map(\.fullPath), files.map(\.2))
        XCTAssertEqual(items.map(\.isFolder), files.map(\.3))
    }

    func testFuseRanksTheSame() {
        let items = ComposerFiles.items(ripgrepOutput: paths.joined(separator: "\n"))
        let index = ComposerFiles.index(items)
        for c in cases {
            XCTAssertEqual(ComposerFiles.search(c.query, in: index, items: items, limit: 50).map(\.fullPath), c.paths, c.query)
        }
        XCTAssertEqual(ComposerFiles.search("", in: index, items: items, limit: 2).map(\.fullPath), ["README.md", "package.json"])
    }
}

/// suggestionFile.ts's FileSearchCache.
final class ComposerFileIndexTests: XCTestCase {
    private actor Fetches {
        var count = 0
        var responses: [SessionRipgrepResponse]

        init(_ responses: [SessionRipgrepResponse]) {
            self.responses = responses
        }

        func next() -> SessionRipgrepResponse {
            count += 1
            return responses.count > 1 ? responses.removeFirst() : responses[0]
        }
    }

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 1_000)
        var now: Date { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
    }

    private static func files(_ stdout: String) -> SessionRipgrepResponse {
        SessionRipgrepResponse(success: true, exitCode: 0, stdout: stdout, stderr: nil, error: nil)
    }

    private static let failed = SessionRipgrepResponse(success: false, exitCode: nil, stdout: nil, stderr: nil, error: "offline")

    func testKeptFiveMinutes() async {
        let clock = Clock()
        let index = ComposerFileIndex(now: { clock.now })
        let fetches = Fetches([Self.files("a.ts\nsrc/b.ts\n"), Self.files("c.ts\n")])
        let fetch: ComposerFileIndex.Fetch = { _ in await fetches.next() }

        let first = await index.search("", sessionId: "s", fetch: fetch)
        XCTAssertEqual(first.map(\.fullPath), ["a.ts", "src/b.ts", "src/"])
        clock.advance(300)
        _ = await index.search("b", sessionId: "s", fetch: fetch)
        let count = await fetches.count
        XCTAssertEqual(count, 1, "still fresh at five minutes")
        clock.advance(1)
        let refreshed = await index.search("", sessionId: "s", fetch: fetch)
        XCTAssertEqual(refreshed.map(\.fullPath), ["c.ts"])
        let after = await fetches.count
        XCTAssertEqual(after, 2)
    }

    func testAFailedFetchKeepsWhatWasThereAndTriesAgain() async {
        let clock = Clock()
        let index = ComposerFileIndex(now: { clock.now })
        let fetches = Fetches([Self.files("a.ts\n"), Self.failed])
        let fetch: ComposerFileIndex.Fetch = { _ in await fetches.next() }

        _ = await index.search("", sessionId: "s", fetch: fetch)
        clock.advance(301)
        let kept = await index.search("", sessionId: "s", fetch: fetch)
        XCTAssertEqual(kept.map(\.fullPath), ["a.ts"])
        _ = await index.search("", sessionId: "s", fetch: fetch)
        let count = await fetches.count
        XCTAssertEqual(count, 3, "a stale cache asks every time until it gets an answer")
    }

    func testNothingFetchedIsNoSuggestions() async {
        let index = ComposerFileIndex()
        let empty = await index.suggestions("@", sessionId: "s") { _ in Self.files("") }
        XCTAssertEqual(empty, [])
        let other = ComposerFileIndex()
        let failed = await other.suggestions("@a", sessionId: "s") { _ in Self.failed }
        XCTAssertEqual(failed, [])
    }

    func testSuggestionsCarryTheMention() async {
        let index = ComposerFileIndex()
        let suggestions = await index.suggestions("@b", sessionId: "s") { _ in Self.files("src/b.ts\n") }
        XCTAssertEqual(suggestions.first, ComposerSuggestion(
            key: "file-src/b.ts", text: "@src/b.ts", kind: .file(name: "b.ts", path: "src/", isFolder: false)
        ))
    }

    func testSessionsAreSeparate() async {
        let index = ComposerFileIndex()
        let a = await index.search("", sessionId: "a") { _ in Self.files("a.ts\n") }
        let b = await index.search("", sessionId: "b") { _ in Self.files("b.ts\n") }
        XCTAssertEqual(a.map(\.fullPath), ["a.ts"])
        XCTAssertEqual(b.map(\.fullPath), ["b.ts"])
    }
}

/// useActiveSuggestions' selection, with clampSelection and autoSelectFirst.
final class SuggestionSelectionTests: XCTestCase {
    func testTheFirstRowIsPickedWhenAListAppears() {
        XCTAssertEqual(ComposerAutocomplete.selection(previous: -1, previousCount: 0, count: 3), 0)
        XCTAssertEqual(ComposerAutocomplete.selection(previous: 2, previousCount: 0, count: 3), 0)
    }

    func testTheSelectionHoldsOrClamps() {
        XCTAssertEqual(ComposerAutocomplete.selection(previous: 1, previousCount: 3, count: 5), 1)
        XCTAssertEqual(ComposerAutocomplete.selection(previous: 4, previousCount: 5, count: 2), 1)
        XCTAssertEqual(ComposerAutocomplete.selection(previous: -1, previousCount: 3, count: 2), 0)
        XCTAssertEqual(ComposerAutocomplete.selection(previous: 1, previousCount: 3, count: 0), -1)
    }
}
