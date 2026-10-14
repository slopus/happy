import Foundation
import XCTest
@testable import HappyCore
import HappyWire

// The diff engine against happy-app's components/diff/engine: jsdiff's and
// the engine's own answers (scripts/generate-diff-vectors.mjs), then the
// engine specs (buildDiff.spec.ts, lru.spec.ts, splitRows.spec.ts,
// layout.spec.ts's selectVisibleRows, useProgressiveRows.spec.ts) case by
// case.

private func fixture(_ name: String) throws -> [JSONValue] {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    let root = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    return try XCTUnwrap(root["cases"]?.arrayValue)
}

private extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    var intValue: Int? {
        if case .number(let value) = self { return Int(value) }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}

private func number(_ value: Int) -> JSONValue { .number(Double(value)) }

/// The engine's output as the JavaScript engine's JSON.stringify writes it:
/// undefined fields left out.
private func json(_ document: DiffDocument) -> JSONValue {
    var object: [String: JSONValue] = [
        "files": .array(document.files.map(json)),
        "additions": number(document.additions),
        "deletions": number(document.deletions),
    ]
    if let error = document.error { object["error"] = .string(error) }
    return .object(object)
}

private func json(_ file: DiffFile) -> JSONValue {
    var object: [String: JSONValue] = [
        "path": .string(file.path),
        "kind": .string(file.kind.rawValue),
        "language": file.language.map(JSONValue.string) ?? .null,
        "additions": number(file.additions),
        "deletions": number(file.deletions),
        "rows": .array(file.rows.map(json)),
        "maxColumns": number(file.maxColumns),
        "maxLineNo": number(file.maxLineNo),
    ]
    if let oldPath = file.oldPath { object["oldPath"] = .string(oldPath) }
    return .object(object)
}

private func json(_ row: DiffRow) -> JSONValue {
    switch row {
    case .line(let line):
        var object: [String: JSONValue] = [
            "kind": "line", "key": .string(line.key), "type": .string(line.type.rawValue), "text": .string(line.text),
            "spans": .array(line.spans.map { .object(["t": .string($0.text), "k": .string($0.kind.rawValue), "e": number(Int($0.emphasis.rawValue))]) }),
        ]
        if let oldNo = line.oldNo { object["oldNo"] = number(oldNo) }
        if let newNo = line.newNo { object["newNo"] = number(newNo) }
        return .object(object)
    case .hunk(let hunk):
        var object: [String: JSONValue] = ["kind": "hunk", "key": .string(hunk.key), "text": .string(hunk.text), "section": .string(hunk.section)]
        if let hidden = hunk.hidden { object["hidden"] = number(hidden) }
        return .object(object)
    case .message(let key, let code):
        return .object(["kind": "message", "key": .string(key), "code": .string(code.rawValue)])
    }
}

private func json(_ file: DiffPatchParser.RawFile) -> JSONValue {
    var object: [String: JSONValue] = [
        "path": .string(file.path),
        "kind": .string(file.kind.rawValue),
        "hunks": .array(file.hunks.map { hunk in
            .object([
                "oldStart": number(hunk.oldStart), "oldLines": number(hunk.oldLines),
                "newStart": number(hunk.newStart), "newLines": number(hunk.newLines),
                "section": .string(hunk.section),
                "lines": .array(hunk.lines.map { line in
                    var object: [String: JSONValue] = ["type": .string(line.type.rawValue), "text": .string(line.text)]
                    if let oldNo = line.oldNo { object["oldNo"] = number(oldNo) }
                    if let newNo = line.newNo { object["newNo"] = number(newNo) }
                    return .object(object)
                }),
            ])
        }),
    ]
    if let oldPath = file.oldPath { object["oldPath"] = .string(oldPath) }
    return .object(object)
}

private func options(_ value: JSONValue?) -> DiffEngine.Options {
    var options = DiffEngine.Options()
    if let context = value?["contextLines"]?.intValue { options.contextLines = context }
    if let ignore = value?["ignoreWhitespace"]?.boolValue { options.ignoreWhitespace = ignore }
    if let intraline = value?["intraline"]?.boolValue { options.intraline = intraline }
    if let width = value?["tabWidth"]?.intValue { options.tabWidth = width }
    if let max = value?["maxHighlightLines"]?.intValue { options.maxHighlightLines = max }
    if let budget = value?["diffBudget"], case .number(let timeout) = budget["timeoutMs"], let edits = budget["maxEditLength"]?.intValue {
        options.budget = DiffEngine.Budget(timeoutMs: timeout, maxEditLength: edits)
    }
    return options
}

