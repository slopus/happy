import Foundation
import XCTest
@testable import HappyCore

/// utils/codexUnifiedDiff.spec.ts, and the edges of the port.
final class CodexUnifiedDiffTests: XCTestCase {
    func testParsesHunkFragmentsWithoutFileHeaders() {
        let parsed = CodexUnifiedDiff.parse([
            "@@ -10,2 +10,4 @@",
            " ",
            "+<p align=\"center\"><em>Still won't make your tests pass by the power of positive thinking.</em></p>",
            "+",
            " <div align=\"center\">",
        ].joined(separator: "\n"))
        XCTAssertNil(parsed.fileName)
        XCTAssertEqual(parsed.oldText, "\n<div align=\"center\">")
        XCTAssertEqual(parsed.newText, [
            "",
            "<p align=\"center\"><em>Still won't make your tests pass by the power of positive thinking.</em></p>",
            "",
            "<div align=\"center\">",
        ].joined(separator: "\n"))
    }

    func testExtractsFileNamesFromFullDiffs() {
        let parsed = CodexUnifiedDiff.parse([
            "diff --git a/README.md b/README.md",
            "index 1111111..2222222 100644",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1 +1 @@",
            "-old line",
            "+new line",
        ].joined(separator: "\n"))
        XCTAssertEqual(parsed.fileName, "README.md")
        XCTAssertEqual(parsed.oldText, "old line")
        XCTAssertEqual(parsed.newText, "new line")
    }

    func testAddsHeadersToHunkOnlyFragments() {
        let fragment = ["@@ -1 +1 @@", "-old line", "+new line"].joined(separator: "\n")
        XCTAssertEqual(CodexUnifiedDiff.materializePatch(fragment, fileName: "README.md", kind: .update), [
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1 +1 @@",
            "-old line",
            "+new line",
        ].joined(separator: "\n"))
        XCTAssertTrue(CodexUnifiedDiff.materializePatch(fragment, fileName: "a.ts", kind: .add).hasPrefix("--- /dev/null\n+++ b/a.ts\n"))
        XCTAssertTrue(CodexUnifiedDiff.materializePatch(fragment, fileName: "a.ts", kind: CodexUnifiedDiff.FileKind("delete")).hasPrefix("--- a/a.ts\n+++ /dev/null\n"))
        XCTAssertTrue(CodexUnifiedDiff.materializePatch(fragment, fileName: "a.ts", kind: CodexUnifiedDiff.FileKind(nil)).hasPrefix("--- a/a.ts\n+++ b/a.ts\n"))
    }

    func testKeepsFullDiffsUnchanged() {
        let patch = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old line", "+new line"].joined(separator: "\n")
        XCTAssertEqual(CodexUnifiedDiff.materializePatch(patch, fileName: "README.md"), patch)
        let git = "diff --git a/x b/x\n"
        XCTAssertEqual(CodexUnifiedDiff.materializePatch(git, fileName: "x"), git)
        let later = "@@ -1 +1 @@\n+++ b/x\n"
        XCTAssertEqual(CodexUnifiedDiff.materializePatch(later, fileName: "x"), later)
    }

    func testSkipsMetadataAndOutsideLines() {
        let parsed = CodexUnifiedDiff.parse([
            "noise before",
            "new file mode 100644",
            "+++ other/name.ts",
            "@@ -0,0 +1,2 @@",
            "+a",
            "\\ No newline at end of file",
            "",
            "garbage",
        ].joined(separator: "\n"))
        XCTAssertEqual(parsed.fileName, "other/name.ts")
        XCTAssertEqual(parsed.oldText, "")
        XCTAssertEqual(parsed.newText, "a\n")
    }

    func testMatchesByCodeUnit() {
        // A combining mark after the marker is still JavaScript's "+".
        XCTAssertEqual(CodexUnifiedDiff.parse("@@\n+\u{301}x\n \r").newText, "\u{301}x\n\r")
    }
}
