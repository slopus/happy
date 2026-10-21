import Foundation
import XCTest
@testable import HappyCore
import HappyWire

// The Changes screen's support code against happy-app: utils/
// sessionFileLinks.test.ts (resolveSessionFilePath), gitDiffCommand.spec.ts,
// imageFiles.spec.ts, DiffFilesList.tsx's FileSection order and collapse,
// AllFilesDiffView.tsx's legacy fetch and items, and HappyAgentDiffView.tsx
// with useHappyAgentGitFiles.test.ts's queue rules.

final class SessionFileLinkTests: XCTestCase {
    let root = "/Users/kirilldubovitskiy/projects/happy"

    func testResolvesViewerInputToAnAbsolutePath() {
        XCTAssertEqual(SessionFileLink.resolve("packages/happy-app/README.md", sessionRoot: root), SessionFileLink(
            path: "packages/happy-app/README.md",
            absolutePath: "/Users/kirilldubovitskiy/projects/happy/packages/happy-app/README.md",
            relativePath: "packages/happy-app/README.md",
            withinSessionRoot: true,
            line: nil,
            column: nil
        ))
    }

    func testAbsoluteWithLineAndRelativeWithLineAndColumn() {
        XCTAssertEqual(SessionFileLink.resolve("/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts:594", sessionRoot: root), SessionFileLink(
            path: "/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts",
            absolutePath: "/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts",
            relativePath: "packages/happy-cli/src/codex/runCodex.ts",
            withinSessionRoot: true,
            line: 594,
            column: nil
        ))
        let relative = SessionFileLink.resolve("packages/happy-cli/src/codex/runCodex.ts:594:2", sessionRoot: root)
        XCTAssertEqual(relative?.absolutePath, "/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts")
        XCTAssertEqual(relative?.line, 594)
        XCTAssertEqual(relative?.column, 2)
    }

    func testOutsideTheRootHasNoRelativePath() {
        let path = "/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png"
        let link = SessionFileLink.resolve(path, sessionRoot: root)
        XCTAssertEqual(link?.absolutePath, path)
        XCTAssertNil(link?.relativePath)
        XCTAssertEqual(link?.withinSessionRoot, false)
        // A sibling that shares the root's prefix is not inside it.
        XCTAssertEqual(SessionFileLink.resolve("/Users/kirilldubovitskiy/projects/happy-other/a.ts", sessionRoot: root)?.withinSessionRoot, false)
    }

    func testNormalizesDotsSlashesHomeAndFileURLs() {
        XCTAssertEqual(SessionFileLink.resolve("./src/../lib//a.ts", sessionRoot: root)?.absolutePath, root + "/lib/a.ts")
        XCTAssertEqual(SessionFileLink.resolve("./src/../lib//a.ts", sessionRoot: root)?.path, "lib/a.ts")
        XCTAssertEqual(SessionFileLink.resolve("~/notes/todo.md", sessionRoot: root)?.absolutePath, "/Users/kirilldubovitskiy/notes/todo.md")
        XCTAssertEqual(SessionFileLink.resolve("file:///tmp/a%20b.txt", sessionRoot: root)?.absolutePath, "/tmp/a b.txt")
        XCTAssertEqual(SessionFileLink.resolve(root, sessionRoot: root)?.relativePath, ".")
        XCTAssertEqual(SessionFileLink.resolve("C:\\Users\\me\\repo\\src\\a.ts", sessionRoot: "C:/Users/me/repo")?.relativePath, "src/a.ts")
        XCTAssertEqual(SessionFileLink.normalizePath("/"), "/")
        XCTAssertEqual(SessionFileLink.normalizePath("../a/../../b"), "../../b")
    }

    func testNeedsARootForRelativePathsAndSomethingToResolve() {
        XCTAssertNil(SessionFileLink.resolve("src/a.ts", sessionRoot: nil))
        XCTAssertNil(SessionFileLink.resolve("   ", sessionRoot: root))
        XCTAssertEqual(SessionFileLink.resolve("/abs/a.ts", sessionRoot: nil)?.withinSessionRoot, false)
    }
}