final class MyersDiffVectorTests: XCTestCase {
    /// Every case jsdiff 8.0.3 answered, with the same runs, counts and
    /// values, byte for byte.
    func testMatchesJSDiff() throws {
        let cases = try fixture("jsdiff-vectors")
        XCTAssertGreaterThan(cases.count, 300)
        for (index, item) in cases.enumerated() {
            let expected = item["expected"]
            let actual: JSONValue
            switch item["kind"]?.stringValue {
            case "words":
                let old = try XCTUnwrap(item["old"]?.stringValue)
                let new = try XCTUnwrap(item["new"]?.stringValue)
                actual = .array(MyersDiff.diffWordsWithSpace(old, new).map(change))
            case "lines":
                let old = try XCTUnwrap(item["old"]?.stringValue)
                let new = try XCTUnwrap(item["new"]?.stringValue)
                let budget = MyersDiff.Budget(maxEditLength: item["maxEditLength"]?.intValue)
                actual = MyersDiff.diffLines(old, new, budget: budget).map { .array($0.map(change)) } ?? .null
            case "arrays":
                let old = try XCTUnwrap(item["old"]?.arrayValue).compactMap(\.stringValue)
                let new = try XCTUnwrap(item["new"]?.arrayValue).compactMap(\.stringValue)
                actual = MyersDiff.diffArrays(old, new, key: DiffPatchParser.stripWhitespace).map { changes in
                    .array(changes.map { .object(["value": .array($0.value.map(JSONValue.string)), "count": number($0.count), "added": .bool($0.added), "removed": .bool($0.removed)]) })
                } ?? .null
            default:
                XCTFail("case \(index): unknown kind")
                continue
            }
            XCTAssertEqual(actual, expected, "case \(index): \(item["kind"]?.stringValue ?? "")")
        }
    }

    private func change(_ change: MyersDiff.Change<String>) -> JSONValue {
        .object(["value": .string(change.value), "count": number(change.count), "added": .bool(change.added), "removed": .bool(change.removed)])
    }

    func testTokenizers() {
        XCTAssertEqual(MyersDiff.lineTokens("a\nb\r\nc"), ["a\n", "b\r\n", "c"])
        XCTAssertEqual(MyersDiff.lineTokens("a\n"), ["a\n"])
        XCTAssertEqual(MyersDiff.lineTokens(""), [])
        XCTAssertEqual(MyersDiff.wordTokens("let café = 😀;\r\n\tx\ry"), ["let", " ", "café", " ", "=", " ", "😀", ";", "\r\n", "\t", "x", "\r", "y"])
    }

    func testBudgetGivesUp() {
        XCTAssertNil(MyersDiff.diffLines("a\nb\n", "c\nd\n", budget: .init(maxEditLength: 1)))
        // Identical input needs no edits, whatever the budget.
        XCTAssertEqual(MyersDiff.diffLines("a\n", "a\n", budget: .init(maxEditLength: 0))?.count, 1)
    }
}

final class DiffEngineVectorTests: XCTestCase {
    /// Everything happy-app's engine made of the generated patches and blob
    /// pairs: parsed files, documents with every row and span, the stats.
    func testMatchesHappyAppsEngine() throws {
        let cases = try fixture("diff-engine-vectors")
        XCTAssertGreaterThan(cases.count, 300)
        for (index, item) in cases.enumerated() {
            let expected = try XCTUnwrap(item["expected"])
            let kind = item["kind"]?.stringValue ?? ""
            switch kind {
            case "parse":
                let patch = try XCTUnwrap(item["patch"]?.stringValue)
                XCTAssertEqual(.array(DiffPatchParser.parse(patch).map(json)), expected, "case \(index) parse: \(patch.prefix(80))")
            case "patch":
                let patch = try XCTUnwrap(item["patch"]?.stringValue)
                XCTAssertEqual(json(DiffEngine.build(patch: patch, options: options(item["options"]))), expected, "case \(index) patch: \(patch.prefix(80))")
            case "contents":
                let document = DiffEngine.build(
                    path: try XCTUnwrap(item["path"]?.stringValue),
                    oldText: try XCTUnwrap(item["oldText"]?.stringValue),
                    newText: try XCTUnwrap(item["newText"]?.stringValue),
                    options: options(item["options"])
                )
                XCTAssertEqual(json(document), expected, "case \(index) contents")
            case "stats":
                let counts = DiffStats.countPatch(try XCTUnwrap(item["patch"]?.stringValue))
                XCTAssertEqual(JSONValue.object(["additions": number(counts.additions), "deletions": number(counts.deletions)]), expected, "case \(index) stats")
            case "contentStats":
                let counts = DiffStats.countContents(try XCTUnwrap(item["oldText"]?.stringValue), try XCTUnwrap(item["newText"]?.stringValue))
                XCTAssertEqual(JSONValue.object(["additions": number(counts.additions), "deletions": number(counts.deletions)]), expected, "case \(index) contentStats")
            default:
                XCTFail("case \(index): unknown kind \(kind)")
            }
        }
    }
}

