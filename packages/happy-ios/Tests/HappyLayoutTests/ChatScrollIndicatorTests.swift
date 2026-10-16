import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The chat list's scroll indicator, and what the list's insets do to the
/// reader's place. The phone is `phone` under its bar with a 130-tall dock
/// resting on the safe area (`ChatScreenLayoutTests.screen`): content insets
/// 172 at the newest end and 115 at the oldest, the indicator between the
/// header (103) and the dock (164 from the bottom).
final class ChatScrollIndicatorTests: XCTestCase {
    private func screen(keyboardTop: CGFloat? = nil, headerAccessory: CGFloat = 0) -> ChatScreenLayout {
        ChatScreenLayout(.init(
            size: phone, safeArea: phoneUnderBar, keyboardTop: keyboardTop, accessories: [.inset(block(height: 60))], composerHeight: 70,
            headerAccessory: headerAccessory
        ))
    }

    /// Six screens of content and insets: `span` 5112, 4260 to scroll back.
    private let content: CGFloat = 4825

    /// At @3x, where UIKit rounds to thirds of a point.
    private func indicator(_ screen: ChatScreenLayout, content: CGFloat, distance: CGFloat, scale: CGFloat = 3) -> ChatScrollIndicatorLayout {
        ChatScrollIndicatorLayout(.init(
            viewport: screen.list.size, contentHeight: content, newestInset: screen.newestEdgeInset, oldestInset: screen.oldestEdgeInset,
            indicatorInsets: screen.indicatorInsets, distanceFromNewest: distance, scale: scale
        ))
    }

    // MARK: The screen's indicator insets

    func testOnAPhoneTheIndicatorRunsBetweenTheHeaderAndTheDock() {
        XCTAssertEqual(screen().indicatorInsets, ChatIndicatorInsets(newest: 164, oldest: 103, side: 0))
        // The keyboard's top at 500 carries the dock to 370.
        XCTAssertEqual(screen(keyboardTop: 500).indicatorInsets, ChatIndicatorInsets(newest: 482, oldest: 103, side: 0))
        // The tab strip hangs under the header and covers the list too.
        XCTAssertEqual(screen(headerAccessory: 56).indicatorInsets, ChatIndicatorInsets(newest: 164, oldest: 159, side: 0))
    }

