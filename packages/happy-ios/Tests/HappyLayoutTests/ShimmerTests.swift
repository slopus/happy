import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Desktop's ShimmerText (`shimmer-text.css`) on a phone: the ramp three
/// runs wide sliding two runs a 1.6s sweep, its stops, and the colours
/// each sweep mixes from its tone and the surface.
final class ShimmerTests: XCTestCase {
    private let accuracy = 1e-9

    private func assertClose(_ color: RGBA, _ expected: RGBA, file: StaticString = #filePath, line: UInt = #line) {
        for (a, b) in [(color.red, expected.red), (color.green, expected.green), (color.blue, expected.blue), (color.alpha, expected.alpha)] {
            XCTAssertEqual(a, b, accuracy: accuracy, file: file, line: line)
        }
    }

    func testTheRampIsThreeRunsWideAndCrossesTwo() {
        let band = Shimmer.band(run: CGRect(x: 0, y: 0, width: 100, height: 20), box: CGSize(width: 200, height: 20))
        XCTAssertEqual(band, Shimmer.Band(size: CGSize(width: 300, height: 20), fromX: -50, toX: 150, midY: 10))
        XCTAssertEqual(band?.centerX(at: 0.5), 50)
        XCTAssertEqual(Shimmer.duration, 1.6)
        XCTAssertEqual(Shimmer.bandStops, [0.4, 0.5, 0.6])
    }

    func testCentredTextSweepsWhereItIsDrawn() {
        let band = Shimmer.band(run: CGRect(x: 50, y: 0, width: 100, height: 16), box: CGSize(width: 200, height: 16))
        XCTAssertEqual(band, Shimmer.Band(size: CGSize(width: 300, height: 16), fromX: 0, toX: 200, midY: 8))
    }

    func testATruncatedRunSweepsOnlyWhatShows() {
        let band = Shimmer.band(run: CGRect(x: 0, y: 0, width: 300, height: 20), box: CGSize(width: 200, height: 20))
        XCTAssertEqual(band, Shimmer.Band(size: CGSize(width: 600, height: 20), fromX: -100, toX: 300, midY: 10))
    }

    func testNothingToSweepHasNoBand() {
        XCTAssertNil(Shimmer.band(run: .zero, box: CGSize(width: 200, height: 20)))
        XCTAssertNil(Shimmer.band(run: CGRect(x: 0, y: 0, width: 50, height: 0), box: CGSize(width: 200, height: 0)))
    }

    /// The band is clear of the line at 0 and 1, on its left edge at 0.25,
    /// its middle at 0.5 and its right edge at 0.75, whatever its length.
    func testTheBandCrossesTheLineInTheMiddleOfTheLoop() {
        for width in [CGFloat(40), 100, 333] {
            XCTAssertEqual(Shimmer.bandCenter(width: width, phase: 0), -width / 2)
            XCTAssertEqual(Shimmer.bandCenter(width: width, phase: 0.25), 0)
            XCTAssertEqual(Shimmer.bandCenter(width: width, phase: 0.5), width / 2)
            XCTAssertEqual(Shimmer.bandCenter(width: width, phase: 0.75), width)
            XCTAssertEqual(Shimmer.bandCenter(width: width, phase: 1), width * 1.5)
            for x in stride(from: 0, through: width, by: width / 8) {
                XCTAssertEqual(Shimmer.strength(atX: x, width: width, phase: 0), 0, "\(x) at the start")
                XCTAssertEqual(Shimmer.strength(atX: x, width: width, phase: 1), 0, "\(x) at the end")
            }
        }
    }

    /// Full at the band's middle, gone 0.3 runs either side (the ramp's
    /// 40% and 60% stops), linear between.
    func testTheBandRisesAndFallsLinearly() {
        XCTAssertEqual(Shimmer.strength(atX: 50, width: 100, phase: 0.5), 1, accuracy: accuracy)
        XCTAssertEqual(Shimmer.strength(atX: 65, width: 100, phase: 0.5), 0.5, accuracy: accuracy)
        XCTAssertEqual(Shimmer.strength(atX: 35, width: 100, phase: 0.5), 0.5, accuracy: accuracy)
        XCTAssertEqual(Shimmer.strength(atX: 80, width: 100, phase: 0.5), 0, accuracy: accuracy)
        XCTAssertEqual(Shimmer.strength(atX: 0, width: 100, phase: 0.5), 0, accuracy: accuracy)
    }

    func testEveryShimmerKeepsOneClock() {
        XCTAssertEqual(Shimmer.phase(at: 10, epoch: 10), 0, accuracy: accuracy)
        XCTAssertEqual(Shimmer.phase(at: 10.4, epoch: 10), 0.25, accuracy: accuracy)
        XCTAssertEqual(Shimmer.phase(at: 10 + 1.6 * 3 + 0.8, epoch: 10), 0.5, accuracy: accuracy)
        XCTAssertEqual(Shimmer.phase(at: 9.6, epoch: 10), 0.75, accuracy: accuracy)
    }

    /// `lift`: letters 38% of the tone into the surface, the band at full
    /// strength. `sheen`: letters at the tone, the band 15% of it.
    func testTheSweepsMixTheirColoursIntoTheSurface() {
        let black = RGBA.black, white = RGBA.white
        assertClose(Shimmer.rest(.lift, ink: black, ground: white), RGBA(red: 0.62, green: 0.62, blue: 0.62))
        assertClose(Shimmer.highlight(.lift, ink: black, ground: white), black)
        assertClose(Shimmer.rest(.sheen, ink: black, ground: white), black)
        assertClose(Shimmer.highlight(.sheen, ink: black, ground: white), RGBA(red: 0.85, green: 0.85, blue: 0.85))
        // Dark: white text on #161616, the band toward that surface.
        let dark = Shimmer.highlight(.sheen, ink: Palette.text, ground: Palette.surface).dark
        XCTAssertEqual(dark.red, 0.15 + 0.85 * 22 / 255, accuracy: accuracy)
        XCTAssertEqual(dark.alpha, 1, accuracy: accuracy)
        let light = Shimmer.highlight(.sheen, ink: Palette.text, ground: Palette.surface).light
        XCTAssertEqual(light.red, 0.85, accuracy: accuracy)
    }

    func testTheColourAtAPointIsTheRampsThere() {
        let ink = RGBA.black, ground = RGBA.white
        // At the band's middle, the highlight; clear of it, the rest.
        assertClose(Shimmer.color(.sheen, ink: ink, ground: ground, atX: 50, width: 100, phase: 0.5), Shimmer.highlight(.sheen, ink: ink, ground: ground))
        assertClose(Shimmer.color(.sheen, ink: ink, ground: ground, atX: 0, width: 100, phase: 0.5), ink)
        let half = Shimmer.color(.lift, ink: ink, ground: ground, atX: 65, width: 100, phase: 0.5)
        XCTAssertEqual(half.red, 0.31, accuracy: accuracy)
    }

    func testTonesNameTheirTextRoles() {
        XCTAssertEqual(Shimmer.ink(.default, own: Palette.textLink), Palette.text)
        XCTAssertEqual(Shimmer.ink(.muted, own: Palette.text), Palette.textSecondary)
        XCTAssertEqual(Shimmer.ink(.accent, own: Palette.text), Palette.textLink)
        XCTAssertEqual(Shimmer.ink(.inherit, own: Palette.textDestructive), Palette.textDestructive)
    }
}
