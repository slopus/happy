import Foundation
import XCTest
@testable import HappyCore

/// The Prism port against runs prismjs 1.30 gives in JavaScript
/// (highlight.ts's highlightLines), and syntax/{tokenize,plan,code}.ts.
final class PrismTests: XCTestCase {
    func testEveryPatternCompiles() throws {
        let table = Prism.table
        XCTAssertEqual(table.grammars.count, 254)
        XCTAssertEqual(table.sources.count, 740)
        for grammar in table.grammars {
            for token in grammar {
                for pattern in token.patterns {
                    XCTAssertNoThrow(try table.regex(pattern), table.sources[pattern.source])
                    XCTAssertLessThan(pattern.inside, table.grammars.count)
                }
            }
        }
        for language in ["javascript", "tsx", "python", "swift", "erlang", "shell-session"] {
            XCTAssertTrue(Prism.hasGrammar(language))
        }
        XCTAssertFalse(Prism.hasGrammar("diff"))
        XCTAssertFalse(Prism.hasGrammar("ignore"))
        XCTAssertFalse(Prism.hasGrammar(nil))
    }

    func testHighlightLinesMatchesPrism() {
        typealias R = DiffSyntaxRun
        let cases: [(String, String, [[R]])] = [
            ("bash", "cat <<EOF\nhello $USER\nEOF\n", [[.init(.function, 3), .init(.plain, 1), .init(.operator, 2), .init(.string, 3)], [.init(.string, 11)], [.init(.string, 3)], []]),
            ("bash", "# comment\r\nprintf \"%s\\n\" \"🙂\"  \r\n\r\n", [[.init(.comment, 9), .init(.plain, 1)], [.init(.type, 6), .init(.plain, 1), .init(.string, 3), .init(.keyword, 2), .init(.string, 1), .init(.plain, 1), .init(.string, 4), .init(.plain, 3)], [.init(.plain, 1)], []]),
            ("javascript", "const café = /ab+c/gi; // ünïcode", [[.init(.keyword, 5), .init(.plain, 6), .init(.operator, 1), .init(.plain, 1), .init(.string, 8), .init(.punctuation, 1), .init(.plain, 1), .init(.comment, 10)]]),
            ("typescript", "let x: number = 0x1F;\n/* a\nb */ f(x)", [[.init(.keyword, 3), .init(.plain, 2), .init(.operator, 1), .init(.plain, 1), .init(.type, 6), .init(.plain, 1), .init(.operator, 1), .init(.plain, 1), .init(.number, 4), .init(.punctuation, 1)], [.init(.comment, 4)], [.init(.comment, 4), .init(.plain, 1), .init(.function, 1), .init(.punctuation, 1), .init(.plain, 1), .init(.punctuation, 1)]]),
            // A triple-quoted string's type is not one highlight.ts maps.
            ("python", "def f(a):\n    \"\"\"doc\n    string\"\"\"\n    return a ** 2", [[.init(.keyword, 3), .init(.plain, 1), .init(.function, 1), .init(.punctuation, 1), .init(.plain, 1), .init(.punctuation, 2)], [.init(.plain, 10)], [.init(.plain, 13)], [.init(.plain, 4), .init(.keyword, 6), .init(.plain, 3), .init(.operator, 2), .init(.plain, 1), .init(.number, 1)]]),
            ("markup", "<a href=\"x\">t &amp; u</a>", [[.init(.punctuation, 1), .init(.tag, 2), .init(.attr, 4), .init(.punctuation, 2), .init(.string, 1), .init(.punctuation, 2), .init(.plain, 2), .init(.keyword, 5), .init(.plain, 2), .init(.punctuation, 2), .init(.tag, 1), .init(.punctuation, 1)]]),
            ("swift", "let s = \"\\(a + 1)\" // c", [[.init(.keyword, 3), .init(.plain, 3), .init(.operator, 1), .init(.plain, 1), .init(.string, 1), .init(.punctuation, 2), .init(.plain, 2), .init(.operator, 1), .init(.plain, 1), .init(.number, 1), .init(.punctuation, 1), .init(.string, 1), .init(.plain, 1), .init(.comment, 4)]]),
            ("shell-session", "$ echo \"hello\"\nhello\nif 123 true\n", [[.init(.plain, 2), .init(.type, 4), .init(.plain, 1), .init(.string, 7)], [.init(.plain, 5)], [.init(.plain, 11)], []]),
        ]
        for (language, text, expected) in cases {
            XCTAssertEqual(DiffSyntax.highlightLines(text, language: language), expected, "\(language): \(text)")
        }
        // Without a grammar every line is one plain run.
        XCTAssertEqual(DiffSyntax.highlightLines("a\n\nbc", language: "diff"), [[.init(.plain, 1)], [], [.init(.plain, 2)]])
        XCTAssertEqual(DiffSyntax.highlightLines("", language: "javascript"), [[]])
    }