final class GitDiffCommandTests: XCTestCase {
    func testQuotesPlainAndHostilePaths() {
        XCTAssertEqual(GitDiffCommand.quoteShellPath("src/app.ts"), "\"src/app.ts\"")
        XCTAssertEqual(GitDiffCommand.quoteShellPath("src/say \"hi\".ts"), "\"src/say \\\"hi\\\".ts\"")
        XCTAssertEqual(GitDiffCommand.quoteShellPath("src/back\\slash.ts"), "\"src/back\\\\slash.ts\"")
        XCTAssertEqual(GitDiffCommand.quoteShellPath("src/$HOME.ts"), "\"src/\\$HOME.ts\"")
        XCTAssertEqual(GitDiffCommand.quoteShellPath("src/`whoami`.ts"), "\"src/\\`whoami\\`.ts\"")
    }

    func testDiffFlags() {
        XCTAssertEqual(GitDiffCommand.diff("src/app.ts"), "git -c core.quotepath=false diff HEAD --no-ext-diff -- \"src/app.ts\"")
        XCTAssertTrue(GitDiffCommand.diff("src/app.ts", contextLines: 25).contains("-U25"))
        XCTAssertTrue(GitDiffCommand.diff("src/app.ts", contextLines: GitDiffCommand.fullFileContext).contains("-U100000"))
        XCTAssertTrue(GitDiffCommand.diff("src/app.ts", contextLines: 0).contains("-U0"))
        XCTAssertTrue(GitDiffCommand.diff("src/app.ts", ignoreWhitespace: true).contains(" -w "))
        XCTAssertFalse(GitDiffCommand.diff("src/app.ts", ignoreWhitespace: false).contains("-w"))
        let both = GitDiffCommand.diff("src/app.ts", contextLines: 10, ignoreWhitespace: true)
        XCTAssertTrue(both.contains("-U10"))
        XCTAssertTrue(both.contains("-w"))
        XCTAssertTrue(both.hasSuffix("-- \"src/app.ts\""))
    }

    func testShowsHeadThroughBase64() {
        XCTAssertEqual(GitDiffCommand.showBase64("assets/logo.png"), "git -c core.quotepath=false show HEAD:\"assets/logo.png\" | base64")
    }
}

final class ImageFilesTests: XCTestCase {
    func testMimeTypes() {
        XCTAssertEqual(ImageFiles.mimeType("assets/logo.png"), "image/png")
        XCTAssertEqual(ImageFiles.mimeType("a/b/photo.JPG"), "image/jpeg")
        XCTAssertEqual(ImageFiles.mimeType("anim.gif"), "image/gif")
        XCTAssertEqual(ImageFiles.mimeType("hero.webp"), "image/webp")
        XCTAssertNil(ImageFiles.mimeType("icons/close.svg"))
        XCTAssertNil(ImageFiles.mimeType("Makefile"))
        XCTAssertNil(ImageFiles.mimeType("src/png"))
        XCTAssertNil(ImageFiles.mimeType("archive.png.bak"))
        XCTAssertTrue(ImageFiles.isImage("a.png"))
        XCTAssertFalse(ImageFiles.isImage("a.ts"))
    }

    func testDecodesShellWrappedBase64AndRefusesNothing() {
        XCTAssertEqual(ImageFiles.data("logo.png", base64: "AAAA"), Data([0, 0, 0]))
        XCTAssertEqual(ImageFiles.data("logo.png", base64: "AAAA\nBBBB\n"), Data([0, 0, 0, 4, 16, 65]))
        XCTAssertNil(ImageFiles.data("logo.png", base64: ""))
        XCTAssertNil(ImageFiles.data("logo.png", base64: "\n  \n"))
        XCTAssertNil(ImageFiles.data("notes.txt", base64: "AAAA"))
    }

    func testDataURIs() {
        XCTAssertEqual(ImageFiles.data(dataURI: "data:image/png;base64,AAAA"), Data([0, 0, 0]))
        XCTAssertNil(ImageFiles.data(dataURI: "data:image/png,AAAA"))
        XCTAssertNil(ImageFiles.data(dataURI: "AAAA"))
    }
}

final class DiffFileItemTests: XCTestCase {
    private let cache = DiffDocumentCache()
    let patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"

    func testBodyFollowsFileSectionOrder() {
        var item = DiffFileItem(path: "a.ts", kind: .modified, additions: 1, deletions: 1, source: .patch(patch), error: "boom", message: "msg")
        XCTAssertEqual(item.body(DiffFileItem.document(item.source, cache: cache)), .error("boom"))
        item.error = nil
        XCTAssertEqual(item.body(DiffFileItem.document(item.source, cache: cache)), .message("msg"))
        item.message = nil
        item.image = DiffFileItem.Image(before: nil, after: Data([1]))
        XCTAssertEqual(item.body(.empty), .image(DiffFileItem.Image(before: nil, after: Data([1]))))
        item.image = nil
        guard case .files(let files) = item.body(DiffFileItem.document(item.source, cache: cache)) else { return XCTFail("expected files") }
        XCTAssertEqual(files.count, 1)
        item.source = nil
        XCTAssertEqual(item.body(.empty), .loading)
    }

