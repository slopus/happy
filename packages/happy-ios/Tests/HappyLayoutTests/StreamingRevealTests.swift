import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import XCTest
@testable import HappyLayout

/// Telegram's streaming reveal (`TextReveal`) and where a row's words are
/// as they come out (`RevealMap`).
final class StreamingRevealTests: XCTestCase {
    // MARK: TextReveal

    /// Before a second chunk says how fast they come, 40 a second, the
    /// speed easing up to it over 0.12 s.
    func testTheFirstChunkComesOutAtFortyASecond() {
        var reveal = TextReveal(revealed: 0, length: 0)
        reveal.observe(length: 200, at: 0)
        var time = 0.0
        _ = reveal.tick(at: time)
        while time < 1 {
            time += 1.0 / 120
            _ = reveal.tick(at: time)
        }
        // 40 a second, less what the speed took to come up: about 0.12 s' worth.
        XCTAssertEqual(reveal.revealed, 40 - 40 * TextReveal.speedTimeConstant, accuracy: 1.5)
    }

    /// Chunks 50 ms apart come out evenly: in no frame does the count leap,
    /// and it keeps close behind what has arrived.
    func testEvenChunksComeOutEvenly() {
        var reveal = TextReveal(revealed: 0, length: 0)
        var time = 0.0
        var length = 0
        var counts: [Double] = []
        var nextChunk = 0.0
        while time < 3 {
            if time >= nextChunk {
                length += 12
                reveal.observe(length: length, at: time)
                nextChunk += 0.05
            }
            _ = reveal.tick(at: time)
            counts.append(reveal.revealed)
            time += 1.0 / 120
        }
        let steps = zip(counts.dropFirst(), counts).map { $0 - $1 }
        XCTAssertTrue(steps.allSatisfy { $0 >= 0 }, "the count went back")
        // 240 characters a second is 2 a frame; never more than a few at once.
        let late = steps.suffix(240)
        XCTAssertLessThan(late.max() ?? 0, 4.5)
        XCTAssertGreaterThan(reveal.revealed, Double(length) - 30)
    }

    /// Once the text is whole, what is left comes out at the speed that
    /// would take 0.3 s, and the reveal says when it has.
    func testFinishingShowsTheRestWithinThreeTenths() {
        var reveal = TextReveal(revealed: 0, length: 0)
        reveal.observe(length: 300, at: 0)
        _ = reveal.tick(at: 0)
        _ = reveal.tick(at: 0.05)
        reveal.finish(length: 300)
        var time = 0.05
        var complete = false
        while !complete, time < 1 {
            time += 1.0 / 120
            complete = reveal.tick(at: time).complete
        }
        XCTAssertTrue(complete)
        // The speed eases up to the finishing speed over its time constant,
        // and the finishing speed falls as the lag does: half a second here.
        XCTAssertLessThan(time - 0.05, TextReveal.finishTime + 0.25)
        XCTAssertEqual(reveal.count, 300)
    }

    /// A hitch counts as one 50 ms frame, not a leap.
    func testALongFrameCountsAsFiftyMilliseconds() {
        var reveal = TextReveal(revealed: 0, length: 0)
        reveal.observe(length: 1000, at: 0)
        _ = reveal.tick(at: 0)
        for frame in 1...60 { _ = reveal.tick(at: Double(frame) / 120) }
        let before = reveal.revealed
        _ = reveal.tick(at: 0.5 + 2)
        XCTAssertLessThanOrEqual(reveal.revealed - before, 40 * TextReveal.longestFrame + 0.5)
    }

    /// Text that shrank (an edit) never shows more than there is.
    func testShrinkingTextClampsTheCount() {
        var reveal = TextReveal(revealed: 50, length: 80)
        reveal.observe(length: 30, at: 0)
        XCTAssertEqual(reveal.count, 30)
    }

    // MARK: RevealMap

    /// Two lines of five characters, 10 wide each, 20 tall, under 4 of
    /// padding, then a code block, in a row 100 wide and 74 tall.
    private func map() -> RevealMap {
        RevealMap(lines: [
            .init(frame: CGRect(x: 10, y: 0, width: 50, height: 20), ends: [20, 30, 40, 50, 60]),
            .init(frame: CGRect(x: 10, y: 20, width: 30, height: 20), ends: [20, 30, 40]),
            .init(block: CGRect(x: 0, y: 44, width: 100, height: 26), length: 7),
        ], size: CGSize(width: 100, height: 74))
    }

    func testCountsEveryCharacterAndBlock() {
        let map = map()
        XCTAssertEqual(map.length, 15)
        XCTAssertEqual(map.starts, [0, 5, 8])
        XCTAssertEqual(map.bottomPadding, 4)
    }

    /// The row grows a line at a time, never back.
    func testTheRowGrowsALineAtATime() {
        let map = map()
        let heights = (0...map.length).map(map.height(showing:))
        XCTAssertEqual(heights, [24, 24, 24, 24, 24, 24, 44, 44, 44, 74, 74, 74, 74, 74, 74, 74])
        XCTAssertEqual(zip(heights.dropFirst(), heights).filter { $0 < $1 }.count, 0)
    }

    /// The mask shows the lines before, and the current line from the
    /// row's edge to its last shown character.
    func testTheMaskShowsUpToTheLastCharacter() {
        let map = map()
        XCTAssertEqual(map.mask(showing: 0), [])
        XCTAssertEqual(map.mask(showing: 3), [CGRect(x: 0, y: 0, width: 40, height: 20)])
        XCTAssertEqual(map.mask(showing: 6), [CGRect(x: 0, y: 0, width: 100, height: 20), CGRect(x: 0, y: 20, width: 20, height: 20)])
        XCTAssertEqual(map.mask(showing: 9), [CGRect(x: 0, y: 0, width: 100, height: 44), CGRect(x: 0, y: 44, width: 100, height: 26)])
        XCTAssertEqual(map.mask(showing: 15), [CGRect(x: 0, y: 0, width: 100, height: 74)])
    }

    /// Each character comes out where it is drawn; a block once, whole.
    func testGlyphsComeOutWhereTheyAreDrawn() {
        let map = map()
        XCTAssertEqual(map.glyphs(from: 3, to: 7), [
            .init(index: 3, frame: CGRect(x: 40, y: 0, width: 10, height: 20), isBlock: false),
            .init(index: 4, frame: CGRect(x: 50, y: 0, width: 10, height: 20), isBlock: false),
            .init(index: 5, frame: CGRect(x: 10, y: 20, width: 10, height: 20), isBlock: false),
            .init(index: 6, frame: CGRect(x: 20, y: 20, width: 10, height: 20), isBlock: false),
        ])
        XCTAssertEqual(map.glyphs(from: 7, to: 15).map(\.index), [7, 8])
        XCTAssertEqual(map.glyphs(from: 9, to: 15), [])
    }

    /// A space has nothing to show, so no glyph comes out for it.
    func testSpacesBringNothingOut() {
        let map = RevealMap(lines: [.init(frame: CGRect(x: 0, y: 0, width: 30, height: 20), ends: [10, 10, 20])], size: CGSize(width: 30, height: 20))
        XCTAssertEqual(map.glyphs(from: 0, to: 3).map(\.index), [0, 2])
    }
}
