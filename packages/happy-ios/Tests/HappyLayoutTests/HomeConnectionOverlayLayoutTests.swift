import Foundation
import HappyLayout
import XCTest

final class HomeConnectionOverlayLayoutTests: XCTestCase {
    func testAConnectionNoticeKeepsTheListsRoomWhileItOverlaysItsTop() {
        let live = HomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 0, bannerHeight: 0, bannerOverlaysList: true)
        let offline = HomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 0, bannerHeight: 90, bannerOverlaysList: true)
        XCTAssertEqual(offline.banner, CGRect(x: 0, y: 120, width: 390, height: 90))
        XCTAssertEqual(offline.listInsets, LayoutInsets(top: 120, left: 0, bottom: 0, right: 0))
        XCTAssertEqual(live.content, offline.content)
        XCTAssertEqual(live.listInsets, offline.listInsets)
        XCTAssertEqual(live.indicatorInsets, offline.indicatorInsets)
        XCTAssertEqual(live.empty, offline.empty)
    }
}