    func testWhereTheListStopsAtTheChromeNothingCoversIt() {
        let tablet = ChatScreenLayout(.init(
            size: CGSize(width: 664, height: 768), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0), keyboardTop: 400,
            composerHeight: 70, docked: true, accessoryPaddingH: 12
        ))
        XCTAssertEqual(tablet.indicatorInsets, ChatIndicatorInsets())
        // An iPhone 16 Pro on its side, island on the right: no header,
        // and the indicator clears the island.
        let sideways = ChatScreenLayout(.init(
            size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(top: 0, left: 62, bottom: 21, right: 62), keyboardTop: nil,
            composerHeight: 70, hidesHeader: true
        ))
        assertFrame(sideways.list, rect(0, 0, 874, 311))
        XCTAssertEqual(sideways.indicatorInsets, ChatIndicatorInsets(newest: 0, oldest: 0, side: 62))
    }

    /// At an accessibility text size the dock's height falls between
    /// pixels: on the iPhone 17 Pro at AX3 the track ended 258.562 up while
    /// the snapped dock stood 258⅔ up. Snapped, the insets meet the dock.
    func testOnTheScreensPixelsTheInsetsMeetTheSnappedDock() {
        let tall = ChatScreenLayout(.init(
            size: phone, safeArea: phoneUnderBar, keyboardTop: nil, accessories: [.inset(block(height: 60.4))], composerHeight: 70.3
        ))
        for scale: CGFloat in [2, 3] {
            let dock = PixelGrid.snap(tall.dock, scale: scale)
            let snapped = tall.indicatorInsets.snapped(scale: scale)
            XCTAssertNotEqual(tall.indicatorInsets.newest, phone.height - dock.minY, "@\(scale)")
            XCTAssertEqual(snapped.newest, phone.height - dock.minY, accuracy: 1e-9, "@\(scale)")
            XCTAssertEqual(snapped.oldest, 103)
            XCTAssertEqual(PixelGrid.round(tall.newestEdgeInset, scale: scale) * scale, (tall.newestEdgeInset * scale).rounded())
        }
        XCTAssertEqual(ChatIndicatorInsets(newest: 258.562, oldest: 102.9, side: 0.2).snapped(scale: 3), ChatIndicatorInsets(
            newest: 776.0 / 3, oldest: 309.0 / 3, side: 1.0 / 3
        ))
        XCTAssertEqual(PixelGrid.round(225.062, scale: 2), 225)
        XCTAssertEqual(PixelGrid.round(225.062, scale: 0), 225.062)
    }

    // MARK: Where the indicator is

    func testAtTheNewestMessageTheIndicatorRestsOnTheDock() {
        let layout = indicator(screen(), content: content, distance: 0)
        XCTAssertEqual(layout.span, 5112)
        XCTAssertEqual(layout.maxDistance, 4260)
        XCTAssertTrue(layout.scrolls)
        // 3 in from the right, 3 inside the header and the dock.
        assertFrame(layout.track, rect(387, 106, 3, 579))
        // A sixth of the track, the viewport's share of the span (96.5),
        // to the pixel.
        XCTAssertEqual(layout.length, 290.0 / 3)
        XCTAssertEqual(layout.progress, 0)
        assertFrame(layout.frame, rect(387, 588 + 1.0 / 3, 3, 290.0 / 3))
        // Unrounded, as at scale 0.
        let exact = indicator(screen(), content: content, distance: 0, scale: 0)
        XCTAssertEqual(exact.length, 96.5)
        assertFrame(exact.frame, rect(387, 588.5, 3, 96.5))
    }

    func testHalfwayBackItIsHalfwayUp() {
        let layout = indicator(screen(), content: content, distance: 2130)
        XCTAssertEqual(layout.progress, 0.5)
        assertFrame(layout.frame, rect(387, 347, 3, 290.0 / 3))
    }

    func testAtTheOldestMessageItReachesTheHeader() {
        let layout = indicator(screen(), content: content, distance: 4260)
        XCTAssertEqual(layout.progress, 1)
        assertFrame(layout.frame, rect(387, 106, 3, 290.0 / 3))
    }

    func testPulledPastAnEndItIsSquashedAgainstIt() {
        assertFrame(indicator(screen(), content: content, distance: -40).frame, rect(387, 628 + 1.0 / 3, 3, 170.0 / 3))
        assertFrame(indicator(screen(), content: content, distance: 4300).frame, rect(387, 106, 3, 170.0 / 3))
        // Never shorter than 7.
        assertFrame(indicator(screen(), content: content, distance: -200).frame, rect(387, 678, 3, 7))
    }

    func testALongChatKeepsTheIndicatorLongEnoughToGrab() {
        let layout = indicator(screen(), content: 852 * 100 - 287, distance: 0)
        XCTAssertEqual(layout.length, 36)
        assertFrame(layout.frame, rect(387, 649, 3, 36))
    }

    func testWhatFitsHasNothingToScroll() {
        let layout = indicator(screen(), content: 300, distance: 0)
        XCTAssertFalse(layout.scrolls)
        XCTAssertEqual(layout.maxDistance, 0)
        XCTAssertEqual(layout.progress, 0)
    }

    func testTheKeyboardShortensTheTrack() {
        let typing = screen(keyboardTop: 500)
        // The content inset grows with the dock: 490 at the newest end.
        let layout = indicator(typing, content: content, distance: 0)
        XCTAssertEqual(layout.span, 5430)
        assertFrame(layout.track, rect(387, 106, 3, 261))
        // 261 · 852 / 5430 = 40.95, to the pixel.
        assertFrame(layout.frame, rect(387, 326, 3, 41))
    }

    func testOlderRowsJoiningShrinkTheIndicatorAndLowerIt() {
        // A page as long as everything before joins at the far end: twelve
        // screens now, 9372 to scroll back.
        let grown = indicator(screen(), content: content + 5112, distance: 0)
        XCTAssertEqual(grown.length, 145.0 / 3)
        assertFrame(grown.frame, rect(387, 636 + 2.0 / 3, 3, 145.0 / 3))
        // A quarter of the way back.
        let back = indicator(screen(), content: content + 5112, distance: 2343)
        XCTAssertEqual(back.progress, 0.25)
        assertFrame(back.frame, rect(387, 504, 3, 145.0 / 3))
    }

    func testTheSafeAreaKeepsItOffASidewaysPhonesIsland() {
        let sideways = ChatScreenLayout(.init(
            size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(top: 0, left: 62, bottom: 21, right: 62), keyboardTop: nil,
            composerHeight: 70, hidesHeader: true
        ))
        // 311 tall, 8 and 12 of content insets: 3110 is ten viewports.
        let layout = indicator(sideways, content: 3090, distance: 0)
        XCTAssertEqual(layout.frameInScrollView.minY, -5)
        XCTAssertEqual(layout.span, 3110)
        assertFrame(layout.track, rect(806, 3, 3, 305))
        assertFrame(layout.frame, rect(806, 272, 3, 36))
    }

    func testInsideTheFlippedListTheFrameIsMeasuredFromTheNewestEdge() {
        // The collection view's offset is -172 at the newest message, and
        // its own y runs up the screen from the list's bottom.
        assertFrame(indicator(screen(), content: content, distance: 0).frameInScrollView, rect(387, -5, 3, 290.0 / 3))
        // Halfway: offset 1958; the indicator starts 408.25 up, rounded
        // there to the pixel.
        assertFrame(indicator(screen(), content: content, distance: 2130).frameInScrollView, rect(387, 2366 + 1.0 / 3, 3, 290.0 / 3))
    }

    /// What UIKit drew, read back from its indicator view in a flipped
    /// scroll view on the iOS 26.5 simulator (iPhone 17 Pro, 402 by 874,
    /// @3x), content insets 172 and 115.
    func testTheIndicatorIsWhereUIKitDrewIt() {
        func measured(_ content: CGFloat, newest: CGFloat = 172, indicator: ChatIndicatorInsets, distance: CGFloat) -> CGRect {
            ChatScrollIndicatorLayout(.init(
                viewport: CGSize(width: 402, height: 874), contentHeight: content, newestInset: newest, oldestInset: 115,
                indicatorInsets: indicator, distanceFromNewest: distance, scale: 3
            )).frameInScrollView
        }
        let insets = ChatIndicatorInsets(newest: 164, oldest: 103)
        assertFrame(measured(4000, indicator: insets, distance: 0), rect(396, -5, 3, 368.0 / 3))
        assertFrame(measured(4000, indicator: insets, distance: 1500), rect(396, 5116.0 / 3, 3, 368.0 / 3))
        assertFrame(measured(4000, indicator: insets, distance: 3413), rect(396, 11659.0 / 3, 3, 368.0 / 3))
        assertFrame(measured(4000, indicator: insets, distance: -40), rect(396, -45, 3, 248.0 / 3))
        assertFrame(measured(4000, indicator: insets, distance: 3453), rect(396, 11899.0 / 3, 3, 248.0 / 3))
        assertFrame(measured(4000, indicator: insets, distance: -300), rect(396, -305, 3, 7))
        assertFrame(measured(100_000, indicator: insets, distance: 0), rect(396, -5, 3, 36))
        assertFrame(measured(100_000, indicator: insets, distance: 50000), rect(396, 150838.0 / 3, 3, 36))
        assertFrame(measured(1500, newest: 490, indicator: ChatIndicatorInsets(newest: 482, oldest: 103), distance: 300), rect(396, 1006.0 / 3, 3, 353.0 / 3))
        // Left to adjust its insets itself, UIKit added the scroll view's
        // safe area (116 under the bar, 34 over the home indicator) to
        // them, at the ends the flip swaps: 116 more above the dock.
        let adjusted = ChatIndicatorInsets(newest: 164 + 116, oldest: 103 + 34)
        assertFrame(measured(4000, indicator: adjusted, distance: 0), rect(396, 111, 3, 92))
        assertFrame(measured(4000, indicator: adjusted, distance: 1500), rect(396, 5306.0 / 3, 3, 92))
        assertFrame(measured(1500, newest: 490, indicator: ChatIndicatorInsets(newest: 482 + 116, oldest: 103 + 34), distance: 300), rect(396, 430, 3, 166.0 / 3))
    }

    // MARK: Dragging it

    func testDraggingTheIndicatorIsTheInverse() {
        let resting = indicator(screen(), content: content, distance: 0, scale: 0)
        XCTAssertEqual(resting.distanceFromNewest(indicatorMinY: 588.5), 0)
        XCTAssertEqual(resting.distanceFromNewest(indicatorMinY: 347.25), 2130)
        XCTAssertEqual(resting.distanceFromNewest(indicatorMinY: 106), 4260)
        // Past the ends of the track it stops.
        XCTAssertEqual(resting.distanceFromNewest(indicatorMinY: 0), 4260)
        XCTAssertEqual(resting.distanceFromNewest(indicatorMinY: 700), 0)
        for distance: CGFloat in [0, 500, 1234.5, 4260] {
            let layout = indicator(screen(), content: content, distance: distance, scale: 0)
            XCTAssertEqual(layout.distanceFromNewest(indicatorMinY: layout.frame.minY), distance, accuracy: 0.0001)
            // On screen, a pixel off at most: 4260 / 482 points a pixel.
            let drawn = indicator(screen(), content: content, distance: distance)
            XCTAssertEqual(drawn.distanceFromNewest(indicatorMinY: drawn.frame.minY), distance, accuracy: 4260.0 / 482 / 3 * 2)
        }
        XCTAssertEqual(indicator(screen(), content: 300, distance: 0).distanceFromNewest(indicatorMinY: 200), 0)
    }
}

