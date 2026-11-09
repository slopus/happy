import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import XCTest
@testable import HappyLayout

/// A turn's own rows at desktop's measures (`agent-activity-row.css`,
/// `turn-summary.css`, `agent-trace-row.css`, `happy-agent-chat.css`).
final class TurnLayoutsTests: XCTestCase {
    private func height(_ value: CGFloat) -> Measurable { Measurable { CGSize(width: $0, height: value) } }

    // MARK: Tool rows

    func testAStandaloneSummaryUsesTheVerbLaneWithoutAnEmptyGap() {
        let row = ToolRowLayout(width: 390, verbWidth: 0, textWidth: 200)
        XCTAssertEqual(row.text, CGRect(x: 36, y: 6, width: 338, height: 20))
        XCTAssertEqual(row.glyph, CGRect(x: 16, y: 9, width: 14, height: 14))
    }

    func testAToolRowIsOneLineWithItsSubjectInTheRest() {
        let row = ToolRowLayout(width: 390, verbWidth: 40.3, textWidth: 200)
        XCTAssertEqual(row.size, CGSize(width: 390, height: 32))
        XCTAssertEqual(row.glyph, CGRect(x: 16, y: 9, width: 14, height: 14))
        XCTAssertEqual(row.verb, CGRect(x: 36, y: 6, width: 41, height: 20))
        XCTAssertEqual(row.text, CGRect(x: 83, y: 6, width: 291, height: 20))
        XCTAssertNil(row.added)
        XCTAssertNil(row.deleted)
    }

    func testAFileEditKeepsItsCountsBesideItsName() {
        let row = ToolRowLayout(width: 390, verbWidth: 40.3, textWidth: 100, addedWidth: 20.2, deletedWidth: 14)
        XCTAssertEqual(row.text, CGRect(x: 83, y: 6, width: 100, height: 20))
        XCTAssertEqual(row.added, CGRect(x: 189, y: 6, width: 21, height: 20))
        XCTAssertEqual(row.deleted, CGRect(x: 216, y: 6, width: 14, height: 20))
        // A long name gives way; the counts stay whole at the line's end.
        let long = ToolRowLayout(width: 390, verbWidth: 40.3, textWidth: 300, addedWidth: 20.2, deletedWidth: 14)
        XCTAssertEqual(long.text, CGRect(x: 83, y: 6, width: 244, height: 20))
        XCTAssertEqual(long.added, CGRect(x: 333, y: 6, width: 21, height: 20))
        XCTAssertEqual(long.deleted, CGRect(x: 360, y: 6, width: 14, height: 20))
    }

    func testAToolRowSitsInTheReadingColumn() {
        let row = ToolRowLayout(width: 1000, maxContentWidth: 700, verbWidth: 40, textWidth: 50)
        XCTAssertEqual(row.glyph.minX, 166)
        XCTAssertEqual(row.text.maxX, 834)
    }

    /// Desktop's `ConversationMedia` under a media call's line: 8 below the
    /// line's text, in the line's column, the row's own 6 under it.
    func testWhatACallShowedSitsUnderItsLine() {
        let line = ToolRowLayout(width: 390, verbWidth: 30, textWidth: 80)
        let screenshot = MediaLayout.Item(isVideo: false, image: MediaFlow.Image(width: 1228, height: 550, scale: nil))
        let result = ToolResultLayout(width: 390, line: line, parts: [.media([screenshot, screenshot], columns: 2)])
        XCTAssertEqual(result.line, line)
        guard result.body.parts.count == 1, case .media(let frames) = result.body.parts[0] else { return XCTFail("one grid") }
        let imageHeight: CGFloat = 175 * 550 / 1228
        XCTAssertEqual(frames.count, 2)
        for (frame, x) in zip(frames, [CGFloat(16), 199]) {
            assertFrame(frame, rect(x, 34, 175, imageHeight))
        }
        assertSize(result.size, CGSize(width: 390, height: 34 + imageHeight + 6))
    }

    // MARK: How a turn ended

    func testTheStatusLeadsWithItsCopyButton() {
        let status = TurnStatusLayout(width: 390, labelWidth: 130.2, copies: true, afterStep: false)
        XCTAssertEqual(status.size, CGSize(width: 390, height: 32))
        XCTAssertEqual(status.copy, CGRect(x: 14, y: 6, width: 20, height: 20))
        XCTAssertEqual(status.glyph, CGRect(x: 16, y: 8, width: 16, height: 16))
        XCTAssertEqual(status.label, CGRect(x: 42, y: 4, width: 131, height: 24))
    }

