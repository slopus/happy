import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Making a bot from home's dock: Session | Bot at the top, only the
/// machine row over the composer (HomeDock.tsx).
final class HomeDockBotLayoutTests: XCTestCase {
    func testTheLedeTokenFromHappyApp() {
        XCTAssertEqual(TextStyles.homeDockLede, TextStyle(.regular, size: 13, lineHeight: 18))
    }

    // MARK: The focused dock

    func testABotKeepsOnlyTheMachineRow() {
        let layout = HomeDockFocusLayout(.init(
            size: phone,
            safeBottom: 34,
            composerHeight: 102,
            rows: [text("MacBook Pro", lineHeight: 22, maxLines: 1)]
        ))
        assertFrame(layout.composer, rect(16, 708, 361, 102))
        // 42 of row, 22 clear of the composer.
        XCTAssertEqual(layout.rows.count, 1)
        assertFrame(layout.rows[0].frame, rect(24, 644, 345, 42))
    }

    // MARK: Session | Bot

    func testTheSwitchHoldsTheTopOfTheScreen() {
        let layout = HomeDockHeaderLayout(.init(width: 393, safeTop: 59))
        // 8 under the safe area, at most 260, centred.
        assertFrame(layout.segment, rect(66.5, 67, 260, 32))
        XCTAssertNil(layout.lede)
        assertFrame(layout.content, rect(24, 67, 345, 32))
    }

    func testABotsLedeSitsTenBelowAtMost340() {
        let lede = text(String(repeating: "x", count: 50), lineHeight: 18)
        let layout = HomeDockHeaderLayout(.init(width: 393, safeTop: 59, lede: lede))
        assertFrame(layout.segment, rect(66.5, 67, 260, 32))
        // 340 holds 42 characters a line: two lines, centred.
        assertFrame(layout.lede, rect(28.5, 109, 336, 36))
        assertFrame(layout.content, rect(24, 67, 345, 78))
    }

    func testANarrowScreenNarrowsTheSwitch() {
        let layout = HomeDockHeaderLayout(.init(width: 280, safeTop: 20))
        // 232 of lane, less than 260.
        assertFrame(layout.segment, rect(24, 28, 232, 32))
    }
}
