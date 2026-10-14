import Foundation
import HappyLayout
import XCTest
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The composer's text heights, measured off the main thread: what a
/// layout is given before and after a measurement lands, which
/// measurements run, and the early stop at the cap.
final class ComposerTextHeightsTests: XCTestCase {
    private func key(width: CGFloat = 361, line: CGFloat = 22) -> ComposerTextHeights.Key {
        ComposerTextHeights.Key(
            width: width,
            style: TextStyles.composerInput,
            lineHeight: line,
            paddingTop: 4,
            paddingBottom: 4,
            maxHeight: 120
        )
    }

    private func stamp(_ key: ComposerTextHeights.Key, _ revision: Int, generation: Int = 0) -> ComposerTextHeights.Stamp {
        ComposerTextHeights.Stamp(key: key, revision: revision, generation: generation)
    }

    private func live(_ revision: Int, generation: Int = 0, isEmpty: Bool = false) -> ComposerTextHeights.Live {
        ComposerTextHeights.Live(revision: revision, generation: generation, isEmpty: isEmpty)
    }

    // MARK: The early stop

    func testTheKeysArithmetic() {
        let key = key()
        XCTAssertEqual(key.measureLimit, 142)
        XCTAssertEqual(key.oneLine, 30)
        XCTAssertEqual(key.contentHeight(usedHeight: 44, fits: true), 52)
        XCTAssertEqual(key.contentHeight(usedHeight: 66.4, fits: true), 75)
        // Cut off: at least the cap.
        XCTAssertEqual(key.contentHeight(usedHeight: 132, fits: false), 140)
        XCTAssertEqual(key.contentHeight(usedHeight: 0, fits: false), 120)
    }

    /// Lines of a fixed height in the `measureLimit` container, as TextKit
    /// places them: whole lines while they fit. `extraLine` is the empty
    /// line after a trailing newline, which isn't a character.
    private func measure(lines: Int, extraLine: Bool, key: ComposerTextHeights.Key) -> CGFloat {
        let fitting = Int((key.measureLimit / key.lineHeight).rounded(.down))
        let placed = min(lines, fitting)
        let extra = extraLine && lines < fitting ? 1 : 0
        return key.contentHeight(usedHeight: CGFloat(placed + extra) * key.lineHeight, fits: lines <= fitting)
    }

    func testStoppingAtTheCapNeverChangesWhatIsShown() {
        // The designed line, and the largest text size's.
        for line in [22, 22 * 3.571] as [CGFloat] {
            let key = key(line: line)
            for lines in 1...60 {
                for extraLine in [false, true] {
                    // Measured whole, ceiled as the text view's size is.
                    let whole = (CGFloat(lines + (extraLine ? 1 : 0)) * line + 8).rounded(.up)
                    let shown = MultiTextInputLayout(contentHeight: whole, maxHeight: 120, lineHeight: line, paddingTop: 4, paddingBottom: 4)
                    let measured = MultiTextInputLayout(
                        contentHeight: measure(lines: lines, extraLine: extraLine, key: key),
                        maxHeight: 120, lineHeight: line, paddingTop: 4, paddingBottom: 4
                    )
                    XCTAssertEqual(measured, shown, "\(lines) lines of \(line), extra line \(extraLine)")
                }
            }
        }
    }

    // MARK: Lookups and results

    func testTheFirstLookupGuessesOneLineAndMeasures() {
        var heights = ComposerTextHeights()
        let key = key()
        let first = heights.lookup(stamp(key, 1), isEmpty: false)
        XCTAssertEqual(first, .init(height: 30, measure: stamp(key, 1)))
        // Asked again while it runs: the same guess, nothing more started.
        XCTAssertEqual(heights.lookup(stamp(key, 1), isEmpty: false), .init(height: 30, measure: nil))

        let finish = heights.finish(stamp(key, 1), height: 74, live: live(1))
        XCTAssertEqual(finish, .init(changed: true, measure: nil))
        XCTAssertNil(heights.inFlight)
        XCTAssertEqual(heights.lookup(stamp(key, 1), isEmpty: false), .init(height: 74, measure: nil))
    }

