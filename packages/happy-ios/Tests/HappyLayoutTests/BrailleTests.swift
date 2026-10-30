@testable import HappyLayout
import XCTest

/// Desktop's braille loader on a phone's pixels: the same stamp eight
/// times at whole-pixel origins, and the one wave every dot runs.
final class BrailleTests: XCTestCase {
    func testAt3xTheDotsAreSixPixelsWithTheSpareRowInTheMiddleGap() {
        let (diameter, origins) = Braille.origins(width: 24, height: 42)
        XCTAssertEqual(diameter, 6)
        XCTAssertEqual(origins.map(\.x), [3, 3, 3, 3, 15, 15, 15, 15])
        XCTAssertEqual(origins.map(\.y), [1, 12, 24, 35, 1, 12, 24, 35])
        // One clear pixel at the foot, as at the head.
        XCTAssertEqual(origins[3].y + diameter, 41)
    }

    func testAt2xTheDotsAreFourPixels() {
        let (diameter, origins) = Braille.origins(width: 16, height: 28)
        XCTAssertEqual(diameter, 4)
        XCTAssertEqual(origins.map(\.x), [2, 2, 2, 2, 10, 10, 10, 10])
        XCTAssertEqual(origins.map(\.y), [1, 8, 16, 23, 1, 8, 16, 23])
    }

    func testTheStampIsAHardRoundDot() {
        let stamp = Braille.stamp(diameter: 6)
        XCTAssertEqual(stamp.map(\.start), [1, 0, 0, 0, 0, 1])
        XCTAssertEqual(stamp.map(\.length), [4, 6, 6, 6, 6, 4])
    }

    func testTheWaveFallsHoldsAndRises() {
        let accuracy = 1e-9
        XCTAssertEqual(Braille.opacity(at: 0), 1, accuracy: accuracy)
        XCTAssertEqual(Braille.opacity(at: 30), 0.59, accuracy: accuracy)
        XCTAssertEqual(Braille.opacity(at: 60), 0.18, accuracy: accuracy)
        XCTAssertEqual(Braille.opacity(at: 99), 0.18, accuracy: accuracy)
        XCTAssertEqual(Braille.opacity(at: 130), 0.59, accuracy: accuracy)
        XCTAssertEqual(Braille.opacity(at: 160), 1, accuracy: accuracy)
        XCTAssertEqual(Braille.opacity(at: 799), 1, accuracy: accuracy)
        // A phase reaches back across the cycle.
        XCTAssertEqual(Braille.opacity(at: -770), 0.59, accuracy: accuracy)
    }

    func testElapsedReadsAsDesktopsClock() {
        XCTAssertEqual(Elapsed.text(milliseconds: 999), "0s")
        XCTAssertEqual(Elapsed.text(milliseconds: 59_999), "59s")
        XCTAssertEqual(Elapsed.text(milliseconds: 61_000), "1m 1s")
        XCTAssertEqual(Elapsed.text(milliseconds: 3_726_000), "1h 2m")
    }

    func testAWaitCountsDownInItsTwoLargestUnits() {
        XCTAssertEqual(Elapsed.remaining(milliseconds: 40_100), "41s")
        XCTAssertEqual(Elapsed.remaining(milliseconds: 300_000), "5m")
        XCTAssertEqual(Elapsed.remaining(milliseconds: 301_000), "5m 1s")
        XCTAssertEqual(Elapsed.remaining(milliseconds: 7_200_000), "2h")
        XCTAssertEqual(Elapsed.remaining(milliseconds: 90_000_000), "1d 1h")
        XCTAssertEqual(Elapsed.remaining(milliseconds: -5), "0s")
    }

    func testTheKeyframesAreTheWave() {
        for (time, opacity) in Braille.keyframes.dropLast() {
            XCTAssertEqual(Braille.opacity(at: time * Braille.cycle), opacity, accuracy: 1e-9)
        }
        XCTAssertEqual(Braille.keyframes.map(\.time), [0, 0.075, 0.125, 0.2, 1])
    }
}
