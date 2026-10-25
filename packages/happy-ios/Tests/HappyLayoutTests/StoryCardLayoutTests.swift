import HappyLayout
import XCTest

final class StoryCardLayoutTests: XCTestCase {
    /// At most 200 wide, 9:16, with its 32 bar 6 under it.
    func testTheCardIsTheCanvasAndItsBar() {
        let layout = StoryCardLayout(width: 358)
        XCTAssertEqual(layout.canvas, CGRect(x: 0, y: 0, width: 200, height: 355))
        XCTAssertEqual(layout.bar, CGRect(x: 0, y: 361, width: 200, height: 32))
        XCTAssertEqual(layout.post, CGRect(x: 0, y: 361, width: 56, height: 32))
        XCTAssertEqual(layout.edit, CGRect(x: 60, y: 361, width: 56, height: 32))
        XCTAssertEqual(layout.label, layout.bar)
        XCTAssertEqual(layout.size, CGSize(width: 200, height: 393))
    }

    /// Posted: a 14 ring, then the word. Gone: a 36 mark over the canvas's
    /// middle, the words 10 under it.
    func testPostedAndGone() {
        let layout = StoryCardLayout(width: 358)
        XCTAssertEqual(layout.ring, CGRect(x: 0, y: 370, width: 14, height: 14))
        XCTAssertEqual(layout.postedLabel, CGRect(x: 20, y: 361, width: 180, height: 32))
        XCTAssertEqual(layout.notice, CGRect(x: 82, y: 141, width: 36, height: 36))
        XCTAssertEqual(layout.noticeText, CGRect(x: 16, y: 187, width: 168, height: 152))
    }

    func testANarrowColumnShrinksIt() {
        let layout = StoryCardLayout(width: 150.6)
        XCTAssertEqual(layout.canvas, CGRect(x: 0, y: 0, width: 150, height: 266))
        XCTAssertEqual(StoryCardLayout.size(width: 150.6), CGSize(width: 150, height: 304))
        XCTAssertEqual(StoryCardLayout.size(width: -5), CGSize(width: 0, height: 38))
    }

    /// In an agent's message: under its text, at the column's left.
    func testAStorySitsUnderItsMessage() {
        let layout = StemCellMessageLayout.agent(width: 390, parts: [.markdown([.text(block(height: 24))]), .story])
        guard layout.parts.count == 2, case .story(let frame) = layout.parts[1] else { return XCTFail("two parts") }
        XCTAssertEqual(frame, CGRect(x: 16, y: 40, width: 200, height: 393))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 441))
    }
}
