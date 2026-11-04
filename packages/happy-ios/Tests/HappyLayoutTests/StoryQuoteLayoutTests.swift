import XCTest
@testable import HappyLayout

/// Instagram's story reply above a person's bubble, and another person's
/// message at the left, on a phone's width.
final class StoryQuoteLayoutTests: XCTestCase {
    /// "Ana Ruiz Replied to your story", 14/20.
    private let line = Measurable.fixed(width: 200, height: 20)

    func testTheReadersReplyIsTheLineThenTheFrameWithItsBarAgainstTheRight() throws {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, header: line, quote: true)
        let header = try XCTUnwrap(layout.header)
        // The 16 avatar and the line, ending at the right.
        XCTAssertEqual(header.avatar, rect(152, 10, 16, 16))
        XCTAssertEqual(header.name, rect(174, 8, 200, 20))
        let quote = try XCTUnwrap(layout.quote)
        // 4 under it one 9:16 photo of a message, 8 in from the 3 bar at the edge.
        XCTAssertEqual(quote.frame, rect(160.5, 32, 202.5, 360))
        XCTAssertEqual(quote.bar, rect(371, 32, 3, 360))
        // The bubble 4 under the frame.
        XCTAssertEqual(layout.bubble, rect(310, 396, 64, 40))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 444))
    }

    func testATeammatesReplyStandsAtTheLeftWithTheBarOutside() throws {
        let layout = MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false, header: line, quote: true, leading: true)
        XCTAssertEqual(layout.header?.avatar, rect(16, 10, 16, 16))
        XCTAssertEqual(layout.header?.name, rect(38, 8, 200, 20))
        XCTAssertEqual(layout.quote?.bar, rect(16, 32, 3, 360))
        XCTAssertEqual(layout.quote?.frame, rect(27, 32, 202.5, 360))
        XCTAssertEqual(layout.bubble, rect(16, 396, 64, 40))
    }

    func testATeammatesPhotosHugTheLeftUnderTheirName() {
        let layout = MessageLayout.user(width: 390, text: nil, pictures: [MediaFlow.Image(width: 800, height: 600)], showsStatus: false, header: line, leading: true)
        XCTAssertEqual(layout.pictures.first?.minX, 16)
        XCTAssertEqual(layout.pictures.first?.minY, 32)
        XCTAssertNil(layout.quote)
    }

    func testAMessageWithoutAStoryHasNoQuote() {
        XCTAssertNil(MessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false).quote)
    }
}
