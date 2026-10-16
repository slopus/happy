import Foundation
import HappyIcons
import HappyLayout
import XCTest

/// The draft glyph's metrics, which `DraftGlyphLayoutTests` (Linux, no
/// icon tables) writes out by hand.
final class DraftGlyphIconTests: XCTestCase {
    func testCreateOutlineIsAFullEmOfIonicons() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .ionicons("create-outline")))
        XCTAssertEqual(glyph.metrics, IconMetrics(unitsPerEm: 512, advance: 512, ascender: 454, descender: -71))
        // Every size the rows draw it at stays under the flat row's 18.
        for size in [CGFloat(12), 13, 14] {
            for scale in [CGFloat(1), 2, 3] {
                XCTAssertLessThan(glyph.layout(size: size, scale: scale).size.height, FlatSessionRowLayout.Metrics.workspaceMinHeight)
            }
        }
    }
}