private func lineRows(_ rows: [DiffRow]) -> [DiffLine] {
    rows.compactMap(\.line)
}

private func textOf(_ line: DiffLine) -> String {
    line.spans.map(\.text).joined()
}

/// engine/buildDiff.spec.ts.
final class DiffParsePatchTests: XCTestCase {
    func testPlainModification() throws {
        let files = DiffPatchParser.parse([
            "diff --git a/src/app.ts b/src/app.ts",
            "index 1111111..2222222 100644",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1,4 +1,4 @@ function main()",
            " const a = 1;",
            "-const b = 2;",
            "+const b = 3;",
            " const c = 4;",
        ].joined(separator: "\n"))
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].path, "src/app.ts")
        XCTAssertEqual(files[0].kind, .modified)
        XCTAssertEqual(files[0].hunks[0].section, "function main()")
        XCTAssertEqual(files[0].hunks[0].lines.map(\.type), [.ctx, .del, .add, .ctx])
        XCTAssertEqual(files[0].hunks[0].lines[1].oldNo, 2)
        XCTAssertEqual(files[0].hunks[0].lines[2].newNo, 2)
    }

    func testAddedDeletedAndRenamed() {
        let added = DiffPatchParser.parse(["diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,1 @@", "+hello"].joined(separator: "\n"))
        XCTAssertEqual(added[0].kind, .added)
        XCTAssertEqual(added[0].path, "new.txt")

        let deleted = DiffPatchParser.parse(["diff --git a/old.txt b/old.txt", "deleted file mode 100644", "--- a/old.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye"].joined(separator: "\n"))
        XCTAssertEqual(deleted[0].kind, .deleted)
        XCTAssertEqual(deleted[0].path, "old.txt")

        let renamed = DiffPatchParser.parse(["diff --git a/a.txt b/b.txt", "similarity index 90%", "rename from a.txt", "rename to b.txt", "@@ -1 +1 @@", "-one", "+two"].joined(separator: "\n"))
        XCTAssertEqual(renamed[0].kind, .renamed)
        XCTAssertEqual(renamed[0].path, "b.txt")
        XCTAssertEqual(renamed[0].oldPath, "a.txt")
    }

    func testMultipleFiles() {
        let files = DiffPatchParser.parse([
            "diff --git a/one.ts b/one.ts", "--- a/one.ts", "+++ b/one.ts", "@@ -1 +1 @@", "-a", "+b",
            "diff --git a/two.ts b/two.ts", "--- a/two.ts", "+++ b/two.ts", "@@ -1 +1 @@", "-c", "+d",
        ].joined(separator: "\n"))
        XCTAssertEqual(files.map(\.path), ["one.ts", "two.ts"])
    }

    func testNoNewlineMarkerAndBlankContext() {
        let lines = DiffPatchParser.parse(["--- a/x.txt", "+++ b/x.txt", "@@ -1,3 +1,3 @@", " one", "", "-two", "\\ No newline at end of file", "+three"].joined(separator: "\n"))[0].hunks[0].lines
        XCTAssertEqual(lines.map(\.type), [.ctx, .ctx, .del, .add])
        XCTAssertEqual(lines[1].text, "")
    }

    func testQuotedPaths() {
        let files = DiffPatchParser.parse(["--- \"a/some dir/\\303\\251.ts\"", "+++ \"b/some dir/\\303\\251.ts\"", "@@ -1 +1 @@", "-a", "+b"].joined(separator: "\n"))
        XCTAssertTrue(files[0].path.contains("some dir/"))
    }

    func testHunkHeaders() {
        XCTAssertEqual(DiffPatchParser.hunkHeader("@@ -1 +1 @@"), .init(oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: ""))
        XCTAssertEqual(DiffPatchParser.hunkHeader("@@@ -10,2 +12,0 @@@ fn x"), .init(oldStart: 10, oldLines: 2, newStart: 12, newLines: 0, section: "fn x"))
        XCTAssertEqual(DiffPatchParser.hunkHeader("@@ -1 +1 @@section"), .init(oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: "section"))
        // `.` stops at line terminators and `$` only matches at the end.
        XCTAssertNil(DiffPatchParser.hunkHeader("@@ -1 +1 @@\r"))
        XCTAssertNil(DiffPatchParser.hunkHeader("@@ malformed @@"))
        XCTAssertNil(DiffPatchParser.hunkHeader("@ -1 +1 @@"))
    }
}