    func testClassify() {
        XCTAssertEqual(DiffSyntax.classify("boolean"), .keyword)
        XCTAssertEqual(DiffSyntax.classify("template-string"), .string)
        XCTAssertEqual(DiffSyntax.classify("class-name"), .type)
        XCTAssertEqual(DiffSyntax.classify("attr-name"), .attr)
        XCTAssertEqual(DiffSyntax.classify("constant"), .variable)
        XCTAssertEqual(DiffSyntax.classify("triple-quoted-string"), .plain)
    }

    // MARK: tokenize.ts

    func testTokenizeTakesEachLineFromItsSide() {
        let input = DiffSyntax.Input(language: "typescript", lines: [
            .init(text: "/* comment", type: .ctx),
            .init(text: "   still comment */", type: .ctx),
            .init(text: "const count = 1;", type: .del),
            .init(text: "let count = 2;", type: .add),
        ])
        let result = DiffSyntax.tokenize(input)
        XCTAssertEqual(result.status, .highlighted)
        XCTAssertEqual(result.runs.count, 4)
        XCTAssertEqual(result.runs[1], [.init(.comment, 19)])
        XCTAssertEqual(result.runs[2].first, .init(.keyword, 5))
        XCTAssertEqual(result.runs[3].first, .init(.keyword, 3))
    }

    func testTokenizeLimits() {
        XCTAssertEqual(DiffSyntax.tokenize(.init(language: "cobol", lines: [.init(text: "x", type: .ctx)])).status, .unsupported)
        let long = DiffSyntax.Input(language: "bash", lines: [.init(text: String(repeating: "x", count: DiffSyntax.maxLine + 1), type: .ctx)])
        XCTAssertEqual(DiffSyntax.tokenize(long).status, .limited)
        let many = DiffSyntax.Input(language: "bash", lines: Array(repeating: .init(text: "", type: .ctx), count: DiffSyntax.maxLines + 1))
        XCTAssertFalse(DiffSyntax.withinLimits(many))
        let big = DiffSyntax.Input(language: "bash", lines: Array(repeating: .init(text: String(repeating: "x", count: 1999), type: .ctx), count: 65))
        XCTAssertFalse(DiffSyntax.withinLimits(big))
        XCTAssertEqual(DiffSyntax.tokenize(.init(language: "bash", lines: [.init(text: "echo hi", type: .ctx)]), budget: .zero).status, .limited)
    }

    // MARK: plan.ts

    private let patch = [
        "--- a/sample.ts", "+++ b/sample.ts", "@@ -1,3 +1,3 @@",
        " /* comment", "    still comment */", "-const count = 1;", "+const count = 2;",
        "@@ -20,1 +20,1 @@", "-const hidden = true;", "+const hidden = false;",
    ].joined(separator: "\n")

    func testPlanTakesWholeHunksThatShow() throws {
        let file = try XCTUnwrap(DiffEngine.build(patch: patch).files.first)
        let plan = DiffSyntaxPlan.plan(file, displayed: [file.rows[2]])
        XCTAssertEqual(plan.count, 1)
        XCTAssertEqual(plan[0].input.lines.count, 4)
        XCTAssertEqual(plan[0].input.lines[0].text, "/* comment")
        XCTAssertEqual(plan[0].rowKeys, file.rows[1...4].map(\.key))
    }

    func testApplyColoursWithoutTouchingTextOrEmphasis() throws {
        let file = try XCTUnwrap(DiffEngine.build(patch: patch).files.first)
        let plan = DiffSyntaxPlan.plan(file, displayed: file.rows)
        XCTAssertEqual(plan.count, 2)
        let outcomes = Dictionary(uniqueKeysWithValues: plan.map { ($0.key, DiffSyntax.tokenize($0.input)) })
        let next = DiffSyntaxPlan.apply(file.rows, hunks: plan, outcomes: outcomes)
        XCTAssertEqual(next[0], file.rows[0])
        var coloured = 0
        for (row, original) in zip(next, file.rows) {
            guard case .line(let line) = row, case .line(let old) = original else { continue }
            XCTAssertEqual(line.spans.map(\.text).joined(), line.text)
            func emphasis(_ spans: [DiffSpan]) -> [DiffEmphasis] { spans.flatMap { Array(repeating: $0.emphasis, count: $0.text.utf16.count) } }
            XCTAssertEqual(emphasis(line.spans), emphasis(old.spans))
            if line.spans.contains(where: { $0.kind != .plain }) { coloured += 1 }
        }
        XCTAssertEqual(coloured, 6)
        XCTAssertEqual(DiffSyntaxPlan.apply(file.rows, hunks: plan, outcomes: [:]), file.rows)
    }

