import Foundation
@testable import HappyCore
import XCTest

/// parseMarkdown.test.ts, parseMarkdownBlock.test.ts and linkUtils.test.ts,
/// plus the block rules those files leave untested.
final class MarkdownParserTests: XCTestCase {
    private func plain(_ text: String) -> [MarkdownSpan] {
        text.isEmpty ? [] : [MarkdownSpan(text: text)]
    }

    // MARK: parseMarkdown.test.ts

    func testUnorderedListsAcrossBulletMarkersKeepLinks() {
        let blocks = Markdown.parse([
            "* first item",
            "+ second item with [docs](https://example.com/docs)",
            "- third item with https://example.com/raw.",
        ].joined(separator: "\n"))
        guard case .list(let items) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected one list, got \(blocks)")
        }
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[1], MarkdownListItem(depth: 0, spans: [
            MarkdownSpan(text: "second item with "),
            MarkdownSpan(text: "docs", url: "https://example.com/docs"),
        ]))
        XCTAssertEqual(items[2], MarkdownListItem(depth: 0, spans: [
            MarkdownSpan(text: "third item with "),
            MarkdownSpan(text: "https://example.com/raw", url: "https://example.com/raw"),
            MarkdownSpan(text: "."),
        ]))
    }

    func testStandaloneImageBlocks() {
        XCTAssertEqual(
            Markdown.parse("![Markdown renderable image](data:image/png;base64,abc123)"),
            [.image(alt: "Markdown renderable image", url: "data:image/png;base64,abc123")]
        )
    }

    func testBareURLsInTextBecomeLinks() {
        XCTAssertEqual(Markdown.parse("Visit https://example.com/docs for more."), [.text([
            MarkdownSpan(text: "Visit "),
            MarkdownSpan(text: "https://example.com/docs", url: "https://example.com/docs"),
            MarkdownSpan(text: " for more."),
        ])])
    }

    // MARK: parseMarkdownBlock.test.ts (tables)

    func testStandardTable() {
        let md = ["| A | B |", "|---|---|", "| 1 | 2 |"].joined(separator: "\n")
        XCTAssertEqual(Markdown.parse(md), [.table(headers: [plain("A"), plain("B")], rows: [[plain("1"), plain("2")]])])
    }

    func testTableWithBlankLinesBetweenRows() {
        let md = ["| A | B |", "", "|---|---|", "", "| 1 | 2 |", "", "| 3 | 4 |"].joined(separator: "\n")
        XCTAssertEqual(Markdown.parse(md), [.table(
            headers: [plain("A"), plain("B")],
            rows: [[plain("1"), plain("2")], [plain("3"), plain("4")]]
        )])
    }

    func testEmptyInteriorCellsAreKept() {
        let md = ["| | Header1 | Header2 |", "|---|---|---|", "| Row1 | a | b |"].joined(separator: "\n")
        XCTAssertEqual(Markdown.parse(md), [.table(
            headers: [plain(""), plain("Header1"), plain("Header2")],
            rows: [[plain("Row1"), plain("a"), plain("b")]]
        )])
    }

    func testBlankLinesAndAnEmptyFirstCellCombined() {
        let md = [
            "### Comparison", "",
            "| | Plan A | Plan B |", "",
            "|--|----|----|", "",
            "| Price | $10/mo | $20/mo |", "",
            "| Storage | 5 GB | 50 GB |", "",
            "| Support | Email only | 24/7 chat |",
        ].joined(separator: "\n")
        let blocks = Markdown.parse(md)
        XCTAssertEqual(blocks.first, .header(level: 3, plain("Comparison")))
        guard blocks.count == 2, case .table(let headers, let rows) = blocks[1] else {
            return XCTFail("expected a header and one table, got \(blocks)")
        }
        XCTAssertEqual(headers.count, 3)
        XCTAssertEqual(headers[0], [])
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0][0], plain("Price"))
    }

    func testATableStopsAtTheFirstLineWithoutAPipe() {
        let md = ["| A | B |", "|---|---|", "| 1 | 2 |", "", "Some text after the table"].joined(separator: "\n")
        let blocks = Markdown.parse(md)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[1], .text(plain("Some text after the table")))
    }

    func testPipesWithoutASeparatorAreText() {
        XCTAssertEqual(Markdown.parse("a | b\nc | d"), [.text(plain("a | b")), .text(plain("c | d"))])
    }

    // MARK: linkUtils.test.ts

    func testHTTPLinks() {
        XCTAssertTrue(Markdown.isHTTPLink("http://example.com"))
        XCTAssertTrue(Markdown.isHTTPLink("https://example.com/docs"))
        XCTAssertTrue(Markdown.isHTTPLink(" HTTPS://example.com/docs "))
        XCTAssertFalse(Markdown.isHTTPLink("mailto:test@example.com"))
        XCTAssertFalse(Markdown.isHTTPLink("data:text/plain,hello"))
        XCTAssertFalse(Markdown.isHTTPLink("/Users/me/project/file.ts"))
        XCTAssertFalse(Markdown.isHTTPLink("packages/happy-app/index.tsx"))
    }

    // MARK: Blocks

    func testHeadersNeedTheSpaceAndKeepNoInlineStyles() {
        XCTAssertEqual(Markdown.parse("## A **bold** title"), [.header(level: 2, [
            MarkdownSpan(text: "A "), MarkdownSpan(text: "bold"), MarkdownSpan(text: " title"),
        ])])
        XCTAssertEqual(Markdown.parse("#nospace"), [.text(plain("#nospace"))])
        XCTAssertEqual(Markdown.parse("####### seven"), [.text(plain("####### seven"))])
        // An indented header is not a header: headers are read before trimming.
        XCTAssertEqual(Markdown.parse("  # indented"), [.text(plain("# indented"))])
    }

    func testCodeBlocksKeepTheirLinesAndLanguage() {
        let md = ["```swift", "let a = 1", "", "  indented", "```", "after"].joined(separator: "\n")
        XCTAssertEqual(Markdown.parse(md), [
            .codeBlock(language: "swift", content: "let a = 1\n\n  indented"),
            .text(plain("after")),
        ])
        XCTAssertEqual(Markdown.parse("```\nplain"), [.codeBlock(language: nil, content: "plain")])
        XCTAssertEqual(Markdown.parse("```mermaid\ngraph TD\n```"), [.mermaid("graph TD")])
    }

    func testHorizontalRuleAndOptions() {
        let md = ["---", "<options>", "<option>Yes</option>", "  <option>No, stop</option>", "junk", "</options>"].joined(separator: "\n")
        XCTAssertEqual(Markdown.parse(md), [.horizontalRule, .options(["Yes", "No, stop"])])
        XCTAssertEqual(Markdown.parse("<options>\n</options>"), [])
    }

    func testNumberedListsWithDepth() {
        let md = ["1. one", "  2. nested", "3.  three", "not a list"].joined(separator: "\n")
        XCTAssertEqual(Markdown.parse(md), [
            .numberedList([
                MarkdownNumberedItem(number: 1, depth: 0, spans: plain("one")),
                MarkdownNumberedItem(number: 2, depth: 1, spans: plain("nested")),
                MarkdownNumberedItem(number: 3, depth: 0, spans: plain("three")),
            ]),
            .text(plain("not a list")),
        ])
    }

    func testListDepthIsMeasuredFromTheFirstItemAndRoundsDown() {
        let md = ["   - a", " - b", "      - c"].joined(separator: "\n")
        guard case .list(let items) = Markdown.parse(md).first else { return XCTFail() }
        XCTAssertEqual(items.map(\.depth), [0, -1, 1])
    }

    func testABlankLineEndsAList() {
        XCTAssertEqual(Markdown.parse("- a\n\n- b"), [
            .list([MarkdownListItem(depth: 0, spans: plain("a"))]),
            .list([MarkdownListItem(depth: 0, spans: plain("b"))]),
        ])
    }

    func testCRLFLinesAreTrimmed() {
        XCTAssertEqual(Markdown.parse("one\r\ntwo"), [.text(plain("one")), .text(plain("two"))])
    }

    // MARK: Spans

    func testInlineStyles() {
        XCTAssertEqual(Markdown.parseSpans("a **b** *c* `d` [e](f)", header: false), [
            MarkdownSpan(text: "a "),
            MarkdownSpan(styles: [.bold], text: "b"),
            MarkdownSpan(text: " "),
            MarkdownSpan(styles: [.italic], text: "c"),
            MarkdownSpan(text: " "),
            MarkdownSpan(styles: [.code], text: "d"),
            MarkdownSpan(text: " "),
            MarkdownSpan(text: "e", url: "f"),
        ])
    }

    func testUnclosedMarkersRunToTheEnd() {
        XCTAssertEqual(Markdown.parseSpans("x **bold", header: false), [
            MarkdownSpan(text: "x "), MarkdownSpan(styles: [.bold], text: "bold"),
        ])
        XCTAssertEqual(Markdown.parseSpans("`code", header: false), [MarkdownSpan(styles: [.code], text: "code")])
    }

    func testEmptyCodeSpanIsKeptAndEmptyBoldIsNot() {
        XCTAssertEqual(Markdown.parseSpans("``", header: false), [MarkdownSpan(styles: [.code], text: "")])
        XCTAssertEqual(Markdown.parseSpans("****", header: false), [])
    }

    func testALinkWithoutAURLKeepsItsBrackets() {
        XCTAssertEqual(Markdown.parseSpans("see [note] here", header: false), [
            MarkdownSpan(text: "see "), MarkdownSpan(text: "[note]"), MarkdownSpan(text: " here"),
        ])
    }

    func testStyledURLsStayStyledAndTrailingPunctuationStaysOut() {
        XCTAssertEqual(Markdown.parseSpans("**see https://a.io/x),**", header: false), [
            MarkdownSpan(styles: [.bold], text: "see "),
            MarkdownSpan(styles: [.bold], text: "https://a.io/x", url: "https://a.io/x"),
            MarkdownSpan(styles: [.bold], text: "),"),
        ])
    }

    func testUTF16OffsetsSurviveEmoji() {
        XCTAssertEqual(Markdown.parseSpans("🎉 **ok** 👍🏽 `x`", header: false), [
            MarkdownSpan(text: "🎉 "),
            MarkdownSpan(styles: [.bold], text: "ok"),
            MarkdownSpan(text: " 👍🏽 "),
            MarkdownSpan(styles: [.code], text: "x"),
        ])
    }
}

