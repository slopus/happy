import XCTest
@testable import HappyLayout

/// Rich tasks in a chat: the ChoiceList, a story quoted over a reply, and the way back at the right.
final class ChoiceListLayoutTests: XCTestCase {
    private func text(_ width: CGFloat) -> Measurable { Measurable { _ in CGSize(width: width, height: 24) } }

    func testButtonsStackAcrossTheColumn() {
        let layout = ChoiceListLayout(width: 300, input: .init(prompt: text(200), options: [text(60), text(80)], checks: false, submit: nil))
        XCTAssertEqual(layout.prompt, CGRect(x: 0, y: 0, width: 200, height: 24))
        XCTAssertEqual(layout.options, [
            .init(frame: CGRect(x: 0, y: 32, width: 300, height: 44), label: CGRect(x: 120, y: 42, width: 60, height: 24), box: nil),
            .init(frame: CGRect(x: 0, y: 84, width: 300, height: 44), label: CGRect(x: 110, y: 94, width: 80, height: 24), box: nil),
        ])
        XCTAssertNil(layout.submit)
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 128))
    }

    func testCheckboxesTakeASubmit() {
        let layout = ChoiceListLayout(width: 300, input: .init(prompt: text(200), options: [text(100), text(100)], checks: true, submit: text(120)))
        XCTAssertEqual(layout.options.map(\.label), [CGRect(x: 30, y: 42, width: 100, height: 24), CGRect(x: 30, y: 94, width: 100, height: 24)])
        XCTAssertEqual(layout.options.map(\.box), [CGRect(x: 0, y: 44, width: 20, height: 20), CGRect(x: 0, y: 96, width: 20, height: 20)])
        XCTAssertEqual(layout.submit, .init(frame: CGRect(x: 0, y: 140, width: 300, height: 44), label: CGRect(x: 90, y: 150, width: 120, height: 24), box: nil))
        XCTAssertEqual(layout.size.height, 184)
    }

    func testAStoryIsQuotedOverTheReplyAtTheRight() {
        XCTAssertEqual(StoryCardLayout.quote, CGSize(width: 156, height: 277))
        let layout = MessageLayout.user(width: 402, text: text(80), showsStatus: false, quote: StoryCardLayout.quote)
        XCTAssertEqual(layout.quote, CGRect(x: 230, y: 8, width: 156, height: 277))
        XCTAssertEqual(layout.bubble.map { [$0.minY, $0.maxX] }, [293, 386])
    }

    func testWithRichTasksTheWayBackSitsAtTheRight() {
        let layout = ChatFootLayout(size: CGSize(width: 402, height: 874), card: CGRect(x: 8, y: 768, width: 386, height: 64), trailing: true)
        XCTAssertEqual(layout.jump, CGRect(x: 362, y: 716, width: 32, height: 32))
    }
}