    func testPlanSkipsUnknownLanguagesHugeHunksAndColouredRows() throws {
        var file = try XCTUnwrap(DiffEngine.build(patch: patch).files.first)
        let coloured = DiffSyntaxPlan.apply(file.rows, hunks: DiffSyntaxPlan.plan(file, displayed: file.rows), outcomes: Dictionary(uniqueKeysWithValues: DiffSyntaxPlan.plan(file, displayed: file.rows).map { ($0.key, DiffSyntax.tokenize($0.input)) }))
        var done = file
        done.rows = coloured
        XCTAssertEqual(DiffSyntaxPlan.plan(done, displayed: done.rows), [])
        file.language = nil
        XCTAssertEqual(DiffSyntaxPlan.plan(file, displayed: file.rows), [])
        let huge = try XCTUnwrap(DiffEngine.build(patch: "--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1 @@\n+\(String(repeating: "x", count: 2001))").files.first)
        XCTAssertEqual(DiffSyntaxPlan.plan(huge, displayed: huge.rows), [])
    }

    func testKeysDependOnContentAndLanguage() {
        let a = DiffSyntax.Input(language: "bash", lines: [.init(text: "a|ctx1:b", type: .ctx)])
        let b = DiffSyntax.Input(language: "bash", lines: [.init(text: "a", type: .ctx), .init(text: "b", type: .ctx)])
        XCTAssertNotEqual(DiffSyntaxPlan.key(a), DiffSyntaxPlan.key(b))
        XCTAssertEqual(DiffSyntaxPlan.key(a), DiffSyntaxPlan.key(a))
        XCTAssertNotEqual(DiffSyntaxPlan.key(a), DiffSyntaxPlan.key(.init(language: "shell-session", lines: a.lines)))
    }

    // MARK: code.ts

    func testCodePlans() {
        XCTAssertNil(DiffSyntaxPlan.planCode("", language: "bash"))
        XCTAssertNil(DiffSyntaxPlan.planCode("echo hi", language: nil))
        XCTAssertNil(DiffSyntaxPlan.planCode(String(repeating: "x", count: DiffSyntax.maxLine + 1), language: "bash"))
        XCTAssertNil(DiffSyntaxPlan.planCode(String(repeating: "\n", count: DiffSyntax.maxLines), language: "bash"))
        let plan = DiffSyntaxPlan.planCode("echo \"$HOME\"\n", language: "bash")
        XCTAssertEqual(plan?.input.lines.map(\.type), [.ctx, .ctx])
        XCTAssertEqual(plan?.key, DiffSyntaxPlan.planCode("echo \"$HOME\"\n", language: "bash")?.key)
    }

    func testCodeSpansKeepTheTextExactly() throws {
        let code = "# comment\r\nprintf \"%s\\n\" \"🙂\"  \r\n\r\n"
        let plan = try XCTUnwrap(DiffSyntaxPlan.planCode(code, language: "bash"))
        let spans = try XCTUnwrap(DiffSyntaxPlan.codeSpans(plan.input, outcome: DiffSyntax.tokenize(plan.input)))
        XCTAssertEqual(spans.map(\.text).joined(), code)
        XCTAssertTrue(spans.contains { $0.kind != .plain })

        let session = try XCTUnwrap(DiffSyntaxPlan.planCode("ordinary output\n", language: "shell-session"))
        XCTAssertNil(DiffSyntaxPlan.codeSpans(session.input, outcome: DiffSyntax.tokenize(session.input)))
        XCTAssertNil(DiffSyntaxPlan.codeSpans(session.input, outcome: nil))
        let lines = Array(repeating: DiffSyntax.Input.Line(text: "x", type: .ctx), count: DiffSyntaxPlan.maxCodeSpans)
        let crowded = DiffSyntax.Result(status: .highlighted, runs: lines.map { _ in [.init(.keyword, 1)] })
        // Alternating keyword and newline spans pass the cap.
        XCTAssertNil(DiffSyntaxPlan.codeSpans(.init(language: "bash", lines: lines), outcome: crowded))
    }

    // MARK: Service

    func testServiceColoursUntilTheDeadlineThenFillsTheCache() async throws {
        let file = try XCTUnwrap(DiffEngine.build(patch: patch).files.first)
        let service = DiffSyntaxService()
        // Past the deadline nothing is tokenized here; the rows stay plain.
        let plain = service.colour(file, displayed: file.rows, until: .now - .seconds(1))
        XCTAssertEqual(plain, file.rows)
        await service.idle()
        XCTAssertFalse(service.isMissing(file, rows: file.rows))
        // Now everything comes from the cache, even past the deadline.
        let coloured = service.colour(file, displayed: file.rows, until: .now - .seconds(1))
        XCTAssertNotEqual(coloured, file.rows)

        let fresh = DiffSyntaxService()
        XCTAssertTrue(fresh.isMissing(file, rows: file.rows))
        XCTAssertEqual(fresh.colour(file, displayed: file.rows, until: .now + .seconds(5)), coloured)
        XCTAssertFalse(fresh.isMissing(file, rows: file.rows))
    }
}
