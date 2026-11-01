import XCTest
@testable import HappyLayout

final class MessageLiftLayoutTests: XCTestCase {
    private let screen = CGSize(width: 402, height: 874)
    private let menu = CGSize(width: 220, height: 150)

    func testAShortMessageStaysWhereItWasWithTheMenuUnderItsTrailingEdge() {
        let layout = MessageLiftLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 180, y: 400, width: 210, height: 60), menu: menu, side: .trailing)
        XCTAssertEqual(layout.viewport, CGRect(x: 180, y: 400, width: 210, height: 60))
        XCTAssertEqual(layout.offset, 0)
        XCTAssertEqual(layout.contentHeight, 60)
        // 390 - 7 - 220.
        XCTAssertEqual(layout.menu, CGRect(x: 163, y: 467, width: 220, height: 150))
    }

    func testAMessageNearTheFootMovesUpWithItsMenu() {
        let layout = MessageLiftLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 16, y: 700, width: 300, height: 80), menu: menu, side: .leading)
        // 874 - 34 - 10 - 150 - 7 - 80.
        XCTAssertEqual(layout.viewport, CGRect(x: 16, y: 593, width: 300, height: 80))
        XCTAssertEqual(layout.menu, CGRect(x: 18, y: 680, width: 220, height: 150))
    }

    func testAMessageAboveTheTopComesDownUnderIt() {
        let layout = MessageLiftLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 16, y: 20, width: 300, height: 40), menu: menu, side: .leading)
        XCTAssertEqual(layout.viewport, CGRect(x: 16, y: 70, width: 300, height: 40))
        XCTAssertEqual(layout.menu, CGRect(x: 18, y: 117, width: 220, height: 150))
    }

    func testATallMessageIsCutToTheRoomAndScrollsFromWhatWasOnScreen() {
        let layout = MessageLiftLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 16, y: -1500, width: 370, height: 3000), menu: menu, side: .leading)
        // 830 - 70 - 157 tall, at the top.
        XCTAssertEqual(layout.viewport, CGRect(x: 16, y: 70, width: 370, height: 603))
        XCTAssertEqual(layout.contentHeight, 3000)
        // The part that was at y 70 stays there.
        XCTAssertEqual(layout.offset, 1570)
        XCTAssertEqual(layout.menu, CGRect(x: 18, y: 680, width: 220, height: 150))
    }

    func testATallMessageOnAShortScreenStartsAtItsTop() {
        let layout = MessageLiftLayout(screen: CGSize(width: 375, height: 667), top: 20, bottom: 0, source: CGRect(x: 16, y: 100, width: 343, height: 1000), menu: menu, side: .leading)
        XCTAssertEqual(layout.viewport, CGRect(x: 16, y: 28, width: 343, height: 472))
        XCTAssertEqual(layout.offset, 0)
    }

    func testTheMenuKeepsTwelveFromTheSides() {
        let layout = MessageLiftLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 300, y: 300, width: 90, height: 40), menu: menu, side: .leading)
        XCTAssertEqual(layout.menu.minX, 170)
    }

    func testWithoutAMenuOnlyTheMessageKeepsClearOfTheFoot() {
        let layout = MessageLiftLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 16, y: 820, width: 300, height: 40), menu: .zero, side: .leading)
        XCTAssertEqual(layout.viewport, CGRect(x: 16, y: 790, width: 300, height: 40))
    }

    func testTheSideIsWhereTheMessagesMiddleIs() {
        XCTAssertEqual(MessageLiftLayout.side(of: CGRect(x: 16, y: 0, width: 370, height: 10), in: 402), .leading)
        XCTAssertEqual(MessageLiftLayout.side(of: CGRect(x: 200, y: 0, width: 190, height: 10), in: 402), .trailing)
    }
}

final class SelectionGeometryTests: XCTestCase {
    func testLinesAFewPointsApartMeetHalfway() {
        let joined = SelectionGeometry.joined([
            CGRect(x: 0, y: 0, width: 50, height: 20),
            CGRect(x: 0, y: 22, width: 80, height: 20),
            CGRect(x: 0, y: 50, width: 30, height: 20),
        ])
        XCTAssertEqual(joined, [
            CGRect(x: 0, y: 0, width: 50, height: 21),
            CGRect(x: 0, y: 21, width: 80, height: 21),
            // Eight apart: another block, left alone.
            CGRect(x: 0, y: 50, width: 30, height: 20),
        ])
    }

