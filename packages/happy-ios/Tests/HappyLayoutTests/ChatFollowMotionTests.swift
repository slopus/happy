import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class ChatFollowMotionTests: XCTestCase {
    /// Ease-out over 0.4 s: it starts at speed, so a follow that begins
    /// while another is moving never stops the list first.
    func testTimingIsEaseOut() {
        XCTAssertEqual(ChatFollowMotion.duration, 0.4)
        let points = ChatFollowMotion.controlPoints
        XCTAssertEqual([points.x1, points.y1, points.x2, points.y2], [0, 0, 0.58, 1])
    }

    // MARK: Rows added at the newest end

    func testASentMessageIsANewestInsert() {
        XCTAssertEqual(ChatFollowMotion.newestInserts(old: ["b", "c"], new: ["a", "b", "c"]), ["a"])
    }

    func testSeveralRowsAtOnceKeepTheirOrder() {
        XCTAssertEqual(ChatFollowMotion.newestInserts(old: ["c"], new: ["a", "b", "c"]), ["a", "b"])
    }

    func testAnUnchangedMembershipAddsNothing() {
        XCTAssertEqual(ChatFollowMotion.newestInserts(old: ["a", "b"], new: ["a", "b"]), [])
        XCTAssertEqual(ChatFollowMotion.newestInserts(old: [], new: []), [])
    }

    func testTheFirstRowsOfAnEmptyChat() {
        XCTAssertEqual(ChatFollowMotion.newestInserts(old: [], new: ["a", "b"]), ["a", "b"])
    }

    func testARowAddedFurtherBackIsNotOne() {
        XCTAssertNil(ChatFollowMotion.newestInserts(old: ["a", "c"], new: ["a", "b", "c"]))
        XCTAssertNil(ChatFollowMotion.newestInserts(old: ["a"], new: ["x", "a", "y"]))
    }

    /// A turn folding its tools into a work group removes rows.
    func testARemovalIsNotOne() {
        XCTAssertNil(ChatFollowMotion.newestInserts(old: ["a", "b", "c"], new: ["a", "c"]))
        XCTAssertNil(ChatFollowMotion.newestInserts(old: ["a", "b"], new: ["x", "a"]))
    }

    func testAMoveIsNotOne() {
        XCTAssertNil(ChatFollowMotion.newestInserts(old: ["a", "b"], new: ["b", "a"]))
    }

    // MARK: How far what the reader sees moves

    private func layout(_ heights: [CGFloat]) -> ChatListLayout {
        ChatListLayout(width: 390, heights: heights, newerEndHeight: 6, olderEndHeight: 40)
    }

    /// A streamed reply, row 0, grows a line: everything above it moves up
    /// by that line.
    func testAGrowingNewestRowShiftsByItsGrowth() {
        let old = layout([100, 80, 80, 80])
        let new = layout([120, 80, 80, 80])
        XCTAssertEqual(ChatFollowMotion.shift(from: old, ids: ["r", "a", "b", "c"], to: new, ids: ["r", "a", "b", "c"], visibleHeight: 300), 20)
    }

    func testAnInsertShiftsByTheNewRow() {
        let old = layout([100, 80, 80])
        let new = layout([81, 100, 80, 80])
        XCTAssertEqual(ChatFollowMotion.shift(from: old, ids: ["a", "b", "c"], to: new, ids: ["n", "a", "b", "c"], visibleHeight: 300), 81)
    }

    func testAShrinkingRowShiftsBack() {
        let old = layout([120, 80])
        let new = layout([109, 80])
        XCTAssertEqual(ChatFollowMotion.shift(from: old, ids: ["r", "a"], to: new, ids: ["r", "a"], visibleHeight: 600), -11)
    }

    /// A newest row taller than the screen is the only one on it: its far
    /// edge moves by its growth, so its lines run up the screen.
    func testATallNewestRowAlone() {
        let old = layout([900, 80])
        let new = layout([925, 80])
        XCTAssertEqual(ChatFollowMotion.shift(from: old, ids: ["r", "a"], to: new, ids: ["r", "a"], visibleHeight: 500), 25)
    }

    /// The reference is the oldest row on screen; one further back that
    /// changed doesn't count.
    func testRowsPastTheScreenDoNotCount() {
        let old = layout([100, 100, 100, 100])
        let new = layout([100, 100, 100, 140])
        XCTAssertEqual(ChatFollowMotion.shift(from: old, ids: ["a", "b", "c", "d"], to: new, ids: ["a", "b", "c", "d"], visibleHeight: 250), 0)
    }

    func testNothingOnScreenSurvives() {
        let old = layout([100])
        let new = layout([100])
        XCTAssertNil(ChatFollowMotion.shift(from: old, ids: ["a"], to: new, ids: ["b"], visibleHeight: 300))
        XCTAssertNil(ChatFollowMotion.shift(from: layout([]), ids: [], to: new, ids: ["b"], visibleHeight: 300))
    }
}
