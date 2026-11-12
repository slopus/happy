import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

final class GoogleButtonLayoutTests: XCTestCase {
    /// The "G" parses into its four colours and fills the 48 square.
    func testTheMarkIsGooglesFourColours() {
        let layers = GoogleMark.graphic.layers
        XCTAssertEqual(layers.map(\.color), [Palette.googleRed, Palette.googleBlue, Palette.googleYellow, Palette.googleGreen])
        for layer in layers { XCTAssertFalse(layer.path.elements.isEmpty) }
        let bounds = layers.map(\.path.controlBounds).reduce(CGRect.null) { $0.union($1) }
        XCTAssertTrue(GoogleMark.viewBox.contains(bounds))
        XCTAssertEqual([bounds.minX, bounds.minY, bounds.maxY], [0, 0, 48])
        XCTAssertEqual(bounds.maxX, 46.98, accuracy: 0.001)
        XCTAssertEqual(Palette.googleBlue.light, RGBA(hex: "#4285F4"))
    }

    func testItsColoursParse() {
        let magenta = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in Palette.google {
            XCTAssertNotEqual(token.light, magenta)
            XCTAssertNotEqual(token.dark, magenta)
        }
    }

    /// 16, the "G", 12, the words, 16.
    func testItsNarrowestHoldsTheMarkAndTheWords() {
        XCTAssertEqual(GoogleButtonLayout.width(label: CGSize(width: 179.4, height: 23)), 16 + 20 + 12 + 180 + 16)
    }

    /// In a wider button the "G" and the words are centred together.
    func testTheMarkAndTheWordsAreCentredTogether() {
        let layout = GoogleButtonLayout(size: CGSize(width: 280, height: 50), label: CGSize(width: 180, height: 23))
        XCTAssertEqual(layout.mark, CGRect(x: 34, y: 15, width: 20, height: 20))
        XCTAssertEqual(layout.label, CGRect(x: 66, y: 14, width: 180, height: 23))
        XCTAssertEqual(layout.mark.minX, 280 - layout.label.maxX)
    }

    /// Too narrow: the padding holds and the words are cut.
    func testANarrowButtonKeepsItsPadding() {
        let layout = GoogleButtonLayout(size: CGSize(width: 200, height: 50), label: CGSize(width: 180, height: 23))
        XCTAssertEqual(layout.mark.minX, 16)
        XCTAssertEqual(layout.label, CGRect(x: 48, y: 14, width: 136, height: 23))
    }
}
