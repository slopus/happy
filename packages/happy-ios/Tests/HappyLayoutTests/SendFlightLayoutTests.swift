import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class SendFlightLayoutTests: XCTestCase {
    /// An iPhone 12, its composer's field as the long-paste repro had it.
    private let screen = rect(0, 0, 390, 844)
    private let field = rect(26.33, 326.67, 337.33, 120)

    /// A short draft's words, laid out whole inside the field, fly from
    /// where they are.
    func testAShortDraftsWordsAreCarriedWhereTheFieldShowsThem() {
        let words = rect(38.33, 334.67, 120, 24)
        let source = SendFlightLayout.Source(screen: screen, field: field, text: words, scrolls: false)
        XCTAssertEqual(source.words, words)
        XCTAssertNil(source.snapshot)
        let row = rect(0, 600, 390, 56)
        XCTAssertEqual(SendFlightLayout(screen: screen, row: row, source: source, media: false).style, .morph)
    }

    /// The repro: 6,303 characters scrolled to their end put the whole
    /// draft's layout at y -5250, 5830 tall, over the status bar and the
    /// header. Such a draft is never drawn whole: only what the field
    /// shows, inside the field, and the row slides in.
    func testAScrolledDraftDrawsOnlyWhatTheFieldShows() {
        let whole = rect(38.33, -5250, 303.33, 5830)
        let source = SendFlightLayout.Source(screen: screen, field: field, text: whole, scrolls: true)
        XCTAssertNil(source.words)
        XCTAssertEqual(source.snapshot, field)
        let row = rect(0, 200, 390, 400)
        XCTAssertEqual(SendFlightLayout(screen: screen, row: row, source: source, media: false).style, .slide)
    }

    /// The field reports scrolling only past its cap, but a layout that
    /// spills past the field is never carried either way.
    func testWordsSpillingPastTheFieldAreNotCarried() {
        let spills = rect(38.33, 300, 303.33, 200)
        let source = SendFlightLayout.Source(screen: screen, field: field, text: spills, scrolls: false)
        XCTAssertNil(source.words)
        XCTAssertEqual(source.snapshot, field)
    }

    /// A field partly off screen (the keyboard's move mid-send) shows only
    /// its part on it; one wholly off shows nothing.
    func testTheSnapshotIsClippedToTheScreen() {
        let low = rect(26, 800, 337, 120)
        let source = SendFlightLayout.Source(screen: screen, field: low, text: nil, scrolls: true)
        XCTAssertEqual(source.snapshot, rect(26, 800, 337, 44))
        let gone = SendFlightLayout.Source(screen: screen, field: rect(26, 900, 337, 120), text: rect(30, 910, 100, 24), scrolls: false)
        XCTAssertNil(gone.words)
        XCTAssertNil(gone.snapshot)
    }

    /// Pictures alone leave nothing over the composer.
    func testNoWordsNoSnapshot() {
        let source = SendFlightLayout.Source(screen: screen, field: field, text: nil, scrolls: false)
        XCTAssertNil(source.words)
        XCTAssertNil(source.snapshot)
        XCTAssertEqual(SendFlightLayout(screen: screen, row: rect(0, 600, 390, 200), source: source, media: true).style, .slide)
    }

    /// A row with pictures, or one reaching past the screen, slides in: the
    /// copy that morphs is the row's, and it must fit on screen.
    func testOnlyARowOnScreenMorphs() {
        let source = SendFlightLayout.Source(screen: screen, field: field, text: rect(38.33, 334.67, 120, 24), scrolls: false)
        XCTAssertEqual(SendFlightLayout(screen: screen, row: rect(0, 600, 390, 56), source: source, media: true).style, .slide)
        XCTAssertEqual(SendFlightLayout(screen: screen, row: rect(0, -40, 390, 700), source: source, media: false).style, .slide)
        XCTAssertEqual(SendFlightLayout(screen: screen, row: rect(0, 800, 390, 100), source: source, media: false).style, .slide)
    }

    /// Whatever the draft and the row, everything the flight draws is on
    /// screen: the carried words, the snapshot, and the copy that morphs.
    func testNothingIsEverDrawnOffScreen() {
        let fields = [field, rect(26, 700, 337, 120), rect(26, -60, 337, 120), rect(8, 0, 374, 844)]
        let texts: [CGRect?] = [nil, rect(38, 334, 120, 24), rect(38, -5250, 303, 5830), rect(38, 700, 300, 400)]
        let rows = [rect(0, 600, 390, 56), rect(0, -100, 390, 300), rect(0, 0, 390, 844), rect(0, 820, 390, 60)]
        for field in fields {
            for text in texts {
                for scrolls in [false, true] {
                    let source = SendFlightLayout.Source(screen: screen, field: field, text: text, scrolls: scrolls)
                    for drawn in [source.words, source.snapshot].compactMap({ $0 }) {
                        XCTAssertTrue(screen.contains(drawn), "\(drawn) from \(field), \(String(describing: text))")
                    }
                    for row in rows {
                        for media in [false, true] where SendFlightLayout(screen: screen, row: row, source: source, media: media).style == .morph {
                            XCTAssertTrue(screen.contains(row), "\(row) morphs")
                        }
                    }
                }
            }
        }
    }

    func testTallTextIsTiled() {
        XCTAssertFalse(ChatTextTiling.tiles(height: 1024))
        XCTAssertTrue(ChatTextTiling.tiles(height: 1025))
        // A folded message, 70 lines of 24, is tiled; a 30-line one is not.
        XCTAssertTrue(ChatTextTiling.tiles(height: 70 * 24))
        XCTAssertFalse(ChatTextTiling.tiles(height: 30 * 24))
        XCTAssertEqual(ChatTextTiling.tile, 512)
    }
}
