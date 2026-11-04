import XCTest
@testable import HappyLayout

/// Desktop's story-reply quote above a person's bubble on a phone's width.
final class StoryQuoteLayoutTests: XCTestCase {
    private let label = Measurable.fixed(width: 34, height: 16)
    private let author = Measurable.fixed(width: 60, height: 18)

    func testTheQuoteSitsOverTheBubbleAgainstTheRightWithItsLinesCentredBesideTheFrame() throws {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, quote: (label, author, .fixed(width: 120, height: 16)))
        let quote = try XCTUnwrap(layout.quote)
        // 6 + 36 + 8 + the widest line (the caption) + 6; the frame's 64 + 6 above and below.
        XCTAssertEqual(quote.card, rect(198, 8, 176, 76))
        XCTAssertEqual(quote.frame, rect(204, 14, 36, 64))
        // 16 + 2 + 18 + 2 + 16 = 54, centred in the 76.
        XCTAssertEqual(quote.label, rect(248, 19, 34, 16))
        XCTAssertEqual(quote.avatar, rect(248, 38, 16, 16))
        XCTAssertEqual(quote.name, rect(270, 37, 60, 18))
        XCTAssertEqual(quote.caption, rect(248, 57, 120, 16))
        // The bubble 4 under it, as it would be at the top.
        XCTAssertEqual(layout.bubble, rect(310, 88, 64, 40))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 136))
    }

    func testALongCaptionIsCutAtTheCards280() {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, quote: (label, author, .fixed(width: 400, height: 16)))
        XCTAssertEqual(layout.quote?.card, rect(94, 8, 280, 76))
        XCTAssertEqual(layout.quote?.caption, rect(144, 57, 224, 16))
    }

    func testWithoutACaptionTheTwoLinesCentreOnTheFrame() {
        let quote = StoryQuoteLayout(width: 338, trailing: 374, top: 8, label: label, name: author, caption: nil)
        // As wide as the avatar and name: 16 + 6 + 60.
        XCTAssertEqual(quote.card, rect(236, 8, 138, 76))
        // 16 + 2 + 18 = 36, centred in the 76.
        XCTAssertEqual(quote.label, rect(286, 28, 34, 16))
        XCTAssertEqual(quote.avatar, rect(286, 47, 16, 16))
        XCTAssertEqual(quote.name, rect(308, 46, 60, 18))
        XCTAssertNil(quote.caption)
    }

    func testAMessageWithoutAStoryHasNoQuote() {
        XCTAssertNil(MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false).quote)
    }
}
