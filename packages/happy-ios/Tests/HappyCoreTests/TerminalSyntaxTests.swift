import Foundation
import XCTest
@testable import HappyCore

/// CommandView's `syntaxHighlighting`: which text is coloured as what, and
/// SyntaxText's reveal gate over the shared cache.
final class TerminalSyntaxTests: XCTestCase {
    private let command = "echo \"$HOME\" | grep -v tmp # where"

    private func flat(_ spans: [(text: String, kind: DiffSpanKind)]?) -> [String]? {
        spans?.map { "\($0.kind.rawValue):\($0.text)" }
    }

    func testOnlyARealCommandIsBash() {
        XCTAssertEqual(TerminalSyntax.commandLanguage(prompt: true), "bash")
        // The activity label shown in place of a command.
        XCTAssertNil(TerminalSyntax.commandLanguage(prompt: false))
        XCTAssertNil(TerminalSyntax.spans("Running tests", language: nil, until: .now + .seconds(5), service: DiffSyntaxService()))
        XCTAssertEqual(TerminalSyntax.outputLanguage, "shell-session")
    }

    func testBeforeTheDeadlineTheCommandIsColouredHereAndCached() throws {
        let service = DiffSyntaxService()
        let spans = try XCTUnwrap(TerminalSyntax.spans(command, language: "bash", until: .now + .seconds(5), service: service))
        XCTAssertEqual(spans.map(\.text).joined(), command)
        XCTAssertTrue(spans.contains { $0.kind == .comment && $0.text == "# where" })
        XCTAssertTrue(spans.contains { $0.kind == .string })
        let plan = try XCTUnwrap(DiffSyntaxPlan.planCode(command, language: "bash"))
        XCTAssertNotNil(service.peek(plan.key))
    }

    func testPastTheDeadlineItStaysPlainAndTheNextPlanIsColoured() async throws {
        let service = DiffSyntaxService()
        XCTAssertNil(TerminalSyntax.spans(command, language: "bash", until: .now - .seconds(1), service: service))
        await service.idle()
        // From the cache, whatever the deadline.
        let late = TerminalSyntax.spans(command, language: "bash", until: .now - .seconds(1), service: service)
        let fresh = TerminalSyntax.spans(command, language: "bash", until: .now + .seconds(5), service: DiffSyntaxService())
        XCTAssertNotNil(late)
        XCTAssertEqual(flat(late), flat(fresh))
    }

    func testOutputWithNothingToColourStaysPlain() {
        let service = DiffSyntaxService()
        XCTAssertNil(TerminalSyntax.spans("ordinary output\n", language: TerminalSyntax.outputLanguage, until: .now + .seconds(5), service: service))
        XCTAssertNil(TerminalSyntax.spans("", language: TerminalSyntax.outputLanguage, until: .now + .seconds(5), service: service))
    }

    func testAShellSessionsPromptLinesAreColoured() throws {
        let output = "$ ls -la\ntotal 0\n"
        let spans = try XCTUnwrap(TerminalSyntax.spans(output, language: TerminalSyntax.outputLanguage, until: .now + .seconds(5), service: DiffSyntaxService()))
        XCTAssertEqual(spans.map(\.text).joined(), output)
        XCTAssertTrue(spans.contains { $0.kind != .plain })
    }
}