    func testContentsWithoutTextRowsSayNoChanges() {
        let same = DiffFileItem(path: "a.ts", kind: .modified, additions: 0, deletions: 0, source: .contents(path: "a.ts", oldText: "x\n", newText: "x\n"))
        XCTAssertEqual(same.body(DiffFileItem.document(same.source, cache: cache)), .noChanges)
        let empty = DiffFileItem(path: "a.ts", kind: .modified, additions: 0, deletions: 0, source: .patch(""))
        XCTAssertEqual(empty.body(DiffFileItem.document(empty.source, cache: cache)), .noChanges)
    }

    func testBudgetErrorsAreShown() {
        let old = (0..<400).map { "a\($0)" }.joined(separator: "\n")
        let new = (0..<400).map { "b\($0)" }.joined(separator: "\n")
        let item = DiffFileItem(path: "a.ts", kind: .modified, additions: 0, deletions: 0, source: .contents(
            path: "a.ts", oldText: old, newText: new, budget: DiffEngine.Budget(timeoutMs: 10_000, maxEditLength: 10)
        ))
        XCTAssertEqual(item.body(DiffFileItem.document(item.source, cache: cache)), .error(DiffEngine.tooLargeError))
    }

    func testCollapseRules() {
        let small = DiffFileItem(path: "a", kind: .modified, additions: 1000, deletions: 1000)
        let big = DiffFileItem(path: "b", kind: .modified, additions: 1500, deletions: 501)
        XCTAssertFalse(DiffFilesCollapse.isCollapsed(small, override: nil, defaultCollapsed: false))
        XCTAssertTrue(DiffFilesCollapse.isCollapsed(small, override: nil, defaultCollapsed: true))
        XCTAssertTrue(DiffFilesCollapse.isCollapsed(big, override: nil, defaultCollapsed: false))
        XCTAssertFalse(DiffFilesCollapse.isCollapsed(big, override: false, defaultCollapsed: true))
        XCTAssertTrue(DiffFilesCollapse.showsSizeHint(big, collapsed: true))
        XCTAssertFalse(DiffFilesCollapse.showsSizeHint(small, collapsed: true))
        XCTAssertFalse(DiffFilesCollapse.showsSizeHint(big, collapsed: false))
    }

    func testNeedsContentOnlyWhenOpenAndBodiless() {
        var item = DiffFileItem(path: "a", kind: .modified, additions: 0, deletions: 0)
        XCTAssertTrue(DiffFilesCollapse.needsContent(item, collapsed: false))
        XCTAssertFalse(DiffFilesCollapse.needsContent(item, collapsed: true))
        item.error = "x"
        XCTAssertFalse(DiffFilesCollapse.needsContent(item, collapsed: false))
        item.error = nil
        item.message = "m"
        XCTAssertFalse(DiffFilesCollapse.needsContent(item, collapsed: false))
        item.message = nil
        item.source = .patch("")
        XCTAssertFalse(DiffFilesCollapse.needsContent(item, collapsed: false))
    }
}

final class LegacyChangesTests: XCTestCase {
    let root = "/Users/me/repo"

    func file(_ path: String, _ status: GitFileStatus.Status = .modified, staged: Bool = false, added: Int = 1, removed: Int = 1) -> GitFileStatus {
        GitFileStatus(fileName: String(path.split(separator: "/").last ?? ""), filePath: "", fullPath: path, status: status, isStaged: staged, linesAdded: added, linesRemoved: removed, oldPath: nil)
    }

    func testFilesAreDedupedStagedFirstAndSorted() {
        var status = GitStatus()
        status.stagedFiles = [file("b.ts", staged: true, added: 9)]
        status.unstagedFiles = [file("c.ts"), file("b.ts", added: 2), file("a.ts")]
        let files = LegacyChanges.files(status)
        XCTAssertEqual(files.map(\.fullPath), ["a.ts", "b.ts", "c.ts"])
        XCTAssertEqual(files[1].linesAdded, 9)
        XCTAssertEqual(LegacyChanges.files(nil), [])
    }

