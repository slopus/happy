import XCTest
#if canImport(HappyLayout)
@testable import HappyLayout
#endif

final class GuestChatLayoutTests: XCTestCase {
    func testIPhone12FramesAndKeyboard() {
        let normal = GuestChatLayout(size: CGSize(width: 390, height: 844), safeTop: 47, bottom: 34)
        XCTAssertEqual(normal.title, CGRect(x: 20, y: 63, width: 270, height: 34))
        XCTAssertEqual(normal.status, CGRect(x: 20, y: 105, width: 350, height: 52))
        XCTAssertEqual(normal.input, CGRect(x: 20, y: 750, width: 274, height: 44))
        XCTAssertEqual(normal.send, CGRect(x: 302, y: 750, width: 68, height: 44))
        XCTAssertEqual(normal.messages, CGRect(x: 20, y: 205, width: 350, height: 533))
        let keyboard = GuestChatLayout(size: CGSize(width: 390, height: 844), safeTop: 47, bottom: 336)
        XCTAssertEqual(keyboard.input, CGRect(x: 20, y: 448, width: 274, height: 44))
        XCTAssertEqual(keyboard.messages.height, 231)
        let readOnly = GuestChatLayout(size: CGSize(width: 390, height: 844), safeTop: 47, bottom: 34, showsComposer: false)
        XCTAssertEqual(readOnly.messages, CGRect(x: 20, y: 205, width: 350, height: 589))
    }
}