final class DiffIntralineTests: XCTestCase {
    func testSimilarity() {
        XCTAssertEqual(DiffIntraline.similarity("abc", "abc"), 1)
        XCTAssertGreaterThan(DiffIntraline.similarity("const a = 1;", "const a = 2;"), 0.8)
        XCTAssertLessThan(DiffIntraline.similarity("completely different", "nothing alike here!!"), 0.3)
    }

    func testMarksOnlyTheChangedWords() {
        let old = "const value = 1;"
        let new = "const value = 2;"
        let (del, ins) = DiffIntraline.wordRanges(old, new)
        XCTAssertEqual(del.map { slice(old, $0) }, ["1"])
        XCTAssertEqual(ins.map { slice(new, $0) }, ["2"])
    }

    func testPairsRemovalsWithAdditions() {
        let emphasis = DiffIntraline.computeEmphasis([
            .init(.ctx, "keep"), .init(.del, "let x = 1;"), .init(.del, "let y = 2;"), .init(.add, "let x = 10;"), .init(.add, "let y = 20;"),
        ])
        XCTAssertNotNil(emphasis[1])
        XCTAssertNotNil(emphasis[3])
        XCTAssertNil(emphasis[0])
    }

    func testSkipsUnrelatedLines() {
        XCTAssertTrue(DiffIntraline.computeEmphasis([.init(.del, "import fs from \"fs\";"), .init(.add, "export const answer = 42;")]).isEmpty)
    }

    func testStopsAfterAnExpiredDeadline() {
        let emphasis = DiffIntraline.computeEmphasis([.init(.del, "const value = 1;"), .init(.add, "const value = 2;")], deadline: Date().addingTimeInterval(-0.001))
        XCTAssertTrue(emphasis.isEmpty)
    }

    private func slice(_ text: String, _ range: DiffIntraline.Range) -> String {
        DiffText.string(Array(text.utf16), range)
    }
}

final class DiffMergeSpansTests: XCTestCase {
    func testSplitsRunsAtEmphasisBoundaries() {
        let text = "const x = 1;"
        let spans = DiffEngine.mergeSpans(text, runs: [.init(.keyword, 5), .init(.plain, 7)], ranges: [10..<11], emphasis: .inserted)
        XCTAssertEqual(spans.map(\.text).joined(), text)
        XCTAssertEqual(spans.filter { $0.emphasis == .inserted }.map(\.text), ["1"])
    }

    func testKeepsTheTextWithoutEmphasis() {
        let spans = DiffEngine.mergeSpans("abcdef", runs: [.init(.plain, 3), .init(.string, 3)], ranges: nil, emphasis: .deleted)
        XCTAssertEqual(spans.map(\.text).joined(), "abcdef")
        XCTAssertEqual(spans.count, 2)
    }

    func testEmptyLine() {
        XCTAssertEqual(DiffEngine.mergeSpans("", runs: [], ranges: nil, emphasis: .inserted), [])
    }

    func testExpandsTabsToTheNextStop() {
        XCTAssertEqual(DiffEngine.expandTabs("\tx\ty", width: 4), "    x   y")
        XCTAssertEqual(DiffEngine.expandTabs("😀\tx", width: 4), "😀  x")
    }
}