    func testCountLines() {
        XCTAssertEqual(LegacyChanges.countLines(""), 0)
        XCTAssertEqual(LegacyChanges.countLines("a"), 1)
        XCTAssertEqual(LegacyChanges.countLines("a\n"), 1)
        XCTAssertEqual(LegacyChanges.countLines("a\nb"), 2)
        XCTAssertEqual(LegacyChanges.countLines("\n\n"), 2)
    }

    func testItemsRecountFromContent() {
        let files = [file("a.ts"), file("new.ts", .untracked, added: 0, removed: 0), file("gone.png", .deleted, added: 3, removed: 4), file("wait.ts", added: 5, removed: 6)]
        let results: [String: LegacyChanges.Result] = [
            "a.ts": .init(file: files[0], content: .patch("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-x\n+y\n+z\n ctx\n"), error: nil),
            "new.ts": .init(file: files[1], content: .newFile("one\ntwo\n"), error: nil),
            "gone.png": .init(file: files[2], content: .image(before: Data([1]), after: nil), error: nil),
        ]
        let items = LegacyChanges.items(files, results: results)
        XCTAssertEqual(items.map(\.kind), [.modified, .added, .deleted, .modified])
        XCTAssertEqual(items.map(\.additions), [2, 2, 3, 5])
        XCTAssertEqual(items.map(\.deletions), [1, 0, 4, 6])
        XCTAssertEqual(items[1].source, .contents(path: "new.ts", oldText: "", newText: "one\ntwo\n"))
        XCTAssertEqual(items[2].image, DiffFileItem.Image(before: Data([1]), after: nil))
        XCTAssertNil(items[2].source)
        XCTAssertNil(items[3].source)
    }