    func testTheHandlesStandOnTheSelectionsEnds() {
        XCTAssertEqual(SelectionGeometry.startKnob(edge: CGRect(x: 10.5, y: 30, width: 0, height: 20)), CGRect(x: 4, y: 18, width: 12, height: 32))
        XCTAssertEqual(SelectionGeometry.endKnob(edge: CGRect(x: 40, y: 50, width: 60.3, height: 20)), CGRect(x: 94, y: 50, width: 12, height: 32))
    }

    func testATouchTakesTheNearestHandleByTheMiddleOfItsLine() {
        let start = CGRect(x: 4, y: 18, width: 12, height: 32)
        let end = CGRect(x: 94, y: 50, width: 12, height: 32)
        let close = SelectionGeometry.knob(at: CGPoint(x: 10, y: 10), start: start, end: end)
        XCTAssertEqual(close?.knob, .start)
        XCTAssertEqual(close?.grab, CGPoint(x: 10, y: 40))
        let reached = SelectionGeometry.knob(at: CGPoint(x: 29, y: 34), start: start, end: end)
        XCTAssertEqual(reached?.knob, .start)
        let byEnd = SelectionGeometry.knob(at: CGPoint(x: 100, y: 90), start: start, end: end)
        XCTAssertEqual(byEnd?.knob, .end)
        XCTAssertEqual(byEnd?.grab, CGPoint(x: 100, y: 60))
        XCTAssertNil(SelectionGeometry.knob(at: CGPoint(x: 200, y: 200), start: start, end: end))
    }

    func testOneCharactersHandlesGoToTheNearerDot() {
        // A hyphen selected: the handles stand 6 apart on a 25 line at y 100.
        let start = SelectionGeometry.startKnob(edge: CGRect(x: 40, y: 100, width: 0, height: 25))
        let end = SelectionGeometry.endKnob(edge: CGRect(x: 46, y: 100, width: 0, height: 25))
        XCTAssertEqual(SelectionGeometry.knob(at: CGPoint(x: 46, y: 133), start: start, end: end)?.knob, .end)
        XCTAssertEqual(SelectionGeometry.knob(at: CGPoint(x: 40, y: 92), start: start, end: end)?.knob, .start)
    }

    func testTheMenuPointsAtTheWholeSelectionTwelveClear() {
        XCTAssertEqual(SelectionGeometry.menuAnchor([CGRect(x: 0, y: 0, width: 50, height: 20), CGRect(x: 0, y: 20, width: 80, height: 20)]), CGRect(x: 0, y: -12, width: 80, height: 64))
        XCTAssertNil(SelectionGeometry.menuAnchor([]))
    }
}

final class SelectionTextTests: XCTestCase {
    private let text = SelectionText([
        .init("Intro text."),
        .init("first", lead: "• "),
        .init("second", lead: "• ", joiner: "\n"),
        .init("let x = 1"),
    ])

    func testThePiecesAreOneRun() {
        XCTAssertEqual(text.starts, [0, 11, 16, 22])
        XCTAssertEqual(text.length, 31)
        XCTAssertEqual(text.locate(11)?.piece, 1)
        XCTAssertEqual(text.locate(11)?.offset, 0)
        XCTAssertEqual(text.locate(31)?.piece, 3)
        XCTAssertEqual(text.locate(31)?.offset, 9)
        XCTAssertEqual(text.locate(-5)?.offset, 0)
        XCTAssertEqual(text.split(9..<18).map(\.range), [9..<11, 0..<5, 0..<2])
    }

    func testCopyingAllOfItPutsBackTheBreaksAndTheMarkers() {
        XCTAssertEqual(text.copy(0..<31), "Intro text.\n\n• first\n• second\n\nlet x = 1")
    }

    func testAMarkerComesOnlyWithTheStartOfItsItem() {
        XCTAssertEqual(text.copy(6..<14), "text.\n\n• fir")
        XCTAssertEqual(text.copy(13..<19), "rst\n• sec")
        XCTAssertEqual(text.copy(12..<14), "ir")
    }

    func testCharactersAreCountedAsTheLayoutCountsThem() {
        let wave = SelectionText([.init("héllo 👋 there")])
        XCTAssertEqual(wave.length, 14)
        XCTAssertEqual(wave.copy(6..<8), "👋")
    }
}