final class DiffBuildTests: XCTestCase {
    func testRowsRebuildTheSourceLines() throws {
        let patch = ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,4 +1,4 @@", " import { a } from \"./a\";", "-const value = 1;", "+const value = 2;", " export default value;"].joined(separator: "\n")
        let file = try XCTUnwrap(DiffEngine.build(patch: patch).files.first)
        XCTAssertEqual(file.language, "typescript")
        XCTAssertEqual(file.additions, 1)
        XCTAssertEqual(file.deletions, 1)
        let rows = lineRows(file.rows)
        XCTAssertEqual(rows.count, 4)
        for row in rows { XCTAssertEqual(textOf(row), row.text) }
        XCTAssertTrue(try XCTUnwrap(rows.first { $0.type == .add }).spans.contains { $0.emphasis == .inserted })
        XCTAssertTrue(try XCTUnwrap(rows.first { $0.type == .del }).spans.contains { $0.emphasis == .deleted })
    }

    func testExpandsTabs() throws {
        let file = try XCTUnwrap(DiffEngine.build(patch: ["--- a/x.go", "+++ b/x.go", "@@ -1 +1 @@", "-\tfmt.Println(\"a\")", "+\tfmt.Println(\"b\")"].joined(separator: "\n"), options: .init(tabWidth: 4)).files.first)
        let rows = lineRows(file.rows)
        XCTAssertTrue(rows[0].text.hasPrefix("    fmt"))
        XCTAssertEqual(file.maxColumns, rows[0].text.utf16.count)
    }

    func testWidestLineNumber() {
        XCTAssertEqual(DiffEngine.build(patch: ["--- a/x.txt", "+++ b/x.txt", "@@ -1198,2 +1198,2 @@", "-a", "+b"].joined(separator: "\n")).files[0].maxLineNo, 1198)
    }

    func testHunkRowsCountHiddenLines() {
        let rows = DiffEngine.build(patch: ["--- a/x.txt", "+++ b/x.txt", "@@ -10,2 +10,2 @@", "-a", "+b", "@@ -40,2 +40,2 @@", "-c", "+d"].joined(separator: "\n")).files[0].rows
        let hunks = rows.compactMap { row -> DiffHunk? in if case .hunk(let hunk) = row { return hunk } else { return nil } }
        XCTAssertEqual(hunks.map(\.hidden), [9, 28])
    }

    func testBinaryFilesBecomeAMessage() {
        let document = DiffEngine.build(patch: ["diff --git a/logo.png b/logo.png", "index 1111111..2222222 100644", "Binary files a/logo.png and b/logo.png differ"].joined(separator: "\n"))
        XCTAssertEqual(document.files[0].kind, .binary)
        XCTAssertEqual(document.files[0].rows.first, .message(key: "binary", code: .binary))
    }

    func testRepeatBuildsComeFromTheCache() {
        let cache = DiffDocumentCache()
        let patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-1", "+2"].joined(separator: "\n")
        let first = cache.build(patch: patch)
        XCTAssertTrue(cache.build(patch: patch) === first)
        XCTAssertFalse(cache.build(patch: patch, options: .init(intraline: false)) === first)
        cache.clearCache()
        XCTAssertFalse(cache.build(patch: patch) === first)
    }

    func testLargeFilesSkipTheWordDiff() {
        let body = (0..<40).map { " line \($0)" }
        let patch = (["--- a/big.ts", "+++ b/big.ts", "@@ -1,40 +1,40 @@"] + body + ["-const a = 1;", "+const a = 2;"]).joined(separator: "\n")
        let rows = lineRows(DiffEngine.build(patch: patch, options: .init(maxHighlightLines: 10)).files[0].rows)
        XCTAssertTrue(rows.allSatisfy { $0.spans.allSatisfy { $0.kind == .plain && $0.emphasis == .none } })
    }

    func testToleratesJunk() {
        XCTAssertTrue(DiffEngine.build(patch: "").files.isEmpty)
        XCTAssertTrue(DiffEngine.build(patch: "not a patch at all").files.isEmpty)
        _ = DiffEngine.build(patch: "@@ malformed @@\n+x")
    }

    func testDiffsTwoBlobsWithContext() {
        let oldText = (0..<20).map { "line \($0)" }.joined(separator: "\n")
        let newText = oldText.replacingOccurrences(of: "line 10", with: "line ten")
        let rows = lineRows(DiffEngine.build(path: "sample.txt", oldText: oldText, newText: newText, options: .init(contextLines: 2)).files[0].rows)
        XCTAssertEqual(rows.count, 6)
        XCTAssertEqual(rows.filter { $0.type == .add }.count, 1)
        XCTAssertEqual(rows.filter { $0.type == .del }.count, 1)
    }

    func testEmptyOldTextIsANewFile() {
        let document = DiffEngine.build(path: "new.ts", oldText: "", newText: "const a = 1;\n")
        XCTAssertEqual(document.files[0].kind, .added)
        XCTAssertEqual(document.files[0].additions, 1)
    }

    func testNoChangesIsAMessage() {
        XCTAssertEqual(DiffEngine.build(path: "same.ts", oldText: "a\nb\n", newText: "a\nb\n").files[0].rows, [.message(key: "empty", code: .empty)])
    }

    func testIgnoringWhitespaceKeepsTheOriginalText() {
        let rows = lineRows(DiffEngine.build(path: "sample.txt", oldText: "  keep\nold value\n", newText: "keep  \nnew value\n", options: .init(contextLines: 1, ignoreWhitespace: true)).files[0].rows)
        XCTAssertEqual(rows.map(\.type), [.ctx, .del, .add])
        XCTAssertEqual(rows[0].text, "keep  ")
        XCTAssertEqual(textOf(rows[0]), "keep  ")
        XCTAssertFalse(rows.contains { $0.text == "  keep" })
    }

    func testContentsCacheEntriesFollowTheOptions() {
        let cache = DiffDocumentCache()
        let oldText = (0..<12).map { "line \($0)" }.joined(separator: "\n")
        let newText = oldText.replacingOccurrences(of: "line 6", with: "line six")
        let narrow = cache.build(path: "sample.txt", oldText: oldText, newText: newText, options: .init(contextLines: 1))
        let wide = cache.build(path: "sample.txt", oldText: oldText, newText: newText, options: .init(contextLines: 5))
        XCTAssertFalse(wide === narrow)
        XCTAssertGreaterThan(lineRows(wide.files[0].rows).count, lineRows(narrow.files[0].rows).count)
        XCTAssertTrue(cache.build(path: "sample.txt", oldText: oldText, newText: newText, options: .init(contextLines: 5)) === wide)

        let normal = cache.build(path: "w.txt", oldText: "before\nchanged\nafter\n", newText: "before\n  changed  \nafter\n")
        let ignored = cache.build(path: "w.txt", oldText: "before\nchanged\nafter\n", newText: "before\n  changed  \nafter\n", options: .init(ignoreWhitespace: true))
        XCTAssertFalse(ignored === normal)
        XCTAssertTrue(lineRows(ignored.files[0].rows).isEmpty)
    }

    func testAnExhaustedBudgetIsAnUncachedError() {
        let cache = DiffDocumentCache()
        let budget = DiffEngine.Budget(timeoutMs: 50, maxEditLength: 0)
        let first = cache.build(path: "budget.txt", oldText: "old\n", newText: "new\n", options: .init(budget: budget))
        let second = cache.build(path: "budget.txt", oldText: "old\n", newText: "new\n", options: .init(budget: budget))
        XCTAssertEqual(first.error, DiffEngine.tooLargeError)
        XCTAssertTrue(first.files.isEmpty)
        XCTAssertEqual(second.error, first.error)
        XCTAssertFalse(second === first)
    }

    func testEqualFilteredContentsFitAStrictBudget() {
        let document = DiffEngine.build(path: "b.txt", oldText: "before\nchanged\nafter\n", newText: "before\n  changed  \nafter\n", options: .init(ignoreWhitespace: true, budget: .init(timeoutMs: 50, maxEditLength: 0)))
        XCTAssertNil(document.error)
        XCTAssertTrue(lineRows(document.files[0].rows).isEmpty)
    }

    func testBudgetedAndUnbudgetedDocumentsAreCachedApart() {
        let cache = DiffDocumentCache()
        let unbudgeted = cache.build(path: "c.txt", oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n")
        let options = DiffEngine.Options(budget: .init(timeoutMs: 50, maxEditLength: 2000))
        let budgeted = cache.build(path: "c.txt", oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n", options: options)
        XCTAssertNil(budgeted.error)
        XCTAssertFalse(budgeted === unbudgeted)
        XCTAssertTrue(cache.build(path: "c.txt", oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n", options: options) === budgeted)
    }

    func testALargeOneSidedFileSkipsTheBudget() {
        let newText = (0..<3000).map { "line \($0)" }.joined(separator: "\n")
        let document = DiffEngine.build(path: "large.txt", oldText: "", newText: newText, options: .init(budget: .init(timeoutMs: 50, maxEditLength: 0)))
        XCTAssertNil(document.error)
        XCTAssertEqual(document.files[0].kind, .added)
        XCTAssertEqual(document.files[0].additions, 3000)
    }

    func testCountPatchStats() {
        let patch = [
            "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@", " ctx", "-gone", "+added", "+added too",
            "diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -1 +1 @@", "-x", "+y",
        ].joined(separator: "\n")
        XCTAssertEqual(DiffStats.countPatch(patch), .init(additions: 3, deletions: 2))
        let document = DiffEngine.build(patch: patch)
        XCTAssertEqual(DiffStats.countPatch(patch), .init(additions: document.additions, deletions: document.deletions))
    }

    func testDetectLanguage() {
        XCTAssertEqual(DiffLanguage.detect("sources/app.tsx"), "tsx")
        XCTAssertEqual(DiffLanguage.detect("main.py"), "python")
        XCTAssertEqual(DiffLanguage.detect("Dockerfile"), "docker")
        XCTAssertEqual(DiffLanguage.detect("Makefile"), "makefile")
        XCTAssertNil(DiffLanguage.detect("data.unknownext"))
        XCTAssertNil(DiffLanguage.detect("trailing."))
        XCTAssertNil(DiffLanguage.detect(nil))
    }

    func testFNV1aMatchesJavaScript() {
        // (h + (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24)) >>> 0 over UTF-16.
        XCTAssertEqual(DiffEngine.fnv1a(""), 0x811c9dc5)
        XCTAssertEqual(DiffEngine.fnv1a("a"), 0xe40c292c)
    }
}

/// engine/lru.spec.ts.
final class DiffLRUCacheTests: XCTestCase {
    func testEvictsTheLeastRecentlyRead() {
        let cache = DiffLRUCache<Int>(limit: 2)
        cache.set("a", 1)
        cache.set("b", 2)
        XCTAssertEqual(cache.get("a"), 1)
        cache.set("c", 3)
        XCTAssertNil(cache.get("b"))
        cache.set("a", 4)
        XCTAssertEqual(cache.get("c"), 3)
        XCTAssertEqual(cache.get("a"), 4)
        cache.clear()
        XCTAssertNil(cache.get("a"))
    }

    func testBoundsWeight() {
        let cache = DiffLRUCache<Int>(limit: 48, maxWeight: 10)
        cache.set("a", 1, weight: 5)
        cache.set("b", 2, weight: 5)
        cache.set("b", 3, weight: 6)
        XCTAssertNil(cache.get("a"))
        XCTAssertEqual(cache.get("b"), 3)
        cache.set("b", 4, weight: 11)
        XCTAssertNil(cache.get("b"))
        cache.set("c", 5, weight: 10)
        XCTAssertEqual(cache.get("c"), 5)
    }
}

private func line(_ key: String, _ type: DiffLineType, _ text: String? = nil, oldNo: Int? = nil, newNo: Int? = nil) -> DiffRow {
    .line(DiffLine(key: key, type: type, oldNo: oldNo, newNo: newNo, text: text ?? key, spans: [DiffSpan(text ?? key)]))
}

private func hunk(_ key: String) -> DiffRow {
    .hunk(DiffHunk(key: key, text: "@@ -1 +1 @@", section: ""))
}

/// engine/splitRows.spec.ts.
final class DiffSplitRowTests: XCTestCase {
    func testContextOnBothSides() {
        let ctx = line("a", .ctx, "same", oldNo: 1, newNo: 1)
        XCTAssertEqual(DiffSplitRow.build([ctx]), [.pair(key: "a", left: ctx.line, right: ctx.line)])
    }

    func testPairsARemovalWithItsReplacement() {
        let del = line("d", .del, "old", oldNo: 4)
        let add = line("a", .add, "new", newNo: 4)
        XCTAssertEqual(DiffSplitRow.build([del, add]), [.pair(key: "d|a", left: del.line, right: add.line)])
    }

    func testPadsTheShorterSide() {
        let rows = DiffSplitRow.build([line("d0", .del), line("d1", .del), line("d2", .del), line("a0", .add)])
        XCTAssertEqual(rows.map(\.key), ["d0|a0", "d1|_", "d2|_"])
    }

    func testPureAdditionLeavesTheOldSideEmpty() {
        let add = line("a0", .add, "added", newNo: 7)
        XCTAssertEqual(DiffSplitRow.build([add]), [.pair(key: "_|a0", left: nil, right: add.line)])
    }

    func testHunksAndMessagesSpanBothColumns() {
        let rows = DiffSplitRow.build([hunk("h0"), .message(key: "m0", code: .binary)])
        XCTAssertEqual(rows, [.full(hunk("h0")), .full(.message(key: "m0", code: .binary))])
    }

    func testKeysAreUnique() {
        let document = DiffEngine.build(patch: ["--- a/x.ts", "+++ b/x.ts", "@@ -1,4 +1,4 @@", " const a = 1;", "-const b = 2;", "-const c = 3;", "+const b = 20;", " const d = 4;", "@@ -10,2 +10,3 @@", " const e = 5;", "+const f = 6;", ""].joined(separator: "\n"))
        let keys = DiffSplitRow.build(document.files[0].rows).map(\.key)
        XCTAssertEqual(Set(keys).count, keys.count)
    }

    func testKeepsEveryLine() {
        let document = DiffEngine.build(patch: ["--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " keep", "-drop", "+gain", ""].joined(separator: "\n"))
        var seen = Set<String>()
        for case .pair(_, let left, let right) in DiffSplitRow.build(document.files[0].rows) {
            if let left { seen.insert(left.key) }
            if let right { seen.insert(right.key) }
        }
        XCTAssertEqual(seen.count, lineRows(document.files[0].rows).count)
    }
}

/// layout.spec.ts `selectVisibleRows`.
final class DiffRowSelectionTests: XCTestCase {
    private func contextRun(_ count: Int, _ prefix: String = "c") -> [DiffRow] {
        (0..<count).map { line("\(prefix)\($0)", .ctx) }
    }

    func testUnderTheLimitShowsEverything() {
        let rows = contextRun(10)
        let result = DiffRowSelection.select(rows, showHunkHeaders: true, expanded: false, collapseAfter: 80)
        XCTAssertEqual(result.rows, rows)
        XCTAssertEqual(result.hiddenCount, 0)
    }

    func testDropsHunkSeparatorsWhenOff() {
        let result = DiffRowSelection.select([hunk("h0")] + contextRun(3), showHunkHeaders: false, expanded: false, collapseAfter: 80)
        XCTAssertEqual(result.rows.count, 3)
        XCTAssertTrue(result.rows.allSatisfy { $0.line != nil })
    }

    func testCollapsesToTheLimit() {
        let result = DiffRowSelection.select(contextRun(100), showHunkHeaders: true, expanded: false, collapseAfter: 80)
        XCTAssertEqual(result.rows.count, 80)
        XCTAssertEqual(result.hiddenCount, 20)
    }

    func testExpandedShowsEverything() {
        let result = DiffRowSelection.select(contextRun(100), showHunkHeaders: true, expanded: true, collapseAfter: 80)
        XCTAssertEqual(result.rows.count, 100)
        XCTAssertEqual(result.hiddenCount, 0)
    }

    func testNeverCutsBetweenRemovalsAndTheirAdditions() {
        let rows = contextRun(8) + [line("d0", .del), line("d1", .del), line("a0", .add), line("a1", .add)] + contextRun(20, "tail")
        let result = DiffRowSelection.select(rows, showHunkHeaders: true, expanded: false, collapseAfter: 10)
        let keys = result.rows.map(\.key)
        XCTAssertTrue(keys.contains("a0"))
        XCTAssertTrue(keys.contains("a1"))
        XCTAssertEqual(result.rows.count, 12)
        XCTAssertEqual(result.hiddenCount, 20)
    }

    func testCutsOnAContextLine() {
        let result = DiffRowSelection.select(contextRun(20) + [line("d0", .del), line("a0", .add)], showHunkHeaders: true, expanded: false, collapseAfter: 10)
        XCTAssertEqual(result.rows.count, 10)
        XCTAssertEqual(result.hiddenCount, 12)
    }

    func testBoundsTheSnap() {
        let rows = (0..<500).map { line("d\($0)", $0 % 2 == 0 ? .del : .add) } + contextRun(10, "tail")
        let result = DiffRowSelection.select(rows, showHunkHeaders: true, expanded: false, collapseAfter: 100)
        XCTAssertLessThanOrEqual(result.rows.count, 300)
        XCTAssertGreaterThan(result.hiddenCount, 0)
    }

    func testCountsAlwaysAddUp() {
        let rows = contextRun(5) + [line("d0", .del), line("a0", .add)] + contextRun(5, "mid") + [line("d1", .del), line("a1", .add)] + contextRun(5, "tail")
        for limit in 1...rows.count {
            let result = DiffRowSelection.select(rows, showHunkHeaders: true, expanded: false, collapseAfter: limit)
            XCTAssertEqual(result.rows.count + result.hiddenCount, rows.count)
        }
    }
}

/// useProgressiveRows.spec.ts.
final class DiffProgressiveRowsTests: XCTestCase {
    private func drain(_ total: Int) -> [Int] {
        var progress = DiffProgressiveRows(total: total, initial: 120, chunk: 200)
        var counts = [progress.count]
        while progress.advance() { counts.append(progress.count) }
        return counts
    }

    func testAShortListIsWholeAtOnce() {
        XCTAssertEqual(drain(40), [40])
    }

    func testFirstWindowThenChunksToTheEnd() {
        XCTAssertEqual(drain(1000), [120, 320, 520, 720, 920, 1000])
    }

    func testNeverOvershoots() {
        XCTAssertEqual(drain(125).max(), 125)
    }

    func testEmpty() {
        XCTAssertEqual(drain(0), [0])
    }

    func testRedecoratingKeepsWhatIsFilled() {
        var progress = DiffProgressiveRows(total: 500)
        progress.advance()
        progress.advance()
        XCTAssertEqual(progress.count, 500)
        progress.update(total: 500)
        XCTAssertEqual(progress.count, 500)
    }

    func testANewDocumentStartsAtTheInitialWindow() {
        var progress = DiffProgressiveRows(total: 500)
        while progress.advance() {}
        progress.reset(total: 700)
        XCTAssertEqual(progress.count, 120)
    }
}

final class DiffSelectableTextTests: XCTestCase {
    /// DiffRowCode's `selectable` Text copies its line as drawn.
    func testSelectableText() throws {
        let patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-\tconst a = 1;\n+\tconst a = 2;\n \n"
        let file = try XCTUnwrap(DiffEngine.build(patch: patch).files.first)
        XCTAssertNil(file.rows[0].selectableText)
        // Tabs are expanded, as drawn; word emphasis doesn't split it.
        XCTAssertEqual(file.rows[1].selectableText, "    const a = 1;")
        XCTAssertEqual(file.rows[2].selectableText, "    const a = 2;")
        // An empty line draws, and copies, a space.
        XCTAssertEqual(file.rows[3].selectableText, " ")
        XCTAssertNil(DiffRow.message(key: "binary", code: .binary).selectableText)
    }
}
