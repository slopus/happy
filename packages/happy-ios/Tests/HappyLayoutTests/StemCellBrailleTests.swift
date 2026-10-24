@testable import HappyLayout
import XCTest

/// Desktop's braille loader on a phone's pixels: the same stamp eight
/// times at whole-pixel origins, and the one wave every dot runs.
final class StemCellBrailleTests: XCTestCase {
    func testAt3xTheDotsAreSixPixelsWithTheSpareRowInTheMiddleGap() {
        let (diameter, origins) = StemCellBraille.origins(width: 24, height: 42)
        XCTAssertEqual(diameter, 6)
        XCTAssertEqual(origins.map(\.x), [3, 3, 3, 3, 15, 15, 15, 15])
        XCTAssertEqual(origins.map(\.y), [1, 12, 24, 35, 1, 12, 24, 35])
        // One clear pixel at the foot, as at the head.
        XCTAssertEqual(origins[3].y + diameter, 41)
    }

    func testAt2xTheDotsAreFourPixels() {
        let (diameter, origins) = StemCellBraille.origins(width: 16, height: 28)
        XCTAssertEqual(diameter, 4)
        XCTAssertEqual(origins.map(\.x), [2, 2, 2, 2, 10, 10, 10, 10])
        XCTAssertEqual(origins.map(\.y), [1, 8, 16, 23, 1, 8, 16, 23])
    }

    func testTheStampIsAHardRoundDot() {
        let stamp = StemCellBraille.stamp(diameter: 6)
        XCTAssertEqual(stamp.map(\.start), [1, 0, 0, 0, 0, 1])
        XCTAssertEqual(stamp.map(\.length), [4, 6, 6, 6, 6, 4])
    }

    func testTheWaveFallsHoldsAndRises() {
        let accuracy = 1e-9
        XCTAssertEqual(StemCellBraille.opacity(at: 0), 1, accuracy: accuracy)
        XCTAssertEqual(StemCellBraille.opacity(at: 30), 0.59, accuracy: accuracy)
        XCTAssertEqual(StemCellBraille.opacity(at: 60), 0.18, accuracy: accuracy)
        XCTAssertEqual(StemCellBraille.opacity(at: 99), 0.18, accuracy: accuracy)
        XCTAssertEqual(StemCellBraille.opacity(at: 130), 0.59, accuracy: accuracy)
        XCTAssertEqual(StemCellBraille.opacity(at: 160), 1, accuracy: accuracy)
        XCTAssertEqual(StemCellBraille.opacity(at: 799), 1, accuracy: accuracy)
        // A phase reaches back across the cycle.
        XCTAssertEqual(StemCellBraille.opacity(at: -770), 0.59, accuracy: accuracy)
    }

    func testElapsedReadsAsDesktopsClock() {
        XCTAssertEqual(StemCellElapsed.text(milliseconds: 999), "0s")
        XCTAssertEqual(StemCellElapsed.text(milliseconds: 59_999), "59s")
        XCTAssertEqual(StemCellElapsed.text(milliseconds: 61_000), "1m 1s")
        XCTAssertEqual(StemCellElapsed.text(milliseconds: 3_726_000), "1h 2m")
    }

    func testAWaitCountsDownInItsTwoLargestUnits() {
        XCTAssertEqual(StemCellElapsed.remaining(milliseconds: 40_100), "41s")
        XCTAssertEqual(StemCellElapsed.remaining(milliseconds: 300_000), "5m")
        XCTAssertEqual(StemCellElapsed.remaining(milliseconds: 301_000), "5m 1s")
        XCTAssertEqual(StemCellElapsed.remaining(milliseconds: 7_200_000), "2h")
        XCTAssertEqual(StemCellElapsed.remaining(milliseconds: 90_000_000), "1d 1h")
        XCTAssertEqual(StemCellElapsed.remaining(milliseconds: -5), "0s")
    }

    func testTheKeyframesAreTheWave() {
        for (time, opacity) in StemCellBraille.keyframes.dropLast() {
            XCTAssertEqual(StemCellBraille.opacity(at: time * StemCellBraille.cycle), opacity, accuracy: 1e-9)
        }
        XCTAssertEqual(StemCellBraille.keyframes.map(\.time), [0, 0.075, 0.125, 0.2, 1])
    }
}