    func testStateReconcilesBySignature() {
        var state = LegacyChanges.State()
        let a = file("a.ts"), b = file("b.ts")
        XCTAssertEqual(state.reconcile([a, b], expanded: [], ignoreWhitespace: false), [a, b])
        XCTAssertTrue(state.isLoading(fileCount: 2))
        // In flight: not asked again.
        XCTAssertEqual(state.reconcile([a, b], expanded: [], ignoreWhitespace: false), [])
        state.receive([LegacyChanges.Result(file: a, content: .patch(""), error: nil), LegacyChanges.Result(file: b, content: nil, error: "x")])
        XCTAssertFalse(state.isLoading(fileCount: 2))
        XCTAssertEqual(state.reconcile([a, b], expanded: [], ignoreWhitespace: false), [])
        // Expanding one file, or changing its counts, fetches just that one.
        XCTAssertEqual(state.reconcile([a, b], expanded: ["a.ts"], ignoreWhitespace: false), [a])
        let b2 = file("b.ts", added: 7)
        XCTAssertEqual(state.reconcile([a, b2], expanded: ["a.ts"], ignoreWhitespace: false), [b2])
        // Whitespace refetches everything not in flight.
        state.receive([LegacyChanges.Result(file: a, content: .patch("p"), error: nil), LegacyChanges.Result(file: b2, content: nil, error: nil)])
        XCTAssertEqual(state.reconcile([a, b2], expanded: ["a.ts"], ignoreWhitespace: true), [a, b2])
        // A dropped file's results go, and a late reply for it is ignored.
        XCTAssertEqual(state.reconcile([a], expanded: ["a.ts"], ignoreWhitespace: true), [])
        state.receive([LegacyChanges.Result(file: b2, content: .patch("late"), error: nil)])
        XCTAssertNil(state.results["b.ts"])
        XCTAssertEqual(Set(state.results.keys), ["a.ts"])
        XCTAssertEqual(state.reconcile([], expanded: [], ignoreWhitespace: false), [])
        XCTAssertTrue(state.results.isEmpty)
    }

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []
        func add(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return values }
    }

    func transport(_ calls: Calls, bash: @escaping @Sendable (String) -> SessionBashResponse, read: @escaping @Sendable (String) -> SessionReadFileResponse) -> LegacyChanges.Transport {
        LegacyChanges.Transport(
            bash: { request in
                calls.add("bash \(request.command) cwd=\(request.cwd ?? "-") t=\(request.timeout ?? 0)")
                return bash(request.command)
            },
            readFile: { path in
                calls.add("read \(path)")
                return read(path)
            }
        )
    }

    static func ok(_ stdout: String) -> SessionBashResponse {
        SessionBashResponse(success: true, stdout: stdout, stderr: "", exitCode: 0, error: nil)
    }

    func testFetchesPatchesWithTheRightCommand() async {
        let calls = Calls()
        let t = transport(calls, bash: { _ in Self.ok("PATCH") }, read: { _ in SessionReadFileResponse(success: false, content: nil, error: nil) })
        let result = await LegacyChanges.fetch(file("\(root)/src/a b.ts"), sessionPath: root, expanded: true, ignoreWhitespace: true, transport: t)
        XCTAssertEqual(result.content, .patch("PATCH"))
        XCTAssertEqual(calls.all, ["bash git -c core.quotepath=false diff HEAD --no-ext-diff -U100000 -w -- \"src/a b.ts\" cwd=\(root) t=5000"])
    }

    func testFetchErrors() async {
        let calls = Calls()
        let failing = transport(calls, bash: { _ in SessionBashResponse(success: false, stdout: "", stderr: "", exitCode: 1, error: "") }, read: { _ in SessionReadFileResponse(success: false, content: nil, error: "denied") })
        var result = await LegacyChanges.fetch(file("a.ts"), sessionPath: nil, expanded: false, ignoreWhitespace: false, transport: failing)
        XCTAssertEqual(result.error, "No session path")
        result = await LegacyChanges.fetch(file("/etc/passwd"), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: failing)
        XCTAssertEqual(result.error, "File is outside the session root.")
        result = await LegacyChanges.fetch(file("a.ts"), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: failing)
        XCTAssertEqual(result.error, "Failed to fetch diff")
        result = await LegacyChanges.fetch(file("new.ts", .untracked), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: failing)
        XCTAssertEqual(result.error, "denied")
        XCTAssertTrue(calls.all.contains("read \(root)/new.ts"))
    }

    func testUntrackedFilesAreReadAndDecoded() async {
        let calls = Calls()
        let text = "\u{FEFF}héllo\n"
        let t = transport(calls, bash: { _ in Self.ok("") }, read: { _ in
            SessionReadFileResponse(success: true, content: Data(text.utf8).base64EncodedString().replacingOccurrences(of: "=", with: ""), error: nil)
        })
        let result = await LegacyChanges.fetch(file("new.ts", .untracked), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: t)
        XCTAssertEqual(result.content, .newFile("héllo\n"))
        XCTAssertNil(LegacyChanges.decodeText("A"))
    }

    func testImagesReadBothSides() async {
        let calls = Calls()
        let t = transport(calls, bash: { _ in Self.ok("AAAA\nAAAA\n") }, read: { _ in SessionReadFileResponse(success: true, content: "AQID", error: nil) })
        let modified = await LegacyChanges.fetch(file("img/logo.png"), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: t)
        XCTAssertEqual(modified.content, .image(before: Data(repeating: 0, count: 6), after: Data([1, 2, 3])))
        XCTAssertTrue(calls.all.contains("bash git -c core.quotepath=false show HEAD:\"img/logo.png\" | base64 cwd=\(root) t=8000"))
        XCTAssertTrue(calls.all.contains("read \(root)/img/logo.png"))

        let added = await LegacyChanges.fetch(file("new.png", .untracked), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: t)
        XCTAssertEqual(added.content, .image(before: nil, after: Data([1, 2, 3])))
        let deleted = await LegacyChanges.fetch(file("old.png", .deleted), sessionPath: root, expanded: false, ignoreWhitespace: false, transport: t)
        XCTAssertEqual(deleted.content, .image(before: Data(repeating: 0, count: 6), after: nil))
    }
}

final class HappyAgentChangesTests: XCTestCase {
    private let cache = DiffDocumentCache()
    let base = String(repeating: "a", count: 40)

    func gitFile(_ path: String, _ status: String = "modified", insertions: Int? = 2, deletions: Int? = nil) throws -> HappyAgentGitFile {
        var object: [String: JSONValue] = ["path": .string(path), "status": .string(status), "staged": .bool(false), "unstaged": .bool(true), "binary": .bool(false)]
        if let insertions { object["insertions"] = .number(Double(insertions)) }
        if let deletions { object["deletions"] = .number(Double(deletions)) }
        return try HappyAgentGitFile(.object(object))
    }

    func gitState(files: [HappyAgentGitFile], changed: Int, exact: Bool = true, truncated: Bool = false, conflicted: Bool = false, comparison: String = "ready") throws -> HappyAgentGitState {
        try HappyAgentGitState(.object([
            "facts": .object(["branch": .string("main"), "detached": .bool(false), "head": .string(base), "upstream": .null, "ahead": .number(0), "behind": .number(0)]),
            "comparison": .string(comparison), "base": comparison == "ready" ? .string(base) : .null,
            "changedFiles": .number(Double(changed)), "insertions": .number(0), "deletions": .number(0),
            "countsExact": .bool(exact), "conflicted": .bool(conflicted), "files": .array(files.map(\.raw)),
            "filesTruncated": .bool(truncated), "scannedAt": .number(1),
        ]))
    }