    func testAResultThatMovesNothingLaysNothingOut() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        XCTAssertEqual(heights.finish(stamp(key, 1), height: 30, live: live(1)), .init(changed: false, measure: nil))
    }

    func testAnEditKeepsTheLastHeightUntilItIsMeasured() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        _ = heights.finish(stamp(key, 1), height: 52, live: live(1))
        XCTAssertEqual(heights.lookup(stamp(key, 2), isEmpty: false), .init(height: 52, measure: stamp(key, 2)))
        XCTAssertEqual(heights.finish(stamp(key, 2), height: 74, live: live(2)), .init(changed: true, measure: nil))
    }

    func testTypingWhileItMeasuresIsCoalescedToTheNewestText() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        // Three keystrokes while the first measurement runs.
        for revision in 2...4 {
            XCTAssertEqual(heights.lookup(stamp(key, revision), isEmpty: false).measure, nil)
        }
        // The first lands: shown as the guess, and the text as it is now
        // (a fifth keystroke since) is measured next, once.
        XCTAssertEqual(heights.finish(stamp(key, 1), height: 52, live: live(5)), .init(changed: true, measure: stamp(key, 5)))
        XCTAssertEqual(heights.inFlight, stamp(key, 5))
        XCTAssertEqual(heights.finish(stamp(key, 5), height: 74, live: live(5)), .init(changed: true, measure: nil))
        XCTAssertEqual(heights.lookup(stamp(key, 5), isEmpty: false), .init(height: 74, measure: nil))
    }

    func testReplacedTextDropsALateMeasurement() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        _ = heights.finish(stamp(key, 1), height: 30, live: live(1))
        // A long draft is measuring when another session's draft replaces it.
        _ = heights.lookup(stamp(key, 2), isEmpty: false)
        XCTAssertEqual(heights.lookup(stamp(key, 3, generation: 1), isEmpty: false).measure, nil)
        let late = heights.finish(stamp(key, 2), height: 140, live: live(3, generation: 1))
        // Not shown, even for a moment; the new draft is measured.
        XCTAssertEqual(late, .init(changed: false, measure: stamp(key, 3, generation: 1)))
        XCTAssertEqual(heights.lookup(stamp(key, 3, generation: 1), isEmpty: false).height, 30)
        XCTAssertEqual(heights.finish(stamp(key, 3, generation: 1), height: 52, live: live(3, generation: 1)).changed, true)
    }

    func testAnOlderResultNeverReplacesANewerOne() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        // Cleared while the long text measures: one line, known at once.
        XCTAssertEqual(heights.lookup(stamp(key, 2), isEmpty: true).height, 30)
        let late = heights.finish(stamp(key, 1), height: 140, live: live(2, isEmpty: true))
        XCTAssertEqual(late, .init(changed: false, measure: nil))
        XCTAssertEqual(heights.lookup(stamp(key, 2), isEmpty: true).height, 30)
    }

    func testAnEmptyTextIsOneLineAtOnce() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        _ = heights.finish(stamp(key, 1), height: 120, live: live(1))
        XCTAssertEqual(heights.lookup(stamp(key, 2), isEmpty: true), .init(height: 30, measure: nil))
        // Typing again starts from one line.
        XCTAssertEqual(heights.lookup(stamp(key, 3), isEmpty: false), .init(height: 30, measure: stamp(key, 3)))
    }

    func testTextEmptiedWhileMeasuringNeedsNoMeasurement() {
        var heights = ComposerTextHeights()
        let key = key()
        _ = heights.lookup(stamp(key, 1), isEmpty: false)
        _ = heights.lookup(stamp(key, 2), isEmpty: false)
        let finish = heights.finish(stamp(key, 1), height: 74, live: live(3, isEmpty: true))
        XCTAssertNil(finish.measure)
        XCTAssertNil(heights.inFlight)
        XCTAssertEqual(heights.lookup(stamp(key, 3), isEmpty: true).height, 30)
    }

    func testTwoWidthsAPassAreEachMeasuredOnce() {
        var heights = ComposerTextHeights()
        let card = key()
        let panel = key(width: 784)
        var started: [ComposerTextHeights.Stamp] = []
        // The layout asks at both widths each pass; each landing lays out
        // again.
        for _ in 0..<4 {
            for key in [card, panel] {
                if let measure = heights.lookup(stamp(key, 1), isEmpty: false).measure {
                    started.append(measure)
                }
            }
            if let running = heights.inFlight {
                var next: ComposerTextHeights.Stamp? = running
                while let measuring = next {
                    next = heights.finish(measuring, height: measuring.key == card ? 52 : 30, live: live(1)).measure
                    if let next { started.append(next) }
                }
            }
        }
        XCTAssertEqual(started, [stamp(card, 1), stamp(panel, 1)])
        XCTAssertEqual(heights.lookup(stamp(card, 1), isEmpty: false), .init(height: 52, measure: nil))
        XCTAssertEqual(heights.lookup(stamp(panel, 1), isEmpty: false), .init(height: 30, measure: nil))
    }

    func testANewWidthGuessesTheLastHeight() {
        var heights = ComposerTextHeights()
        _ = heights.lookup(stamp(key(), 1), isEmpty: false)
        _ = heights.finish(stamp(key(), 1), height: 74, live: live(1))
        // Rotated: the text wraps at a new width, measured from the last.
        XCTAssertEqual(heights.lookup(stamp(key(width: 700), 1), isEmpty: false), .init(height: 74, measure: stamp(key(width: 700), 1)))
    }

    func testATextSizeChangeIsANewKey() {
        var heights = ComposerTextHeights()
        let designed = key()
        _ = heights.lookup(stamp(designed, 1), isEmpty: false)
        _ = heights.finish(stamp(designed, 1), height: 30, live: live(1))
        var larger = designed
        larger.style = TextStyles.composerInput.scaled(TextScale(.accessibilityExtraExtraExtraLarge))
        larger.lineHeight = larger.style.lineHeight ?? 0
        XCTAssertEqual(heights.lookup(stamp(larger, 1), isEmpty: false).measure, stamp(larger, 1))
    }

    func testNoWidthMeasuresNothing() {
        var heights = ComposerTextHeights()
        let zero = key(width: 0)
        XCTAssertEqual(heights.lookup(stamp(zero, 1), isEmpty: false), .init(height: 30, measure: nil))
        XCTAssertNil(heights.inFlight)
        // Nor is it kept as a width to lay out again for.
        _ = heights.lookup(stamp(key(), 1), isEmpty: false)
        XCTAssertEqual(heights.finish(stamp(key(), 1), height: 30, live: live(1)), .init(changed: false, measure: nil))
    }

    func testOnlyAFewWidthsAreKept() {
        var heights = ComposerTextHeights()
        let widths: [CGFloat] = [300, 310, 320, 330, 340]
        for width in widths {
            let stamp = stamp(key(width: width), 1)
            _ = heights.lookup(stamp, isEmpty: false)
            _ = heights.finish(stamp, height: width / 10, live: live(1))
        }
        // The oldest was dropped and is measured again; the rest are kept.
        XCTAssertEqual(heights.lookup(stamp(key(width: 340), 1), isEmpty: false).measure, nil)
        XCTAssertEqual(heights.lookup(stamp(key(width: 310), 1), isEmpty: false).measure, nil)
        XCTAssertEqual(heights.lookup(stamp(key(width: 300), 1), isEmpty: false).measure, stamp(key(width: 300), 1))
        XCTAssertEqual(ComposerTextHeights.keptKeys, 4)
    }

    func testAResultForADroppedWidthIsDropped() {
        var heights = ComposerTextHeights()
        let old = key(width: 200)
        _ = heights.lookup(stamp(old, 1), isEmpty: false)
        for width in [300, 310, 320, 330] as [CGFloat] {
            _ = heights.lookup(stamp(key(width: width), 1), isEmpty: false)
        }
        let finish = heights.finish(stamp(old, 1), height: 99, live: live(1))
        XCTAssertNotEqual(heights.lookup(stamp(key(width: 330), 1), isEmpty: false).height, 99)
        // The newest width asked for is measured next.
        XCTAssertEqual(finish.measure, stamp(key(width: 330), 1))
    }
}