    func testAfterAStepTheStatusKeepsFourMore() {
        let status = TurnStatusLayout(width: 390, labelWidth: 130.2, copies: false, afterStep: true)
        XCTAssertEqual(status.size, CGSize(width: 390, height: 36))
        XCTAssertNil(status.copy)
        XCTAssertEqual(status.label, CGRect(x: 16, y: 8, width: 131, height: 24))
    }

    // MARK: The fold control

    func testTheControlNamesItsToolsAfterADot() {
        let trace = TraceLayout(width: 390, titleWidth: 66.1, statsWidth: 39.6)
        XCTAssertEqual(trace.size, CGSize(width: 390, height: 24))
        XCTAssertEqual(trace.title, CGRect(x: 16, y: 8, width: 67, height: 16))
        XCTAssertEqual(trace.dot, CGRect(x: 89, y: 15, width: 2, height: 2))
        XCTAssertEqual(trace.stats, CGRect(x: 97, y: 8, width: 40, height: 16))
        XCTAssertEqual(trace.hit, CGRect(x: 16, y: -2, width: 121, height: 36))
        let bare = TraceLayout(width: 390, titleWidth: 66.1, statsWidth: nil)
        XCTAssertNil(bare.dot)
        XCTAssertEqual(bare.hit, CGRect(x: 16, y: -2, width: 67, height: 36))
    }

    // MARK: Questions

    private func prompt(_ choices: [QuestionLayout.Choice]) -> QuestionLayout.Prompt {
        QuestionLayout.Prompt(header: CGSize(width: 60, height: 16), rule: CGSize(width: 70, height: 16), question: height(22), choices: choices)
    }

    func testAWaitingQuestionListsItsOptionsAndSubmit() {
        let layout = QuestionLayout(width: 390, prompts: [prompt([
            .init(label: height(19), description: height(16)), .init(label: height(19)),
        ])], buttonLabel: 40)
        let placed = layout.prompts[0]
        XCTAssertEqual(placed.header, CGRect(x: 16, y: 14, width: 60, height: 16))
        XCTAssertEqual(placed.rule, CGRect(x: 84, y: 14, width: 70, height: 16))
        XCTAssertEqual(placed.question, CGRect(x: 16, y: 33, width: 358, height: 22))
        XCTAssertEqual(placed.choices[0], .init(frame: CGRect(x: 4, y: 60, width: 382, height: 43), box: CGRect(x: 16, y: 72.5, width: 18, height: 18),
                                               label: CGRect(x: 43, y: 64, width: 331, height: 19), description: CGRect(x: 43, y: 83, width: 331, height: 16)))
        XCTAssertEqual(placed.choices[1], .init(frame: CGRect(x: 4, y: 105, width: 382, height: 32), box: CGRect(x: 16, y: 112, width: 18, height: 18),
                                               label: CGRect(x: 43, y: 111.5, width: 331, height: 19), description: nil))
        XCTAssertNil(layout.note)
        XCTAssertEqual(layout.button, CGRect(x: 318, y: 141, width: 60, height: 28))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 181))
    }

    func testAnAnswerThatDidNotGoSaysSoOverTheButton() {
        let layout = QuestionLayout(width: 390, prompts: [prompt([.init(label: height(19), description: height(16)), .init(label: height(19))])],
                                    buttonLabel: 40, note: height(16))
        XCTAssertEqual(layout.note, CGRect(x: 16, y: 141, width: 358, height: 16))
        XCTAssertEqual(layout.button, CGRect(x: 318, y: 161, width: 60, height: 28))
        XCTAssertEqual(layout.size.height, 201)
    }

    func testAnAnsweredQuestionShowsWhatWasAnswered() {
        let layout = QuestionLayout(width: 390, prompts: [prompt([.init(label: height(20))]), prompt([.init(label: height(20), description: height(16))])], buttonLabel: nil)
        XCTAssertNil(layout.button)
        XCTAssertEqual(layout.prompts[0].choices[0], .init(frame: CGRect(x: 4, y: 60, width: 382, height: 30), box: nil, label: CGRect(x: 16, y: 65, width: 358, height: 20), description: nil))
        // The next prompt 8 under the last answer.
        XCTAssertEqual(layout.prompts[1].header.minY, 90 + 8 + 6)
        XCTAssertEqual(layout.prompts[1].choices[0].frame, CGRect(x: 4, y: 150, width: 382, height: 46))
        XCTAssertEqual(layout.size.height, 204)
    }
}