/// What a change of the newest edge's inset does to the reader's place.
final class ChatInsetChangeTests: XCTestCase {
    func testLeftAloneTheReaderKeepsWhatTheySeeAtTheNewestEdge() {
        // The keyboard rises by 318: the content rides up with the dock.
        XCTAssertEqual(ChatScrollAnchor.visibleMinY(afterNewestInsetChange: 318, from: 450, maxVisibleMinY: 4000, tracking: false), 450)
        XCTAssertEqual(ChatScrollAnchor.visibleMinY(afterNewestInsetChange: 318, from: 0, maxVisibleMinY: 4000, tracking: false), 0)
        // Never past either end.
        XCTAssertEqual(ChatScrollAnchor.visibleMinY(afterNewestInsetChange: -318, from: 4200, maxVisibleMinY: 4000, tracking: false), 4000)
        XCTAssertEqual(ChatScrollAnchor.visibleMinY(afterNewestInsetChange: -318, from: -20, maxVisibleMinY: 4000, tracking: false), 0)
    }

    func testUnderTheFingerTheOffsetStays() {
        XCTAssertEqual(ChatScrollAnchor.visibleMinY(afterNewestInsetChange: -50, from: 300, maxVisibleMinY: 4000, tracking: true), 250)
        XCTAssertEqual(ChatScrollAnchor.visibleMinY(afterNewestInsetChange: 20, from: 300, maxVisibleMinY: 4000, tracking: true), 320)
    }

