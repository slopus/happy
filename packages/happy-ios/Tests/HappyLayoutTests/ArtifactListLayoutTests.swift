import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The artifacts list's rows: a 16:9 slot in place of the square tile,
/// one height for every row, and where a cover sits in the slot.
final class ArtifactListLayoutTests: XCTestCase {
    func testTheSlotsMeasures() {
        XCTAssertEqual(ArtifactListMetrics.slot, CGSize(width: 72, height: 40))
        XCTAssertEqual(ArtifactListMetrics.slotRadius, CardListMetrics.tileRadius)
        XCTAssertEqual(ArtifactListMetrics.titleLines, 1)
    }

    private func row(title: CGFloat, place: CardPlace = .alone, width: CGFloat = 390, maxWidth: CGFloat = .greatestFiniteMagnitude) -> CardRowLayout {
        CardRowLayout(
            width: width, maxWidth: maxWidth, place: place, leading: ArtifactListMetrics.slot,
            title: .fixed(width: title, height: 19), subtitle: .fixed(width: 60, height: 16),
            trailing: CGSize(width: 50, height: 16), titleLine: 19, hairline: 0.5, scale: 2
        )
    }

    /// The slot stands where the tile stood, wider; the text starts after
    /// it; the row is the tiled row's 60.
    func testARowWithTheSlot() {
        let layout = row(title: 120, place: CardPlace(first: true, last: false))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 60))
        XCTAssertEqual(layout.leading, CGRect(x: 32, y: 10, width: 72, height: 40))
        XCTAssertEqual(layout.title, CGRect(x: 116, y: 11.5, width: 184, height: 19))
        XCTAssertEqual(layout.subtitle, CGRect(x: 116, y: 32.5, width: 242, height: 16))
        XCTAssertEqual(layout.trailing, CGRect(x: 308, y: 13, width: 50, height: 16))
        XCTAssertEqual(layout.separator, CGRect(x: 116, y: 59.5, width: 258, height: 0.5))
    }

    /// A one-line title of any length leaves every row one height, so the
    /// list never measures a row to place the next.
    func testEveryRowIsOneHeight() {
        let heights = Set([10, 120, 500].map { row(title: $0).size.height })
        XCTAssertEqual(heights, [60])
        XCTAssertEqual(row(title: 100, width: 1024, maxWidth: 800).leading, CGRect(x: 144, y: 10, width: 72, height: 40), "the readable column")
    }

    /// A wide cover fills the slot (within the 2% a cover may be off).
    func testAWideCoverFillsTheSlot() {
        let slot = CGRect(x: 32, y: 10, width: 72, height: 40)
        XCTAssertTrue(ArtifactCoverSlot.fills(ratio: 9.0 / 16.0, slot: slot.size))
        XCTAssertEqual(ArtifactCoverSlot.picture(ratio: 9.0 / 16.0, in: slot, scale: 2), slot)
        XCTAssertEqual(ArtifactCoverSlot.picture(ratio: 0.25, in: slot, scale: 2), slot, "wider is cropped to fill")
    }

    /// A square stands whole at the slot's height, centred.
    func testASquareCoverStandsWholeInTheMiddle() {
        let slot = CGRect(x: 32, y: 10, width: 72, height: 40)
        XCTAssertFalse(ArtifactCoverSlot.fills(ratio: 1, slot: slot.size))
        XCTAssertEqual(ArtifactCoverSlot.picture(ratio: 1, in: slot, scale: 2), CGRect(x: 48, y: 10, width: 40, height: 40))
        XCTAssertEqual(ArtifactCoverSlot.picture(ratio: 1, in: CGRect(x: 33, y: 10, width: 72, height: 40), scale: 3), CGRect(x: 49, y: 10, width: 40, height: 40))
    }

    /// No shape to go by fills the slot rather than vanish.
    func testNoShapeFills() {
        let slot = CGRect(x: 0, y: 0, width: 72, height: 40)
        for ratio in [0, -1, .infinity, .nan] as [CGFloat] {
            XCTAssertTrue(ArtifactCoverSlot.fills(ratio: ratio, slot: slot.size))
            XCTAssertEqual(ArtifactCoverSlot.picture(ratio: ratio, in: slot), slot)
        }
    }
}
