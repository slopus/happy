import Foundation
import HappyLayout
import XCTest
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A restored draft's height lands without animating, and is known to have
/// landed (`isMeasured`) before its composer is shown.
final class ComposerQuietGrowthTests: XCTestCase {
    private let key = ComposerTextHeights.Key(
        width: 361, style: TextStyles.composerInput, lineHeight: 22, paddingTop: 4, paddingBottom: 4, maxHeight: 120
    )
    private let otherWidth = ComposerTextHeights.Key(
        width: 700, style: TextStyles.composerInput, lineHeight: 22, paddingTop: 4, paddingBottom: 4, maxHeight: 120
    )

    private func stamp(_ key: ComposerTextHeights.Key, _ revision: Int, _ generation: Int) -> ComposerTextHeights.Stamp {
        ComposerTextHeights.Stamp(key: key, revision: revision, generation: generation)
    }

    private func live(_ revision: Int, _ generation: Int) -> ComposerTextHeights.Live {
        ComposerTextHeights.Live(revision: revision, generation: generation, isEmpty: false)
    }

    func testAnEarlierTextsMeasurementLandingFirstLeavesTheDraftQuiet() {
        var heights = ComposerTextHeights()
        // A typed text (generation 1, revision 1) is measuring at one width…
        let typed = stamp(otherWidth, 1, 1)
        XCTAssertEqual(heights.lookup(typed, isEmpty: false).measure, typed)
        // …when the restored draft replaces it (generation 2, revision 2),
        // before anything has asked for its height.
        var quiet: ComposerTextHeights.QuietGrowth? = .init(generation: 2, revision: 2)

        // The typed text's measurement lands: nothing more to measure yet.
        let early = heights.finish(typed, height: 52, live: live(2, 2))
        XCTAssertNil(early.measure)
        XCTAssertEqual(quiet?.isEnded(by: typed), false)
        if quiet?.isEnded(by: typed) == true { quiet = nil }
        XCTAssertNotNil(quiet, "an earlier text's landing doesn't end the draft's quiet growth")

        // The next layout asks for the draft's height; its measurement
        // lands quietly, and only that ends it.
        let draft = stamp(key, 2, 2)
        XCTAssertEqual(heights.lookup(draft, isEmpty: false).measure, draft)
        let landed = heights.finish(draft, height: 96, live: live(2, 2))
        XCTAssertTrue(landed.changed)
        XCTAssertEqual(quiet?.animates(generation: draft.generation), false)
        XCTAssertEqual(quiet?.isEnded(by: draft), true)
    }

    func testAnEditOfTheDraftBeforeItLandsEndsItWithItsOwnLanding() {
        let quiet = ComposerTextHeights.QuietGrowth(generation: 3, revision: 7)
        XCTAssertFalse(quiet.isEnded(by: stamp(key, 6, 3)), "the text before the draft")
        XCTAssertFalse(quiet.isEnded(by: stamp(key, 9, 2)), "another text")
        XCTAssertTrue(quiet.isEnded(by: stamp(key, 7, 3)))
        XCTAssertTrue(quiet.isEnded(by: stamp(key, 8, 3)), "coalesced to a later edit of it")
        XCTAssertTrue(quiet.animates(generation: 4))
        XCTAssertFalse(quiet.animates(generation: 3))
    }

    func testMeasuredMeansTheAnswerIsNotAGuess() {
        var heights = ComposerTextHeights()
        let draft = stamp(key, 1, 1)
        XCTAssertFalse(heights.isMeasured(draft, isEmpty: false))
        _ = heights.lookup(draft, isEmpty: false)
        XCTAssertFalse(heights.isMeasured(draft, isEmpty: false), "measuring is not measured")
        _ = heights.finish(draft, height: 96, live: live(1, 1))
        XCTAssertTrue(heights.isMeasured(draft, isEmpty: false))
        // Another width, or an edit since, is a guess again.
        XCTAssertFalse(heights.isMeasured(stamp(otherWidth, 1, 1), isEmpty: false))
        XCTAssertFalse(heights.isMeasured(stamp(key, 2, 1), isEmpty: false))
        // An empty text is one line, known without measuring; no width is
        // never measured.
        XCTAssertTrue(heights.isMeasured(stamp(otherWidth, 5, 4), isEmpty: true))
        XCTAssertFalse(heights.isMeasured(stamp(.init(width: 0, style: TextStyles.composerInput, lineHeight: 22, paddingTop: 4, paddingBottom: 4, maxHeight: 120), 1, 1), isEmpty: true))
    }

    func testALateMeasurementOfReplacedTextIsNotMeasuredForTheDraft() {
        var heights = ComposerTextHeights()
        let old = stamp(key, 1, 1)
        _ = heights.lookup(old, isEmpty: false)
        // Retargeted: the new chat's draft replaced it at the same width.
        let draft = stamp(key, 2, 2)
        _ = heights.lookup(draft, isEmpty: false)
        let late = heights.finish(old, height: 140, live: live(2, 2))
        XCTAssertFalse(heights.isMeasured(draft, isEmpty: false), "the old chat's height never stands for the draft")
        XCTAssertEqual(late.measure, draft)
        _ = heights.finish(draft, height: 30, live: live(2, 2))
        XCTAssertTrue(heights.isMeasured(draft, isEmpty: false))
        XCTAssertEqual(heights.lookup(draft, isEmpty: false).height, 30)
    }
}
