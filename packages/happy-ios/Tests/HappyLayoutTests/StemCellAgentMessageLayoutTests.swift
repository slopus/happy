import XCTest
@testable import HappyLayout

/// happy-desktop's AgentMessageActivity on a phone's width.
final class StemCellAgentMessageLayoutTests: XCTestCase {
    func testAClosedMessageIsOneLineWithItsChevronAfterTheWords() {
        let layout = StemCellAgentMessageLayout(width: 402, verbWidth: 60.2, textWidth: 120.4, opens: true, body: nil)
        XCTAssertEqual(layout.header, CGRect(x: 16, y: 6, width: 370, height: 20))
        XCTAssertEqual(layout.glyph, CGRect(x: 16, y: 9, width: 14, height: 14))
        XCTAssertEqual(layout.verb, CGRect(x: 36, y: 6, width: 61, height: 20))
        XCTAssertEqual(layout.text, CGRect(x: 103, y: 6, width: 121, height: 20))
        XCTAssertEqual(layout.chevron, CGRect(x: 230, y: 9, width: 14, height: 14))
        XCTAssertNil(layout.body)
        XCTAssertEqual(layout.size, CGSize(width: 402, height: 32))
    }

    func testTheSenderGivesWayAt45PercentAndTheWordsKeepRoomForTheChevron() {
        let layout = StemCellAgentMessageLayout(width: 402, verbWidth: 400, textWidth: 400, opens: true, body: nil)
        // 45% of the 370 line.
        XCTAssertEqual(layout.verb?.width, 166)
        XCTAssertEqual(layout.text, CGRect(x: 208, y: 6, width: 158, height: 20))
        XCTAssertEqual(layout.chevron, CGRect(x: 372, y: 9, width: 14, height: 14))
    }

    func testWithoutASenderWordOrABodyTheLineIsTheWordsAlone() {
        let layout = StemCellAgentMessageLayout(width: 402, verbWidth: nil, textWidth: 90, opens: false, body: nil)
        XCTAssertNil(layout.verb)
        XCTAssertNil(layout.chevron)
        XCTAssertEqual(layout.text, CGRect(x: 36, y: 6, width: 90, height: 20))
    }

    func testOpenedTheMessageSits4Under16In() {
        let block = MarkdownLayout.Block.text(.fixed(width: 200, height: 36))
        let layout = StemCellAgentMessageLayout(width: 402, verbWidth: 60, textWidth: 120, opens: true, body: [block, block])
        XCTAssertEqual(layout.bodyOrigin, CGPoint(x: 32, y: 30))
        XCTAssertEqual(layout.body?.size.height, 78)
        // 6 + 20 + 4 + 36 + 6 + 36 + 6.
        XCTAssertEqual(layout.size.height, 114)
    }

    func testAWideScreenKeepsTheReadingColumn() {
        let layout = StemCellAgentMessageLayout(width: 1000, maxContentWidth: 800, verbWidth: nil, textWidth: 50, opens: true, body: nil)
        XCTAssertEqual(layout.header, CGRect(x: 116, y: 6, width: 768, height: 20))
    }
}
