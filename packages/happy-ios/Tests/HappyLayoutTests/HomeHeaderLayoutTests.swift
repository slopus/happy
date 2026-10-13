import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class HomeHeaderLayoutTests: XCTestCase {
    private let hairline: CGFloat = 1.0 / 3

    private func header(status: String? = nil, width: CGFloat = 393) -> HomeHeaderLayout {
        HomeHeaderLayout(.init(
            width: width,
            safeTop: 59,
            hairline: hairline,
            title: text("Sessions", lineHeight: 20, maxLines: 1),
            status: status.map { text($0, lineHeight: 16, maxLines: 1) }
        ))
    }

    func testControlsSitInTheFiftyTwoPointRowUnderTheStatusBar() {
        let layout = header()
        assertSize(layout.size, CGSize(width: 393, height: 111))
        assertFrame(layout.backdrop, rect(0, 0, 393, 119))
        // A 44pt circle, its 19pt mark centred.
        assertFrame(layout.logoControl, rect(16, 63, 44, 44))
        assertFrame(layout.logo, rect(28.5, 75.5, 19, 19))
        // The pill's rim sits outside the two 44pt buttons and the hairline.
        assertFrame(layout.actions, rect(393 - 16 - (90 + hairline), 62, 90 + hairline, 46))
        assertFrame(layout.filterButton, rect(287 - hairline + 1, 63, 44, 44))
        assertFrame(layout.actionDivider, rect(331 - hairline + 1, 74, hairline, 22))
        assertFrame(layout.settingsButton, rect(332, 63, 44, 44))
        XCTAssertEqual(layout.settingsButton.maxX + 1, 393 - 16, accuracy: 0.001)
    }

    func testTheTitleIsCentredOnTheScreenNotBetweenTheControls() {
        let layout = header()
        assertFrame(layout.title, rect(164.5, 75, 64, 20))
        XCTAssertEqual(layout.title.midX, 393 / 2, accuracy: 0.001)
        XCTAssertNil(layout.status)
        XCTAssertNil(layout.statusDot)
    }

    func testTheStatusHangsUnderTheTitleWithoutMovingIt() {
        let layout = header(status: "connecting")
        assertFrame(layout.title, rect(164.5, 75, 64, 20))
        // Dot 6, gap 4, then 80pt of text, centred; 2pt into the title.
        assertFrame(layout.statusDot, rect(151.5, 98, 6, 6))
        assertFrame(layout.status, rect(161.5, 93, 80, 16))
    }

    func testALongTitleStopsAtTheSixtyFourPointInsets() {
        let layout = HomeHeaderLayout(.init(
            width: 393,
            safeTop: 59,
            hairline: hairline,
            title: text(String(repeating: "x", count: 60), lineHeight: 20, maxLines: 1),
            status: nil
        ))
        assertFrame(layout.title, rect(64, 75, 265, 20))
    }

    func testContentInsetsFollowMainView() {
        let insets = HomeContentInsets(safeArea: LayoutInsets(top: 59, bottom: 34), dock: 108)
        XCTAssertEqual(insets.chromeTop, 111)
        XCTAssertEqual(insets.contentTop, 123)
        XCTAssertEqual(insets.listBottom, 142)
        XCTAssertEqual(insets.emptyStateSafeArea, LayoutInsets(top: 123, bottom: 108))
        XCTAssertEqual(
            insets.additionalSafeArea(over: LayoutInsets(top: 59, bottom: 34)),
            LayoutInsets(top: 64, bottom: 74)
        )
    }

    func testTheScreenFloatsTheHeaderAndItsScrimOverFullHeightContent() {
        let layout = HomeScreenLayout(size: phone, safeArea: phoneFullScreen, dock: 108)
        assertFrame(layout.content, rect(0, 0, 393, 852))
        assertFrame(layout.header, rect(0, 0, 393, 119))
        XCTAssertEqual(layout.insets.contentTop, 123)
    }

    func testTheScrimHoldsItsPeakThenFeathersOverTheLastThirtySixPoints() {
        let stops = HeaderScrim.stops(height: 119, peak: HeaderScrim.strongPeakLight)
        XCTAssertEqual(stops.count, 25)
        XCTAssertEqual(stops[0].alpha, 0.76)
        XCTAssertEqual(stops[18].alpha, 0.7192, accuracy: 0.00001)
        XCTAssertEqual(stops[20].alpha, 0.5604, accuracy: 0.00001)
        XCTAssertEqual(stops[24].alpha, 0)
        XCTAssertEqual(stops[24].location, 1)
    }
}
