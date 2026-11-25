import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// A carried home row: its picture under the finger, kept in the list's
/// view; its place among its peers; and the list scrolling under it near
/// the view's edges.
final class SidebarCarryLayoutTests: XCTestCase {
    private let box = CGRect(x: 16, y: 100, width: 358, height: 52)

    func testThePictureFollowsTheFingerInsideTheList() {
        XCTAssertEqual(SidebarCarryLayout.frame(box: box, grab: 20, finger: 300, top: 100, bottom: 800), CGRect(x: 16, y: 280, width: 358, height: 52))
        XCTAssertEqual(SidebarCarryLayout.frame(box: box, grab: 20, finger: 50, top: 100, bottom: 800).minY, 100, "above the list")
        XCTAssertEqual(SidebarCarryLayout.frame(box: box, grab: 20, finger: 900, top: 100, bottom: 800).minY, 748, "below the list")
    }

    /// It passes a peer when its middle passes the peer's, a peer with
    /// subtasks under it counted whole.
    func testItsPlaceIsThePeersWhoseMiddleItIsBelow() {
        let peers: [ClosedRange<CGFloat>] = [0...52, 52...156, 156...208]
        XCTAssertEqual(SidebarCarryLayout.place(center: 10, peers: peers), 0)
        XCTAssertEqual(SidebarCarryLayout.place(center: 27, peers: peers), 1)
        XCTAssertEqual(SidebarCarryLayout.place(center: 103, peers: peers), 1)
        XCTAssertEqual(SidebarCarryLayout.place(center: 105, peers: peers), 2)
        XCTAssertEqual(SidebarCarryLayout.place(center: 300, peers: peers), 3)
    }

    /// Faster the nearer the edge, none in the middle.
    func testTheListScrollsNearTheViewsEdges() {
        func speed(_ y: CGFloat) -> CGFloat {
            SidebarCarryLayout.scrollSpeed(frame: CGRect(x: 16, y: y, width: 358, height: 52), top: 100, bottom: 800)
        }
        XCTAssertEqual(speed(100), -900)
        XCTAssertEqual(speed(136), -225)
        XCTAssertEqual(speed(172), 0)
        XCTAssertEqual(speed(400), 0)
        XCTAssertEqual(speed(676), 0)
        XCTAssertEqual(speed(712), 225)
        XCTAssertEqual(speed(748), 900)
    }
}
