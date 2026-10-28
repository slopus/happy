import Foundation
import HappyLayout
import XCTest

final class MacDesktopLayoutTests: XCTestCase {
    func testDesktopAndMinimumWindowFrames() {
        let desktop = MacDesktopLayout(size: CGSize(width: 1180, height: 780))
        XCTAssertEqual(desktop.sidebar, CGRect(x: 0, y: 0, width: 280, height: 780))
        XCTAssertEqual(desktop.content, CGRect(x: 280, y: 0, width: 900, height: 780))
        let compact = MacDesktopLayout(size: MacDesktopLayout.minimumSize)
        XCTAssertEqual(compact.sidebar.width, 220)
        XCTAssertEqual(compact.content.width, 600)
    }
    func testComposerAndHistoryDoNotOverlap() {
        let layout = MacConversationLayout(size: CGSize(width: 600, height: 560))
        XCTAssertEqual(layout.composer, CGRect(x: 24, y: 410, width: 552, height: 92))
        XCTAssertEqual(layout.send, CGRect(x: 480, y: 514, width: 96, height: 30))
        XCTAssertLessThan(layout.transcript.maxY, layout.composer.minY)
        XCTAssertLessThanOrEqual(layout.send.maxY, 560)
    }
    func testWelcomeUsesMeasuredContentAndStaysCentered() {
        let layout = MacWelcomeLayout(size: CGSize(width: 900, height: 780), measuredHeight: 420)
        XCTAssertEqual(layout.content, CGRect(x: 210, y: 180, width: 480, height: 420))
    }
}