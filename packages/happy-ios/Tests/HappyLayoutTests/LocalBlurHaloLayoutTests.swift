import Foundation
import HappyLayout
import XCTest
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// AnimatedOverlay.tsx's LocalBlurHalo, as AgentInputAutocomplete mounts it.
final class LocalBlurHaloLayoutTests: XCTestCase {
    func testTheSuggestionListsHalo() {
        let halo = LocalBlurHaloLayout.autocomplete
        XCTAssertEqual(halo.borderRadius, 24)
        // The defaults: expansion 14, intensity 34.
        XCTAssertEqual(halo.reach, 35)
        XCTAssertEqual(halo.feather, 18.9, accuracy: 0.0001)
        XCTAssertEqual(halo.intensity, 0.34)

        // Three rows in a hairline rim, as the composer lays the list out.
        let list = CGRect(x: 0, y: 0, width: 361, height: 145)
        let frame = halo.frame(popup: list)
        assertFrame(frame, rect(-35, -35, 431, 215))
        assertFrame(halo.maskCore(halo: CGRect(origin: .zero, size: frame.size)), rect(35, 35, 361, 145))
    }

    func testAnEmptyListStillHasItsFeather() {
        let halo = LocalBlurHaloLayout.autocomplete
        let frame = halo.frame(popup: .zero)
        assertFrame(frame, rect(-35, -35, 70, 70))
        assertFrame(halo.maskCore(halo: CGRect(origin: .zero, size: frame.size)), rect(35, 35, 0, 0))
    }

    func testOtherHalosScaleWithTheirExpansion() {
        // new/index.tsx's agent picker: `expansion={16}`.
        let halo = LocalBlurHaloLayout(borderRadius: 24, expansion: 16)
        XCTAssertEqual(halo.reach, 40)
        XCTAssertEqual(halo.feather, 21.6, accuracy: 0.0001)
        XCTAssertEqual(LocalBlurHaloLayout().borderRadius, 30)
    }
}
