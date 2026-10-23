import XCTest
#if canImport(HappyLayout)
@testable import HappyLayout
#endif

final class GuestChatLayoutTests: XCTestCase {
    private let size = CGSize(width: 390, height: 844)
    private let safeArea = LayoutInsets(top: 47, bottom: 34)

    func testConversationOnIPhone12() {
        let layout = GuestChatLayout(.init(
            size: size, safeArea: safeArea, title: CGSize(width: 60, height: 20), subtitle: CGSize(width: 90, height: 14),
            composerHeight: 120, retry: CGSize(width: 110, height: 33)
        ))
        // Capsule: 16 + 44 + 8 clear of each side, hugging the wider line + 32.
        XCTAssertEqual(layout.capsule, CGRect(x: 134, y: 53, width: 122, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 150, y: 58, width: 90, height: 20))
        XCTAssertEqual(layout.subtitle, CGRect(x: 150, y: 78, width: 90, height: 14))
        XCTAssertEqual(layout.more, CGRect(x: 330, y: 53, width: 44, height: 44))
        XCTAssertEqual(layout.composer, CGRect(x: 0, y: 690, width: 390, height: 120))
        XCTAssertEqual(layout.retry, CGRect(x: 140, y: 649, width: 110, height: 33))
        XCTAssertEqual(layout.list, CGRect(x: 0, y: 0, width: 390, height: 844))
        XCTAssertEqual(layout.oldestInset, 109)
        XCTAssertEqual(layout.newestInset, 162)
        XCTAssertNil(layout.onboarding)
        XCTAssertNil(layout.message)
    }

    func testKeyboardCarriesTheComposer() {
        let layout = GuestChatLayout(.init(size: size, safeArea: safeArea, keyboardTop: 508, title: CGSize(width: 60, height: 20), composerHeight: 120))
        XCTAssertEqual(layout.composer, CGRect(x: 0, y: 388, width: 390, height: 120))
        XCTAssertEqual(layout.newestInset, 464)
        // A keyboard below the safe area never drops the composer under it.
        let low = GuestChatLayout(.init(size: size, safeArea: safeArea, keyboardTop: 844, title: CGSize(width: 60, height: 20), composerHeight: 120))
        XCTAssertEqual(low.composer?.maxY, 810)
    }

    func testLongTitleIsCappedBetweenTheSideControls() {
        let layout = GuestChatLayout(.init(size: size, safeArea: safeArea, title: CGSize(width: 500, height: 20)))
        XCTAssertEqual(layout.capsule, CGRect(x: 68, y: 53, width: 254, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 84, y: 65, width: 222, height: 20))
    }

    func testNameFormIsCentredBetweenTheCapsuleAndTheKeyboard() {
        let form = GuestChatLayout.Onboarding(
            title: .fixed(width: 200, height: 34), subtitle: .fixed(width: 200, height: 24), joinHeight: 56, notice: .fixed(width: 300, height: 54)
        )
        let layout = GuestChatLayout(.init(size: size, safeArea: safeArea, title: CGSize(width: 60, height: 20), onboarding: form))
        // 34 + 8 + 24 + 24 + 56 + 12 + 56 + 16 + 54 = 284 in 810 - 113.
        let frames = try! XCTUnwrap(layout.onboarding)
        XCTAssertEqual(frames.title, CGRect(x: 24, y: 319.5, width: 342, height: 34))
        XCTAssertEqual(frames.subtitle, CGRect(x: 24, y: 361.5, width: 342, height: 24))
        XCTAssertEqual(frames.field, CGRect(x: 24, y: 409.5, width: 342, height: 56))
        XCTAssertEqual(frames.join, CGRect(x: 24, y: 477.5, width: 342, height: 56))
        XCTAssertEqual(frames.notice, CGRect(x: 24, y: 549.5, width: 342, height: 54))
        let keyboard = GuestChatLayout(.init(size: size, safeArea: safeArea, keyboardTop: 508, title: CGSize(width: 60, height: 20), onboarding: form))
        XCTAssertEqual(keyboard.onboarding?.field.minY, 258.5)
        XCTAssertLessThanOrEqual(try XCTUnwrap(keyboard.onboarding).join.maxY, 508)
    }

    func testMessageWithoutAConversation() {
        let layout = GuestChatLayout(.init(size: size, safeArea: safeArea, title: CGSize(width: 60, height: 20), message: .fixed(width: 300, height: 48)))
        XCTAssertEqual(layout.message, CGRect(x: 24, y: 437.5, width: 342, height: 48))
        XCTAssertNil(layout.composer)
        XCTAssertEqual(layout.newestInset, 42)
    }

    func testTranscriptStacksRowsOldestFirst() {
        let layout = GuestTranscriptLayout(width: 390, heights: [40, 120.5, 30])
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: 0, width: 390, height: 40),
            CGRect(x: 0, y: 40, width: 390, height: 120.5),
            CGRect(x: 0, y: 160.5, width: 390, height: 30),
        ])
        XCTAssertEqual(layout.contentSize, CGSize(width: 390, height: 190.5))
    }
}