/// SimpleSyntaxHighlighter.tsx's tokenizer.
final class SyntaxHighlighterTests: XCTestCase {
    func testNoLanguageIsOnePlainToken() {
        XCTAssertEqual(SyntaxHighlighter.tokenize("let x = 1", language: nil), [SyntaxToken("let x = 1", .plain)])
    }

    func testKeywordsNumbersAndOperators() {
        XCTAssertEqual(SyntaxHighlighter.tokenize("let x = 1;", language: "js"), [
            SyntaxToken("let", .keyword),
            SyntaxToken(" x ", .plain),
            SyntaxToken("=", .assignment),
            SyntaxToken(" ", .plain),
            SyntaxToken("1", .number),
            SyntaxToken(";", .punctuation),
        ])
    }

    func testCallsBracketsAndNesting() {
        XCTAssertEqual(SyntaxHighlighter.tokenize("f(g(1))", language: "ts"), [
            SyntaxToken("f", .function),
            SyntaxToken("(", .bracket, nestLevel: 1),
            SyntaxToken("g", .function),
            SyntaxToken("(", .bracket, nestLevel: 2),
            SyntaxToken("1", .number),
            SyntaxToken(")", .bracket, nestLevel: 2),
            SyntaxToken(")", .bracket, nestLevel: 1),
        ])
    }