    func testNoticesBaseAndCleanliness() throws {
        let files = [try gitFile("a.ts")]
        let busy = try gitState(files: files, changed: 3, exact: false, truncated: true, conflicted: true)
        XCTAssertEqual(HappyAgentChanges.notices(busy), [
            "Showing 1 of 3 changed files. Open the workspace on your computer to see the full list.",
            "Change counts are approximate for this workspace.",
            "This workspace has unresolved merge conflicts.",
        ])
        XCTAssertFalse(HappyAgentChanges.isClean(busy))
        XCTAssertEqual(HappyAgentChanges.base(busy), base)
        let clean = try gitState(files: [], changed: 0)
        XCTAssertEqual(HappyAgentChanges.notices(clean), [])
        XCTAssertTrue(HappyAgentChanges.isClean(clean))
        XCTAssertNil(HappyAgentChanges.base(try gitState(files: [], changed: 0, comparison: "unavailable")))
    }

    func testItems() throws {
        let files = [
            try gitFile("a.ts", deletions: 1), try gitFile("b.ts", "untracked", insertions: nil),
            try gitFile("c.png", "renamed"), try gitFile("d.ts", "deleted"), try gitFile("e.ts", "copied"),
            try gitFile("f.ts", "conflicted"), try gitFile("same.ts"), try gitFile("empty.ts"),
        ]
        let results: [String: HappyAgentChanges.FileResult] = [
            "a.ts": .content(.text(oldText: "x\n", newText: "y\n")),
            "b.ts": .error("too big"),
            "c.png": .content(.image(before: "data:image/png;base64,AQID", after: nil)),
            "f.ts": .content(.message("conflicts")),
            "same.ts": .content(.text(oldText: "z", newText: "z")),
            "empty.ts": .content(.text(oldText: "", newText: "")),
        ]
        let items = HappyAgentChanges.items(files, results: results, expandedContext: ["a.ts"], ignoreWhitespace: true, matchText: "MATCH", emptyText: "EMPTY")
        XCTAssertEqual(items.map(\.kind), [.modified, .added, .renamed, .deleted, .added, .modified, .modified, .modified])
        XCTAssertEqual(items[0].additions, 2)
        XCTAssertEqual(items[0].deletions, 1)
        XCTAssertEqual(items[1].additions, 0)
        XCTAssertEqual(items[0].source, .contents(path: "a.ts", oldText: "x\n", newText: "y\n", contextLines: GitDiffCommand.fullFileContext, ignoreWhitespace: true, budget: HappyAgentChanges.diffBudget))
        XCTAssertEqual(items[1].error, "too big")
        XCTAssertEqual(items[2].image, DiffFileItem.Image(before: Data([1, 2, 3]), after: nil))
        XCTAssertNil(items[3].source)
        XCTAssertEqual(items[5].message, "conflicts")
        XCTAssertEqual(items[6].message, "MATCH")
        XCTAssertEqual(items[7].message, "EMPTY")
        XCTAssertEqual(items[6].body(DiffFileItem.document(items[6].source, cache: cache)), .message("MATCH"))
    }

    func testQueueReadsOnDemandTwoAtATimeAndNeverRetries() throws {
        var queue = HappyAgentChanges.FileQueue(files: [try gitFile("a.ts"), try gitFile("b.ts"), try gitFile("c.ts")])
        XCTAssertEqual(queue.start(), [])
        for path in ["a.ts", "a.ts", "b.ts", "c.ts", "outside.ts"] { queue.request(path) }
        XCTAssertEqual(queue.start(), ["a.ts", "b.ts"])
        XCTAssertEqual(queue.start(), [])
        queue.finish("a.ts", .error("File is too large"))
        XCTAssertEqual(queue.start(), ["c.ts"])
        queue.request("a.ts")
        queue.finish("b.ts", .content(.message("m")))
        queue.finish("c.ts", .content(.message("m")))
        XCTAssertEqual(queue.start(), [])
        XCTAssertEqual(queue.results.count, 3)
        XCTAssertEqual(queue.results["a.ts"], .error("File is too large"))
        // A reply nobody asked for changes nothing.
        queue.finish("zzz", .error("x"))
        XCTAssertEqual(queue.results.count, 3)
    }
}
