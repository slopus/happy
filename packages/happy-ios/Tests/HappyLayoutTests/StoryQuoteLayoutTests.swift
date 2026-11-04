import XCTest
@testable import HappyLayout

/// Desktop's story-reply quote above a person's bubble on a phone's width.
final class StoryQuoteLayoutTests: XCTestCase {
    private let label = Measurable.fixed(width: 34, height: 16)
    private let author = Measurable.fixed(width: 60, height: 20)

    func testTheQuoteSitsOverTheBubbleAgainstTheRightWithItsLinesCentredBesideTheFrame() throws {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, quote: (label, author, .fixed(width: 120, height: 16)))
        let quote = try XCTUnwrap(layout.quote)
        // 6 + 36 + 8 + the widest line (the caption) + 12; the frame's 64 + 6 above and below.
        XCTAssertEqual(quote.card, rect(192, 8, 182, 76))
        XCTAssertEqual(quote.frame, rect(198, 14, 36, 64))
        // 16 + 2 + 20 + 2 + 16 = 56, centred in the 76.
        XCTAssertEqual(quote.label, rect(242, 18, 34, 16))
        XCTAssertEqual(quote.avatar, rect(242, 36, 20, 20))
        XCTAssertEqual(quote.name, rect(268, 36, 60, 20))
        XCTAssertEqual(quote.caption, rect(242, 58, 120, 16))
        // The bubble 4 under it, as it would be at the top.
        XCTAssertEqual(layout.bubble, rect(310, 88, 64, 40))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 136))
    }

    func testALongCaptionIsCutAtTheCards280() {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, quote: (label, author, .fixed(width: 400, height: 16)))
        XCTAssertEqual(layout.quote?.card, rect(94, 8, 280, 76))
        XCTAssertEqual(layout.quote?.caption, rect(144, 58, 218, 16))
    }

    func testWithoutACaptionTheTwoLinesCentreOnTheFrame() {
        let quote = StoryQuoteLayout(width: 338, trailing: 374, top: 8, label: label, name: author, caption: nil)
        // As wide as the avatar and name: 20 + 6 + 60.
        XCTAssertEqual(quote.card, rect(226, 8, 148, 76))
        // 16 + 2 + 20 = 38, centred in the 76.
        XCTAssertEqual(quote.label, rect(276, 27, 34, 16))
        XCTAssertEqual(quote.avatar, rect(276, 45, 20, 20))
        XCTAssertEqual(quote.name, rect(302, 45, 60, 20))
        XCTAssertNil(quote.caption)
    }

    func testAMessageWithoutAStoryHasNoQuote() {
        XCTAssertNil(MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false).quote)
    }
}