    /// The pan and the keyboard frame by frame: the finger starts 200 above
    /// the dock and drags 400 down, 10 a frame. The keyboard's top (500)
    /// follows the finger once it is reached and stops at the safe area.
    /// The pan moves the content by the finger's travel; the layout pass
    /// after it applies the new inset.
    private func dismiss(tracking: Bool) -> (contentTravel: CGFloat, keyboardTravel: CGFloat) {
        func inset(_ keyboardTop: CGFloat) -> CGFloat {
            ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: keyboardTop, accessories: [.inset(block(height: 60))], composerHeight: 70))
                .newestEdgeInset
        }
        let contentHeight: CGFloat = 20000
        var keyboardTop: CGFloat = 500
        var newest = inset(keyboardTop)
        var offset = -newest
        let start = offset
        var finger: CGFloat = 170
        for _ in 0..<40 {
            finger += 10
            offset += 10
            keyboardTop = min(phone.height - phoneUnderBar.bottom, max(500, finger))
            let next = inset(keyboardTop)
            let maxVisibleMinY = contentHeight + next + 115 - phone.height
            let target = ChatScrollAnchor.visibleMinY(afterNewestInsetChange: next - newest, from: offset + newest, maxVisibleMinY: maxVisibleMinY, tracking: tracking)
            offset = target - next
            newest = next
        }
        return (offset - start, keyboardTop - 500)
    }

    func testAnInteractiveDismissMovesTheConversationWithTheFinger() {
        let fixed = dismiss(tracking: true)
        XCTAssertEqual(fixed.keyboardTravel, 70)
        XCTAssertEqual(fixed.contentTravel, 400)
        // Keeping the anchor under the finger, as the list used to, adds the
        // keyboard's travel to the finger's.
        XCTAssertEqual(dismiss(tracking: false).contentTravel, 470)
    }
}
