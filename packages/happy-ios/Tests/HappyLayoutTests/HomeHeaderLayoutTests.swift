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

    /// One button alone: the pill hugs it at the right edge.
    func testASingleActionPill() {
        var input = HomeHeaderLayout.Input(width: 393, safeTop: 59, hairline: hairline, title: text("Mac", lineHeight: 20, maxLines: 1), status: nil)
        input.singleAction = true
        let layout = HomeHeaderLayout(input)
        assertFrame(layout.actions, rect(331, 62, 46, 46))
        assertFrame(layout.filterButton, rect(332, 63, 44, 44))
        XCTAssertEqual(layout.actionDivider.width, 0)
        XCTAssertEqual(layout.settingsButton.width, 0)
        XCTAssertEqual(layout.title.midX, 393 / 2, accuracy: 0.001)
    }

    /// A computer's search opens in place: the pill grows left across the
    /// row into the field, its glyph riding at its start, beside the
    /// circle that ends it. The logo and title keep their frames.
    func testSearchGrowsThePillIntoTheField() {
        var input = HomeHeaderLayout.Input(width: 402, safeTop: 62, hairline: hairline, title: text("Mac", lineHeight: 20, maxLines: 1), status: nil)
        input.singleAction = true
        let closed = HomeHeaderLayout(input)
        assertFrame(closed.actions, rect(340, 65, 46, 46))
        assertFrame(closed.filterButton, rect(341, 66, 44, 44))
        // No width yet, at the glyph's end.
        assertFrame(closed.searchField, rect(385, 66, 0, 44))
        assertFrame(closed.searchCancel, rect(342, 66, 44, 44))
        input.searching = true
        let open = HomeHeaderLayout(input)
        // 16 from the left, 8 short of the circle.
        assertFrame(open.actions, rect(16, 65, 318, 46))
        assertFrame(open.filterButton, rect(17, 66, 44, 44))
        // After the glyph, 8 inside the rim at the end.
        assertFrame(open.searchField, rect(61, 66, 264, 44))
        assertFrame(open.searchCancel, rect(342, 66, 44, 44))
        XCTAssertEqual(open.searchCancel.maxX, 402 - 16)
        XCTAssertEqual(open.logoControl, closed.logoControl)
        XCTAssertEqual(open.title, closed.title)
        XCTAssertEqual(open.backdrop, closed.backdrop)
        // Only a computer's single search opens: the two-button pill stays.
        var two = HomeHeaderLayout.Input(width: 402, safeTop: 62, hairline: hairline, title: text("Mac", lineHeight: 20, maxLines: 1), status: nil)
        two.searching = true
        XCTAssertEqual(HomeHeaderLayout(two).actions, header(width: 402).actions.offsetBy(dx: 0, dy: 3))
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

    /// Under a navigation bar the safe area already holds the bar (59 + 44).
    func testContentInsetsUnderTheBarStartTwelveBelowIt() {
        let insets = HomeContentInsets(underBar: LayoutInsets(top: 103, bottom: 34), dock: 108)
        XCTAssertEqual(insets.chromeTop, 103)
        XCTAssertEqual(insets.contentTop, 115)
        XCTAssertEqual(insets.listBottom, 142)
        XCTAssertEqual(insets.additionalSafeArea(over: LayoutInsets(top: 103, bottom: 34)), LayoutInsets(top: 12, bottom: 74))
        // The indicator runs from the bar's foot to the dock's top.
        XCTAssertEqual(insets.indicatorInsets, LayoutInsets(top: 103, bottom: 142))
    }

    func testTheScreenFloatsTheHeaderAndItsScrimOverFullHeightContent() {
        let layout = HomeScreenLayout(size: phone, safeArea: phoneFullScreen, dock: 108)
        assertFrame(layout.content, rect(0, 0, 393, 852))
        assertFrame(layout.header, rect(0, 0, 393, 119))
        XCTAssertEqual(layout.insets.contentTop, 123)
    }

    func testTheScrimHoldsItsPeakThenFeathersOverTheLastThirtySixPoints() {
        let stops = HeaderScrim.stops(height: 119)
        XCTAssertEqual(stops.count, 25)
        XCTAssertEqual(stops[0].alpha, 1)
        XCTAssertEqual(stops[18].alpha, 0.9463, accuracy: 0.0001)
        XCTAssertEqual(stops[20].alpha, 0.7374, accuracy: 0.0001)
        XCTAssertEqual(stops[24].alpha, 0)
        XCTAssertEqual(stops[24].location, 1)
    }

    /// The foot's fade: Telegram's light one at the screen's foot, none at
    /// the scrim's top.
    func testTheFootFadesLightlyIntoTheGroundAtTheFoot() {
        let stops = HeaderScrim.footStops()
        XCTAssertEqual(stops.count, 25)
        XCTAssertEqual(stops[0].location, 0)
        XCTAssertEqual(stops[0].alpha, 0.55)
        XCTAssertEqual(stops[12].alpha, 0.1729, accuracy: 0.0001)
        XCTAssertEqual(stops[24].alpha, 0)
    }
}
