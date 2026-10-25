import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The one-time stories tooltip under the closed avatars, as Telegram's
/// `TooltipScreen` places it.
final class StoriesTooltipLayoutTests: XCTestCase {
    func testUnderTheAvatars() {
        let layout = StoriesTooltipLayout(tip: CGPoint(x: 157, y: 103), width: 402) { _ in CGSize(width: 200.4, height: 33.2) }
        XCTAssertEqual(layout.arrow, CGRect(x: 142.5, y: 103, width: 29, height: 10))
        XCTAssertEqual(layout.bubble, CGRect(x: 45.5, y: 113, width: 223, height: 50))
        XCTAssertEqual(layout.text, CGRect(x: 56.5, y: 121, width: 201, height: 34))
    }

    /// Kept 12 in from the side, the arrow still over the avatars, clear of
    /// the bubble's corners; long text wraps within the screen.
    func testKeptOnScreen() {
        var widest: CGFloat = 0
        let layout = StoriesTooltipLayout(tip: CGPoint(x: 22, y: 103), width: 402) { width in
            widest = max(widest, width)
            return CGSize(width: 600, height: 50)
        }
        XCTAssertEqual(widest, 402 - 24 - 22)
        XCTAssertEqual(layout.bubble.minX, 12)
        XCTAssertEqual(layout.bubble.maxX, 390)
        XCTAssertEqual(layout.arrow.midX, 12 + 12.5 + 14.5)
    }

    /// Text that wraps is laid out as narrow as it goes on as many lines,
    /// so the lines come out even, as Telegram's balanced text does.
    func testBalancedLines() {
        let layout = StoriesTooltipLayout(tip: CGPoint(x: 201, y: 103), width: 402) { width in
            CGSize(width: min(500, width), height: 17 * ceil(500 / width))
        }
        XCTAssertEqual(layout.text.size, CGSize(width: 250, height: 34))
        XCTAssertEqual(layout.bubble, CGRect(x: 65, y: 113, width: 272, height: 50))
    }
}
