import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for a vault's upload row: a card row with a progress bar
/// under its subtitle.
final class VaultLayoutTests: XCTestCase {
    func testTheBarRunsUnderTheSubtitleAcrossTheTextColumn() {
        let layout = VaultUploadRowLayout(
            width: 390, place: .alone, leading: CGSize(width: 40, height: 40),
            title: .fixed(width: 120, height: 19), subtitle: .fixed(width: 100, height: 16),
            fraction: 0.45, titleLine: 19, hairline: 0.5, scale: 2
        )
        // 19 + 2 + 16 + 6 + 3 = 46 of text, 10 above and below.
        XCTAssertEqual(layout.row.size, CGSize(width: 390, height: 66))
        XCTAssertEqual(layout.row.card, CGRect(x: 16, y: 0, width: 358, height: 66))
        XCTAssertEqual(layout.row.leading, CGRect(x: 32, y: 13, width: 40, height: 40))
        XCTAssertEqual(layout.row.title, CGRect(x: 84, y: 10, width: 274, height: 19))
        XCTAssertEqual(layout.subtitle, CGRect(x: 84, y: 31, width: 274, height: 16))
        XCTAssertEqual(layout.track, CGRect(x: 84, y: 53, width: 274, height: 3))
        XCTAssertEqual(layout.fill, CGRect(x: 84, y: 53, width: 123.5, height: 3))
        XCTAssertNil(layout.row.separator)
    }

    func testTheFillStaysInsideTheTrack() {
        func fill(_ fraction: Double) -> CGFloat {
            VaultUploadRowLayout(width: 390, place: CardPlace(first: true, last: false), leading: CGSize(width: 40, height: 40),
                                 title: .fixed(width: 120, height: 19), subtitle: .fixed(width: 100, height: 16),
                                 fraction: fraction, hairline: 0.5, scale: 3).fill.width
        }
        XCTAssertEqual(fill(-1), 0)
        XCTAssertEqual(fill(0), 0)
        XCTAssertEqual(fill(1), 274)
        XCTAssertEqual(fill(7), 274)
    }

    func testOnAnIPadTheRowHoldsToTheReadableColumn() {
        let layout = VaultUploadRowLayout(width: 1024, maxWidth: 800, place: CardPlace(first: false, last: false), leading: CGSize(width: 40, height: 40),
                                          title: .fixed(width: 120, height: 19), subtitle: .fixed(width: 100, height: 16),
                                          fraction: 1, hairline: 0.5, scale: 2)
        XCTAssertEqual(layout.row.card, CGRect(x: 128, y: 0, width: 768, height: 66))
        XCTAssertEqual(layout.track, CGRect(x: 196, y: 53, width: 684, height: 3))
        XCTAssertEqual(layout.row.separator, CGRect(x: 196, y: 65.5, width: 700, height: 0.5))
    }
}
