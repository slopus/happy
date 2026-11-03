import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import XCTest
@testable import HappyLayout

final class CallWavesTests: XCTestCase {
    func testTheOverhangCoversTheDeepestWave() {
        // 20 × 1.7 × ¼ × 1.3 = 11.05 for the crest, 16 of travel, one for the edge.
        XCTAssertEqual(CallWaves.overhang, 29)
    }

    func testFlatWavesAreTheBarsEdge() {
        let waves = CallWaves(seed: 1)
        let crests = waves.crests(width: 390, restY: 59, flat: true)
        XCTAssertEqual(crests.count, 3)
        for crest in crests {
            XCTAssertEqual(crest.start, CGPoint(x: 0, y: 59))
            XCTAssertEqual(crest.segments.map(\.to), [CGPoint(x: 390, y: 59)])
        }
    }

    func testTheSameSeedDrawsTheSameWaves() {
        var a = CallWaves(seed: 7), b = CallWaves(seed: 7)
        for _ in 0..<30 { a.advance(by: 1 / 60); b.advance(by: 1 / 60) }
        XCTAssertEqual(a.crests(width: 390, restY: 59, flat: false), b.crests(width: 390, restY: 59, flat: false))
        var c = CallWaves(seed: 8)
        for _ in 0..<30 { c.advance(by: 1 / 60) }
        XCTAssertNotEqual(a.crests(width: 390, restY: 59, flat: false), c.crests(width: 390, restY: 59, flat: false))
    }

    func testCrestsSpanTheBarAndStayWithinTheOverhang() {
        var waves = CallWaves(seed: 42)
        let restY: CGFloat = 59
        for frame in 0..<1200 {
            waves.update(level: frame % 120 < 60 ? 1.5 : 0)
            waves.advance(by: 1 / 60)
            for (index, crest) in waves.crests(width: 390, restY: restY, flat: false).enumerated() {
                XCTAssertEqual(crest.start.x, 0)
                XCTAssertEqual(crest.segments.last?.to.x ?? 0, 390, accuracy: 0.001)
                XCTAssertEqual(crest.segments.count, CallWaves.Constants.points - 1)
                for segment in crest.segments {
                    for point in [segment.to, segment.control1, segment.control2] {
                        XCTAssertLessThanOrEqual(point.y, restY + CallWaves.overhang, "wave \(index), frame \(frame)")
                        XCTAssertGreaterThanOrEqual(point.y, restY - CallWaves.Constants.amplitude, "wave \(index), frame \(frame)")
                    }
                }
            }
        }
    }

    func testTheTopWaveNeverSinksAndTheLowerOnesSinkWithTheLevel() {
        var quiet = CallWaves(seed: 3), loud = CallWaves(seed: 3)
        loud.update(level: 1.5)
        for _ in 0..<240 {
            quiet.advance(by: 1 / 60)
            loud.update(level: 1.5)
            loud.advance(by: 1 / 60)
        }
        XCTAssertEqual(quiet.shownLevel, 0)
        XCTAssertGreaterThan(loud.shownLevel, 0.95)
        // The ends of a crest are its rest plus its sinking.
        let quietCrests = quiet.crests(width: 100, restY: 50, flat: false)
        let loudCrests = loud.crests(width: 100, restY: 50, flat: false)
        XCTAssertEqual(quietCrests[2].start.y, 50)
        XCTAssertEqual(loudCrests[2].start.y, 50)
        XCTAssertEqual(quietCrests[0].start.y, 51.6, accuracy: 0.001)
        XCTAssertEqual(loudCrests[0].start.y, 50 + (0.1 + 0.9 * loud.shownLevel) * 16, accuracy: 0.001)
        XCTAssertEqual(loudCrests[1].start.y, 50 + (0.1 + 0.45 * loud.shownLevel) * 16, accuracy: 0.001)
        XCTAssertGreaterThan(loudCrests[0].start.y, loudCrests[1].start.y)
    }

    func testTheLevelIsSmoothedAsTelegramsIs() {
        var waves = CallWaves(seed: 1)
        waves.update(level: 1.5)
        waves.advance(by: 1 / 60)
        XCTAssertEqual(waves.level, 1)
        XCTAssertEqual(waves.shownLevel, 0.07, accuracy: 0.0001)
        waves.update(level: -3)
        XCTAssertEqual(waves.level, 0)
    }

    func testEaseInOut() {
        XCTAssertEqual(CallWaves.easeInOut(0), 0, accuracy: 0.0001)
        XCTAssertEqual(CallWaves.easeInOut(1), 1, accuracy: 0.0001)
        XCTAssertEqual(CallWaves.easeInOut(0.5), 0.5, accuracy: 0.0001)
        XCTAssertLessThan(CallWaves.easeInOut(0.2), 0.2)
    }
}
