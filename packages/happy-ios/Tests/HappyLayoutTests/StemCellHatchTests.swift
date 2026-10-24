import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The hatch's timing is desktop's `stemCellTimeline`; its haptic is sampled
/// from the same curves, so the samples here pin both.
final class StemCellHatchTests: XCTestCase {
    func testTheTimelineIsDesktops() {
        let time = StemCellHatch.Timeline(depth: 3)
        XCTAssertEqual(time.intro, 0.1, accuracy: 1e-9)
        XCTAssertEqual(time.divisionsEnd, 1.55, accuracy: 1e-9)
        XCTAssertEqual(time.starts[0], 0.1, accuracy: 1e-9)
        XCTAssertEqual(time.durations[0], 0.87853, accuracy: 1e-5)
        XCTAssertEqual(time.durations[1], 0.33720, accuracy: 1e-5)
        XCTAssertEqual(time.durations[2], 0.23427, accuracy: 1e-5)
        XCTAssertEqual(time.starts[2] + time.durations[2], 1.55, accuracy: 1e-9)
        XCTAssertEqual(time.formed, 2.462, accuracy: 1e-9)
        XCTAssertEqual(StemCellHatch.generations(size: 20), 3)
        XCTAssertEqual(StemCellHatch.generations(size: 64), 4)
    }

    func testTheWaveAtFixedTimes() {
        let wave = { (t: Double) in StemCellHatch.intensity(at: t, generations: 3) }
        XCTAssertEqual(wave(0.05), 0, "still before the intro")
        // The first cleavage's crest, halfway through its division.
        XCTAssertEqual(wave(0.53927), 0.35, accuracy: 1e-3)
        // Between crests, the floor.
        XCTAssertEqual(wave(0.97), 0.12, accuracy: 1e-9)
        // The last, sharpest crest is the tallest.
        XCTAssertEqual(wave(1.43287), 0.85, accuracy: 1e-3)
        // Convergence: a damped ripple from 0.55, a trough at q = 1/6, a crest at 1/3.
        XCTAssertEqual(wave(1.55), 0.55, accuracy: 1e-9)
        XCTAssertEqual(wave(1.55 + 0.95 / 6), 0, accuracy: 1e-9)
        XCTAssertEqual(wave(1.55 + 0.95 / 3), 0.55 * exp(-1), accuracy: 1e-9)
        XCTAssertEqual(wave(2.47), 0, "settled once the picture has formed")
        XCTAssertEqual(StemCellHatch.sharpness(at: 0, generations: 3), 0.2, accuracy: 1e-9)
        XCTAssertEqual(StemCellHatch.sharpness(at: 2, generations: 3), 0.6, accuracy: 1e-9)
    }

    func testThePatternForALaneMark() {
        let haptics = StemCellHatch.haptics(size: 20)
        // A tap at each tear, stronger and sharper as the cells get smaller,
        // and the crisp one where the picture forms.
        XCTAssertEqual(haptics.taps, [
            .init(time: 0.539, intensity: 0.45, sharpness: 0.35),
            .init(time: 1.147, intensity: 0.575, sharpness: 0.55),
            .init(time: 1.433, intensity: 0.7, sharpness: 0.75),
            .init(time: 2.462, intensity: 0.8, sharpness: 0.9),
        ])
        XCTAssertEqual(haptics.start, 0.1)
        XCTAssertEqual(haptics.duration, 2.362)
        XCTAssertEqual(haptics.intensity.count, 48)
        XCTAssertEqual(haptics.intensity.first?.time, 0)
        XCTAssertEqual(haptics.intensity[9].time, 0.45, accuracy: 1e-9)
        XCTAssertEqual(haptics.intensity[9].value, StemCellHatch.round3(StemCellHatch.intensity(at: 0.55, generations: 3)))
        XCTAssertEqual(haptics.sharpness.last?.value ?? 0, 0.6, accuracy: 1e-9)
    }

    func testTheCellsDivideThenThePictureTakesOver() {
        let start = StemCellHatch.frame(at: 0, size: 20, seed: "a")
        XCTAssertEqual(start.cells.count, 8)
        XCTAssertTrue(start.cells.allSatisfy { $0 == .init(center: CGPoint(x: 10, y: 10), radius: 9) }, "one cell before it divides")
        XCTAssertEqual(start.pictureAlpha, 0)
        let divided = StemCellHatch.frame(at: 1.55, size: 20, seed: "a")
        XCTAssertEqual(Set(divided.cells.map { "\($0.center.x),\($0.center.y)" }).count, 8, "eight cells apart")
        XCTAssertEqual(divided.coreAlpha, 1 - CGFloat(StemCellHatch.smoothstep(1.55 - 0.23427 * 0.3, 1.55 + 0.095, 1.55)), accuracy: 1e-4)
        let end = StemCellHatch.frame(at: 2.5, size: 20, seed: "a")
        XCTAssertEqual(end.pictureAlpha, 1)
        XCTAssertEqual(end.pictureScale, 1)
        XCTAssertEqual(end.cellAlpha, 0)
    }
}
