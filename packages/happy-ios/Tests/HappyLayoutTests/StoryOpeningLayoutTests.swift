import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The viewer opening from a row's 52 avatar on a 402 × 874 phone, as
/// Telegram's `animateIn` starts it.
final class StoryOpeningLayoutTests: XCTestCase {
    private let viewer = StoryViewerLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34))

    func testFromACircle() {
        let avatar = CGRect(x: 171, y: 158, width: 52, height: 52)
        let opening = StoryOpeningLayout(source: avatar, sourceRadius: 26, sourceIsAvatar: true, viewer: viewer, height: 874)
        // The story shows through the circle itself.
        XCTAssertEqual(opening.window, avatar)
        XCTAssertEqual(opening.windowRadius, 26)
        // The canvas (0, 62, 402 × 714) as wide as the circle, from its top:
        // 52 × 92.36 at (171, 158), its middle at (197, 204.18).
        XCTAssertEqual(opening.canvas.scale, 52.0 / 402, accuracy: 0.000001)
        XCTAssertEqual(opening.canvas.offset.x, 197 - 201, accuracy: 0.0001)
        XCTAssertEqual(opening.canvas.offset.y, 158 + 714 * 26.0 / 402 - 419, accuracy: 0.0001)
        // The author's 32 avatar at (12, 80) starts on the circle.
        XCTAssertEqual(opening.avatar, .init(scale: 1.625, offset: CGPoint(x: 169, y: 88)))
        // The bar (its buttons from 780) rises from just under the screen.
        XCTAssertEqual(opening.barDrop, 94)
    }

    /// A card's corners are kept; a radius past half its side is a circle.
    func testFromACard() {
        let card = CGRect(x: 40, y: 300, width: 120, height: 213)
        let opening = StoryOpeningLayout(source: card, sourceRadius: 10, sourceIsAvatar: false, viewer: viewer, height: 874)
        XCTAssertEqual(opening.windowRadius, 10)
        // Not an avatar: the author's avatar stays put, fading.
        XCTAssertNil(opening.avatar)
        XCTAssertEqual(StoryOpeningLayout(source: card, sourceRadius: 400, sourceIsAvatar: false, viewer: viewer, height: 874).windowRadius, 60)
    }

    func testPlacement() {
        let placement = StoryOpeningLayout.Placement(from: CGRect(x: 0, y: 0, width: 100, height: 50), to: CGRect(x: 10, y: 20, width: 50, height: 25))
        XCTAssertEqual(placement, .init(scale: 0.5, offset: CGPoint(x: -15, y: 7.5)))
    }
}
