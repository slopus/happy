import XCTest
@testable import HappyLayout

/// Chat UI components in an agent's message, in a phone's 370 column.
final class ChatUiLayoutTests: XCTestCase {
    private func button(_ width: CGFloat, glyph: Bool = false) -> ChatUiLayout.ButtonInput {
        ChatUiLayout.ButtonInput(label: .fixed(width: width, height: 20), glyph: glyph)
    }

    func testAChoiceIsItsButtonsOneUnderAnotherWithTheChosenTickBeforeItsLabel() {
        let layout = ChatUiLayout(width: 370, input: .buttons([button(100.2), button(80, glyph: true)]))
        XCTAssertEqual(layout.buttons, [
            .init(frame: CGRect(x: 0, y: 0, width: 370, height: 44), label: CGRect(x: 135, y: 12, width: 101, height: 20), glyph: nil),
            .init(frame: CGRect(x: 0, y: 52, width: 370, height: 44), label: CGRect(x: 156, y: 64, width: 80, height: 20), glyph: CGRect(x: 134, y: 66, width: 16, height: 16)),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 96))
    }

    func testALongLabelWrapsAndItsButtonGrowsAndNoControlIsWiderThan420() {
        let label = Measurable { width in CGSize(width: width, height: 60) }
        let layout = ChatUiLayout(width: 768, input: .buttons([.init(label: label)]))
        XCTAssertEqual(layout.buttons.first?.frame, CGRect(x: 0, y: 0, width: 420, height: 80))
        XCTAssertEqual(layout.buttons.first?.label, CGRect(x: 16, y: 10, width: 388, height: 60))
    }

    func testAChecklistIsItsRowsThenItsSubmit() {
        let layout = ChatUiLayout(width: 370, input: .checklist([
            .init(label: .fixed(width: 60, height: 24)),
            .init(label: .fixed(width: 60, height: 24), detail: .fixed(width: 100, height: 18)),
        ], submit: button(70)))
        XCTAssertEqual(layout.rows, [
            .init(frame: CGRect(x: 0, y: 0, width: 370, height: 40), mark: CGRect(x: 0, y: 10, width: 20, height: 20), label: CGRect(x: 30, y: 8, width: 340, height: 24), detail: nil),
            .init(frame: CGRect(x: 0, y: 40, width: 370, height: 60), mark: CGRect(x: 0, y: 50, width: 20, height: 20), label: CGRect(x: 30, y: 48, width: 340, height: 24),
                  detail: CGRect(x: 30, y: 74, width: 340, height: 18)),
        ])
        XCTAssertEqual(layout.buttons, [.init(frame: CGRect(x: 0, y: 108, width: 370, height: 44), label: CGRect(x: 150, y: 120, width: 70, height: 20), glyph: nil)])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 152))
    }

    func testATextFieldIsItsLabelItsBoxAndItsSubmit() {
        let layout = ChatUiLayout(width: 370, input: .field(label: .fixed(width: 80, height: 18), value: .fixed(width: 120, height: 24), submit: button(50)))
        XCTAssertEqual(layout.label, CGRect(x: 0, y: 0, width: 370, height: 18))
        XCTAssertEqual(layout.field, CGRect(x: 0, y: 24, width: 370, height: 44))
        XCTAssertEqual(layout.value, CGRect(x: 12, y: 34, width: 346, height: 24))
        XCTAssertEqual(layout.buttons, [.init(frame: CGRect(x: 0, y: 76, width: 370, height: 44), label: CGRect(x: 160, y: 88, width: 50, height: 20), glyph: nil)])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 120))
    }

    func testAFileTreeStepsIn16PerLevel() {
        let layout = ChatUiLayout(width: 370, input: .tree([(0, .fixed(width: 40, height: 18)), (1, .fixed(width: 60, height: 18))]))
        XCTAssertEqual(layout.rows, [
            .init(frame: CGRect(x: 0, y: 0, width: 370, height: 24), mark: CGRect(x: 0, y: 5, width: 14, height: 14), label: CGRect(x: 20, y: 3, width: 350, height: 18), detail: nil),
            .init(frame: CGRect(x: 0, y: 24, width: 370, height: 24), mark: CGRect(x: 16, y: 29, width: 14, height: 14), label: CGRect(x: 36, y: 27, width: 334, height: 18), detail: nil),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 48))
    }

    func testALineIsTheColumnWide() {
        let layout = ChatUiLayout(width: 370, input: .line(.fixed(width: 200, height: 48)))
        XCTAssertEqual(layout.label, CGRect(x: 0, y: 0, width: 370, height: 48))
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 48))
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
