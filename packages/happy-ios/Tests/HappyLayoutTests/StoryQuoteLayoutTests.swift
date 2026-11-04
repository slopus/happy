import XCTest
@testable import HappyLayout

/// Desktop's story-reply quote above a person's bubble, and another
/// person's message at the left, on a phone's width.
final class StoryQuoteLayoutTests: XCTestCase {
    private let author = Measurable.fixed(width: 60, height: 20)
    private let ana = Measurable.fixed(width: 50, height: 20)

    func testTheQuoteIsAPhotoOfTheStoryWithItsAuthorUnderItAgainstTheRight() throws {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, quote: author)
        let quote = try XCTUnwrap(layout.quote)
        // One 9:16 photo under the message's 360: 202.5 wide, at the right.
        XCTAssertEqual(quote.frame, rect(171.5, 8, 202.5, 360))
        // 6 under it, the avatar and name ending at the right too.
        XCTAssertEqual(quote.author.avatar, rect(288, 374, 20, 20))
        XCTAssertEqual(quote.author.name, rect(314, 374, 60, 20))
        // The bubble 8 under them.
        XCTAssertEqual(layout.bubble, rect(310, 402, 64, 40))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 450))
        XCTAssertNil(layout.sender)
    }

    func testATeammatesReplyStandsAtTheLeftUnderTheirName() throws {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, quote: author, sender: ana)
        let sender = try XCTUnwrap(layout.sender)
        XCTAssertEqual(sender.avatar, rect(16, 8, 20, 20))
        XCTAssertEqual(sender.name, rect(42, 8, 50, 20))
        // 4 under the name, the quote and the bubble against the left.
        let quote = try XCTUnwrap(layout.quote)
        XCTAssertEqual(quote.frame, rect(16, 32, 202.5, 360))
        XCTAssertEqual(quote.author.avatar, rect(16, 398, 20, 20))
        XCTAssertEqual(quote.author.name, rect(42, 398, 60, 20))
        XCTAssertEqual(layout.bubble, rect(16, 426, 64, 40))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 474))
    }

    func testATeammatesPhotosHugTheLeft() {
        let layout = MessageLayout.user(width: 390, text: nil, pictures: [MediaFlow.Image(width: 800, height: 600)], showsStatus: false, sender: ana)
        XCTAssertEqual(layout.pictures.first?.minX, 16)
        XCTAssertEqual(layout.pictures.first?.minY, 32)
    }

    func testAMessageWithoutAStoryHasNoQuote() {
        XCTAssertNil(MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false).quote)
    }
}
