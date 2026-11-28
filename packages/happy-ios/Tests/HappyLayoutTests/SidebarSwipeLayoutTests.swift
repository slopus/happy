import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for a home row's swipe to Archive: the content slides
/// inside the card, the action grows in from the card's trailing edge, and
/// its label crosses to the content's edge once letting go archives.
final class SidebarSwipeLayoutTests: XCTestCase {
    private let card = CGSize(width: 358, height: 52)
    private let icon = CGSize(width: 22, height: 22)
    private let title = CGSize(width: 44, height: 16)

    func testTheMeasures() {
        XCTAssertEqual(SidebarSwipeLayout.actionWidth, 84)
        XCTAssertEqual(SidebarSwipeLayout.fullFraction, 0.55)
        XCTAssertEqual(SidebarSwipeLayout.fullThreshold(width: 358), 197)
        XCTAssertEqual(SidebarSwipeLayout.fullThreshold(width: 100), 85, "a narrow card still opens on its action before it archives")
    }

    /// Short of the action's width, the label stands in what shows.
    func testAShortSwipeShowsTheActionAsFarAsTheFinger() {
        let frames = SidebarSwipeLayout.frames(box: card, reveal: 40, full: false, icon: icon, title: title)
        XCTAssertEqual(frames.offset, -40)
        XCTAssertEqual(frames.action, CGRect(x: 318, y: 0, width: 40, height: 52))
        XCTAssertEqual(frames.icon, CGRect(x: 9, y: 5, width: 22, height: 22))
        XCTAssertEqual(frames.title, CGRect(x: -2, y: 31, width: 44, height: 16))
    }

    /// Past the action's width the label keeps to the card's trailing edge.
    func testALongerSwipeKeepsTheLabelAtTheTrailingEdge() {
        let frames = SidebarSwipeLayout.frames(box: card, reveal: 150, full: false, icon: icon, title: title)
        XCTAssertEqual(frames.offset, -150)
        XCTAssertEqual(frames.action, CGRect(x: 208, y: 0, width: 150, height: 52))
        XCTAssertEqual(frames.icon, CGRect(x: 97, y: 5, width: 22, height: 22))
        XCTAssertEqual(frames.title, CGRect(x: 86, y: 31, width: 44, height: 16))
    }

    /// Full, the label rides at the content's edge.
    func testAFullSwipeMovesTheLabelToTheContentsEdge() {
        let frames = SidebarSwipeLayout.frames(box: card, reveal: 250, full: true, icon: icon, title: title)
        XCTAssertEqual(frames.action, CGRect(x: 108, y: 0, width: 250, height: 52))
        XCTAssertEqual(frames.icon, CGRect(x: 31, y: 5, width: 22, height: 22))
        XCTAssertEqual(frames.title, CGRect(x: 20, y: 31, width: 44, height: 16))
    }

    func testTheFingerNeverShowsPastTheCardOrBackPastClosed() {
        XCTAssertEqual(SidebarSwipeLayout.shown(-5, width: 358), 0)
        XCTAssertEqual(SidebarSwipeLayout.shown(400, width: 358), 358)
        XCTAssertEqual(SidebarSwipeLayout.frames(box: card, reveal: 400, full: true, icon: icon, title: title).action, CGRect(x: 0, y: 0, width: 358, height: 52))
    }

    /// Let go: past the threshold it archives; a flick opens or closes it
    /// however far it went; else it opens past half the action.
    func testWhereALetGoGoes() {
        func release(_ reveal: CGFloat, _ velocity: CGFloat) -> SidebarSwipeLayout.Outcome {
            SidebarSwipeLayout.release(reveal: reveal, velocity: velocity, width: 358)
        }
        XCTAssertEqual(release(30, 0), .closed)
        XCTAssertEqual(release(50, 0), .open)
        XCTAssertEqual(release(10, 500), .open)
        XCTAssertEqual(release(80, -500), .closed)
        XCTAssertEqual(release(196, 0), .open)
        XCTAssertEqual(release(197, -2000), .full)
        XCTAssertEqual(SidebarSwipeLayout.reveal(.closed, width: 358), 0)
        XCTAssertEqual(SidebarSwipeLayout.reveal(.open, width: 358), 84)
        XCTAssertEqual(SidebarSwipeLayout.reveal(.full, width: 358), 358)
    }
}
