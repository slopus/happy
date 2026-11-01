import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// New work's empty conversation: Task or Bot over a name and a note on
/// Happy Agent, the computer and folder rows on a legacy account, one
/// block centred between the bar's foot and the composer's top, whatever
/// the keyboard has done to the composer.
final class NewWorkLayoutTests: XCTestCase {
    private typealias M = NewWorkLayout.Metrics
    /// A note that wraps to two 20pt lines at any width.
    private let note = Measurable { CGSize(width: $0, height: 40) }

    private func work(width: CGFloat = 393, top: CGFloat = 106, bottom: CGFloat) -> NewWorkLayout {
        NewWorkLayout(width: width, top: top, bottom: bottom, kindHeight: 32, rows: 1, note: note)
    }

    func testTheWorkBlockIsCentredBetweenTheBarAndTheComposer() {
        // Keyboard down, then up: the composer's top moves, the block follows.
        for bottom: CGFloat in [760, 420] {
            let layout = work(bottom: bottom)
            XCTAssertTrue(layout.fits)
            XCTAssertEqual(layout.block.midY, (106 + bottom) / 2, accuracy: 0.001, "bottom \(bottom)")
            XCTAssertEqual(layout.block.midX, 393 / 2, accuracy: 0.001)
        }
    }

    func testTheKindSitsOverTheNameAndTheNoteUnderIt() throws {
        let layout = work(bottom: 760)
        let kind = try XCTUnwrap(layout.kind)
        XCTAssertEqual(kind, CGRect(x: (320 - M.kindWidth) / 2, y: 0, width: M.kindWidth, height: 32))
        XCTAssertEqual(layout.rows, [CGRect(x: 0, y: 32 + M.kindToRows, width: 320, height: M.rowHeight)])
        let note = try XCTUnwrap(layout.note)
        XCTAssertEqual(note, CGRect(x: 0, y: 32 + M.kindToRows + M.rowHeight + M.rowsToNote, width: 320, height: 40))
        XCTAssertEqual(layout.block.height, note.maxY)
        XCTAssertEqual(layout.block.width, M.maxWidth)
    }

    /// A narrow screen: the block keeps its side margins, the control no
    /// wider than the block.
    func testANarrowScreenKeepsTheSides() throws {
        let layout = work(width: 240, bottom: 760)
        XCTAssertEqual(layout.block.minX, M.side)
        XCTAssertEqual(layout.block.width, 240 - 2 * M.side)
        XCTAssertEqual(try XCTUnwrap(layout.kind).width, 240 - 2 * M.side)
    }

    /// A 430pt Pro Max: still at most 320 wide, in the middle.
    func testAWideScreenCentresAtMostTheMaxWidth() {
        let layout = work(width: 430, top: 110, bottom: 520)
        XCTAssertEqual(layout.block.width, M.maxWidth)
        XCTAssertEqual(layout.block.minX, (430 - M.maxWidth) / 2)
        XCTAssertEqual(layout.block.midY, (110 + 520) / 2, accuracy: 0.001)
    }

    /// Too little room (a landscape phone with the keyboard up): it doesn't
    /// fit and is hidden, laid out from the bar rather than over it.
    func testTooLittleRoomDoesNotFit() {
        let height = 32 + M.kindToRows + M.rowHeight + M.rowsToNote + 40
        let edge = work(top: 100, bottom: 100 + height + 2 * M.margin)
        XCTAssertTrue(edge.fits)
        let short = work(top: 100, bottom: 100 + height + 2 * M.margin - 1)
        XCTAssertFalse(short.fits)
        XCTAssertEqual(short.block.minY, 100 + M.margin)
    }

    /// Legacy with one computer: folder and harness, no kind or note.
    func testOneComputerAsksTheFolderAndHarness() {
        let layout = NewWorkLayout(width: 393, top: 106, bottom: 420, kindHeight: nil, rows: 2, note: nil)
        XCTAssertNil(layout.kind)
        XCTAssertNil(layout.note)
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: 0, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: M.rowHeight + M.rowGap, width: 320, height: M.rowHeight),
        ])
        XCTAssertEqual(layout.block.height, 2 * M.rowHeight + M.rowGap)
        XCTAssertEqual(layout.block.midY, (106 + 420) / 2, accuracy: 0.001)
    }

    /// Legacy with two: computer, folder, harness, with gaps between.
    func testTwoComputersAskTheComputerOverTheFolderAndHarness() {
        let layout = NewWorkLayout(width: 393, top: 106, bottom: 420, kindHeight: nil, rows: 3, note: nil)
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: 0, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: M.rowHeight + M.rowGap, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: 2 * (M.rowHeight + M.rowGap), width: 320, height: M.rowHeight),
        ])
        XCTAssertEqual(layout.block.height, 3 * M.rowHeight + 2 * M.rowGap)
        XCTAssertEqual(layout.block.midY, (106 + 420) / 2, accuracy: 0.001)
    }
}
