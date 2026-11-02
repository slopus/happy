import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The empty main panel's owl: desktop's 128 panel square, centred in the
/// safe area.
final class MainPanelPlaceholderLayoutTests: XCTestCase {
    func testTheOwlIsDesktopsPanelSquare() {
        XCTAssertEqual(MainPanelPlaceholderLayout.Metrics.scene, 128)
    }

    func testTheOwlIsCentredInTheSafeArea() {
        // An 11-inch iPad in landscape: the panel beside a 356 sidebar,
        // under its navigation bar and over the home indicator.
        let layout = MainPanelPlaceholderLayout(
            size: CGSize(width: 854, height: 834),
            safeArea: LayoutInsets(top: 74, bottom: 20)
        )
        // (854 - 128) / 2 = 363; (740 - 128) / 2 = 306 under the bar.
        XCTAssertEqual(layout.scene, CGRect(x: 363, y: 380, width: 128, height: 128))
    }

    func testSideInsetsMoveTheCentre() {
        let layout = MainPanelPlaceholderLayout(
            size: CGSize(width: 1000, height: 800),
            safeArea: LayoutInsets(top: 50, left: 100, bottom: 0, right: 20)
        )
        // (880 - 128) / 2 = 376 past the left inset; (750 - 128) / 2 = 311 under the top.
        XCTAssertEqual(layout.scene, CGRect(x: 476, y: 361, width: 128, height: 128))
    }

    func testOddRemaindersRoundToWholePoints() {
        let layout = MainPanelPlaceholderLayout(size: CGSize(width: 801, height: 601), safeArea: .zero)
        XCTAssertEqual(layout.scene.origin, CGPoint(x: 337, y: 237))
    }

    func testTheSquareNeverShrinks() {
        let layout = MainPanelPlaceholderLayout(size: CGSize(width: 100, height: 60), safeArea: .zero)
        XCTAssertEqual(layout.scene.size, CGSize(width: 128, height: 128))
    }
}