    func testStringsWinOverWhatTheyContainAndCommentsRunToTheEnd() {
        XCTAssertEqual(SyntaxHighlighter.tokenize("x = \"if\" // done", language: "py"), [
            SyntaxToken("x ", .plain),
            SyntaxToken("=", .assignment),
            SyntaxToken(" ", .plain),
            SyntaxToken("\"if\"", .string),
            SyntaxToken(" ", .plain),
            SyntaxToken("// done", .comment),
        ])
    }

    func testFunctionDefinitionsTakeTheNameAndMethodsTheirMember() {
        XCTAssertEqual(SyntaxHighlighter.tokenize("def run():", language: "python"), [
            SyntaxToken("def", .keyword),
            SyntaxToken(" ", .plain),
            SyntaxToken("run", .function),
            SyntaxToken("(", .bracket, nestLevel: 1),
            SyntaxToken(")", .bracket, nestLevel: 1),
            SyntaxToken(":", .operator),
        ])
        XCTAssertEqual(SyntaxHighlighter.tokenize("a.b()", language: "js").map(\.kind), [.plain, .punctuation, .function, .bracket, .bracket])
    }

    func testLinesKeepTheirBreaksAndNestingSpansLines() {
        let tokens = SyntaxHighlighter.tokenize("{\n}", language: "js")
        XCTAssertEqual(tokens, [
            SyntaxToken("{", .bracket, nestLevel: 1),
            SyntaxToken("\n", .plain),
            SyntaxToken("}", .bracket, nestLevel: 1),
        ])
    }

    func testBoldKinds() {
        XCTAssertTrue(SyntaxToken("if", .controlFlow).isBold)
        XCTAssertFalse(SyntaxToken("1", .number).isBold)
    }
}
