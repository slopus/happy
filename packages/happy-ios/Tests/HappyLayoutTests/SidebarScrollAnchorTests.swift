import Foundation
@testable import HappyLayout
import XCTest

final class SidebarScrollAnchorTests: XCTestCase {
    private let ids = (0..<20).map { "row:\($0)" }
    private var boxes: [CGRect] { (0..<20).map { CGRect(x: 0, y: $0 * 51, width: 390, height: 48) } }
    private let viewport = CGRect(x: 0, y: 265, width: 390, height: 200)

    private func anchor(_ next: [String]) -> Int? {
        SidebarScrollAnchor.index(previous: ids, next: next, boxes: boxes,
            nextBoxes: next.indices.map { CGRect(x: 0, y: $0 * 51, width: 390, height: 48) }, viewport: viewport)
    }

    func testUnchangedRowsKeepFirstPartiallyVisibleRow() { XCTAssertEqual(anchor(ids), 5) }
    func testInsertAboveDoesNotMistakeShiftedIndicesForMoves() { XCTAssertEqual(anchor(["new"] + ids), 5) }
    func testDeleteAboveKeepsFirstVisibleRow() { XCTAssertEqual(anchor(Array(ids.dropFirst())), 5) }
    func testDeletedAnchorUsesNextVisibleNeighbor() { XCTAssertEqual(anchor(ids.filter { $0 != ids[5] }), 6) }

    func testMovedAnchorUsesNextVisibleNeighbor() {
        var next = ids
        let moved = next.remove(at: 5)
        next.insert(moved, at: 13)
        XCTAssertEqual(anchor(next), 6)
    }

    func testAnchorMovedUpDoesNotPullViewportUp() {
        var next = ids
        let moved = next.remove(at: 5)
        next.insert(moved, at: 0)
        XCTAssertEqual(anchor(next), 6)
    }

    func testRowMovedAcrossViewportKeepsExistingAnchor() {
        var next = ids
        let moved = next.remove(at: 15)
        next.insert(moved, at: 2)
        XCTAssertEqual(anchor(next), 5)
    }

    func testAdjacentSwapDoesNotDragTheUnchangedVisibleGroup() {
        var next = ids
        next.swapAt(5, 6)
        XCTAssertEqual(anchor(next), 7)
    }

    func testDeletedVisibleGroupUsesFollowingNeighbor() {
        XCTAssertEqual(anchor(ids.filter { !ids[5...9].contains($0) }), 10)
    }

    func testDeletedTailUsesPrecedingNeighbor() { XCTAssertEqual(anchor(Array(ids.prefix(5))), 4) }
    func testEntireListReplacedHasNoAnchor() { XCTAssertNil(anchor(["new"])) }
    func testStaleFrameCountHasNoAnchor() {
        XCTAssertNil(SidebarScrollAnchor.index(previous: ids, next: ids, boxes: [], nextBoxes: boxes, viewport: viewport))
    }
}