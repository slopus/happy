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

    /// The replies stand at the column's left, as the agent's words do,
    /// every pill as wide as the widest option's own width, so the stack
    /// reads as one; a long option takes a person's widest bubble at most.
    func testRepliesAreOneUnderAnotherAsWideAsTheWidestCappedAtAPersonsWidestBubble() {
        // A 370 column in a 402 row: a person's widest bubble is 402 - 16 - 36 = 350.
        let layout = ChatUiLayout(width: 370, input: .replies([.fixed(width: 100, height: 24), .fixed(width: 400, height: 24)]))
        XCTAssertEqual(layout.buttons, [
            .init(frame: CGRect(x: 0, y: 0, width: 350, height: 44), label: CGRect(x: 12, y: 10, width: 302, height: 24), tick: CGRect(x: 322, y: 14, width: 16, height: 16)),
            .init(frame: CGRect(x: 0, y: 50, width: 350, height: 44), label: CGRect(x: 12, y: 60, width: 302, height: 24), tick: CGRect(x: 322, y: 64, width: 16, height: 16)),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 94))
        let row = MessageLayout.user(width: 402, text: .fixed(width: 1000, height: 24), showsStatus: false)
        XCTAssertEqual(row.bubble?.width, 350)
    }

    /// Short options make a narrow stack: 12 in, the widest option's
    /// words, then the 8 + 16 kept for the tick a sent one shows.
    func testShortRepliesAreTheWidestOptionWideWithTheTicksRoom() {
        let layout = ChatUiLayout(width: 370, input: .replies([.fixed(width: 100, height: 24), .fixed(width: 60.2, height: 24)]))
        XCTAssertEqual(layout.buttons, [
            .init(frame: CGRect(x: 0, y: 0, width: 148, height: 44), label: CGRect(x: 12, y: 10, width: 100, height: 24), tick: CGRect(x: 120, y: 14, width: 16, height: 16)),
            .init(frame: CGRect(x: 0, y: 50, width: 148, height: 44), label: CGRect(x: 12, y: 60, width: 100, height: 24), tick: CGRect(x: 120, y: 64, width: 16, height: 16)),
        ])
    }

    /// A label too long for a phone's stack wraps to a second line and
    /// only its own pill grows; the rest keep one line, all one width.
    /// iPhone SE (375 wide, a 343 column) and iPhone 12 (390, 358).
    func testALongLabelWrapsToTwoLinesInItsOwnPillOnAnSEAndA12() {
        // 8 wide per character, 24 a line.
        func words(_ count: Int) -> Measurable {
            Measurable { width in
                let lines = max(1, Int((CGFloat(count * 8) / max(1, width)).rounded(.up)))
                return CGSize(width: min(CGFloat(count * 8), width), height: CGFloat(min(lines, 2) * 24))
            }
        }
        for (column, pill) in [(CGFloat(343), CGFloat(323)), (358, 338)] {
            let layout = ChatUiLayout(width: column, input: .replies([words(60), words(18)]))
            let frames = layout.buttons.map(\.frame)
            XCTAssertEqual(frames.map(\.width), [pill, pill], "\(column)")
            XCTAssertEqual(frames.map(\.minX), [0, 0])
            // 10 + two lines + 10; then 10 + one line + 10.
            XCTAssertEqual(frames.map(\.height), [68, 44], "\(column)")
            XCTAssertEqual(layout.buttons[0].label.width, pill - 12 - 24 - 12)
        }
    }

    /// At a larger text size a pill grows by its one line, keeping its
    /// padding, and its tick stays centred in it.
    func testRepliesGrowWithTheTextSizeByTheirOneLine() {
        let layout = ChatUiLayout(width: 370, input: .replies([.fixed(width: 100, height: 37), .fixed(width: 100, height: 37)]))
        XCTAssertEqual(layout.buttons, [
            .init(frame: CGRect(x: 0, y: 0, width: 148, height: 57), label: CGRect(x: 12, y: 10, width: 100, height: 37), tick: CGRect(x: 120, y: 21, width: 16, height: 16)),
            .init(frame: CGRect(x: 0, y: 63, width: 148, height: 57), label: CGRect(x: 12, y: 73, width: 100, height: 37), tick: CGRect(x: 120, y: 84, width: 16, height: 16)),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 370, height: 120))
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
