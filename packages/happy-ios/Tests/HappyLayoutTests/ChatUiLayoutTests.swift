import XCTest
@testable import HappyLayout

/// Chat UI components and quick replies in an agent's message, in a
/// phone's 370 column.
final class ChatUiLayoutTests: XCTestCase {
    func testAFileTreeStepsIn16PerLevel() {
        let layout = ChatUiLayout(width: 370, input: .tree([(0, .fixed(width: 40, height: 18)), (1, .fixed(width: 60, height: 18))]))
        XCTAssertEqual(layout.rows, [
            .init(frame: CGRect(x: 0, y: 0, width: 370, height: 24), mark: CGRect(x: 0, y: 5, width: 14, height: 14), label: CGRect(x: 20, y: 3, width: 350, height: 18)),
            .init(frame: CGRect(x: 0, y: 24, width: 370, height: 24), mark: CGRect(x: 16, y: 29, width: 14, height: 14), label: CGRect(x: 36, y: 27, width: 334, height: 18)),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 48))
    }

    func testALineIsTheColumnWide() {
        let layout = ChatUiLayout(width: 370, input: .line(.fixed(width: 200, height: 48)))
        XCTAssertEqual(layout.label, CGRect(x: 0, y: 0, width: 370, height: 48))
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 48))
    }

    func testACardIsItsTitleItsLinesThenItsButtonsInsideItsBox() {
        let layout = ChatUiLayout(width: 370, input: .card(title: .fixed(width: 90, height: 20), lines: [.fixed(width: 200, height: 18), .fixed(width: 120, height: 36)],
                                                          buttons: [.fixed(width: 60, height: 20), .fixed(width: 80.4, height: 20)]))
        XCTAssertEqual(layout.card, CGRect(x: 0, y: 0, width: 370, height: 214))
        XCTAssertEqual(layout.label, CGRect(x: 12, y: 12, width: 346, height: 20))
        XCTAssertEqual(layout.lines, [CGRect(x: 12, y: 36, width: 346, height: 18), CGRect(x: 12, y: 58, width: 346, height: 36)])
        XCTAssertEqual(layout.buttons, [
            .init(frame: CGRect(x: 12, y: 106, width: 346, height: 44), label: CGRect(x: 155, y: 118, width: 60, height: 20)),
            .init(frame: CGRect(x: 12, y: 158, width: 346, height: 44), label: CGRect(x: 145, y: 170, width: 81, height: 20)),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 214))
        // Without buttons it closes 12 under its last line, and no card is wider than 420.
        XCTAssertEqual(ChatUiLayout(width: 768, input: .card(title: .fixed(width: 90, height: 20), lines: [], buttons: [])).size, CGSize(width: 420, height: 44))
    }

    func testPillsAreAsWideAsTheirLabelsAndWrap() {
        let layout = ChatUiLayout(width: 370, input: .pills([.fixed(width: 100, height: 20), .fixed(width: 150, height: 20), .fixed(width: 90, height: 20)]))
        XCTAssertEqual(layout.buttons, [
            .init(frame: CGRect(x: 0, y: 0, width: 128, height: 36), label: CGRect(x: 14, y: 8, width: 100, height: 20)),
            .init(frame: CGRect(x: 136, y: 0, width: 178, height: 36), label: CGRect(x: 150, y: 8, width: 150, height: 20)),
            .init(frame: CGRect(x: 0, y: 44, width: 118, height: 36), label: CGRect(x: 14, y: 52, width: 90, height: 20)),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 314, height: 80))
        // A label wider than the column wraps inside a column-wide pill.
        let long = ChatUiLayout(width: 200, input: .pills([Measurable { width in CGSize(width: width, height: 40) }]))
        XCTAssertEqual(long.buttons, [.init(frame: CGRect(x: 0, y: 0, width: 200, height: 56), label: CGRect(x: 14, y: 8, width: 172, height: 40))])
    }

    /// In a message, a component stands at the reading column's left, 8
    /// under what is before it.
    func testInAMessageItStandsAtTheColumnsLeft() {
        typealias M = MessageLayout.Metrics
        let layout = MessageLayout.agent(width: 402, parts: [.markdown([.text(.fixed(width: 100, height: 24))]), .ui(.line(.fixed(width: 100, height: 24)))])
        guard case .ui(let ui, let origin) = layout.parts[1] else { return XCTFail("no component") }
        XCTAssertEqual(origin, CGPoint(x: M.marginH, y: M.marginV + 24 + M.blockGap))
        XCTAssertEqual(ui.size, CGSize(width: 402 - 2 * M.marginH, height: 24))
        XCTAssertEqual(layout.size.height, M.marginV + 24 + M.blockGap + 24 + M.marginV)
    }
}
