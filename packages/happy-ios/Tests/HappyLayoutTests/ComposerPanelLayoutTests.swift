import Foundation
import HappyLayout
import XCTest

final class ComposerPanelLayoutTests: XCTestCase {
    func testPortraitPanelFitsBeforeTheExistingKeyboard() {
        let layout = ComposerPanelLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 116, left: 0, bottom: 34, right: 0), bottom: 530, contentHeight: 356)
        XCTAssertEqual(layout.frame, CGRect(x: 8, y: 166, width: 386, height: 356))
        XCTAssertEqual(layout.content, CGRect(x: 0, y: 0, width: 386, height: 356))
    }

    func testSidewaysPanelScrollsInsteadOfMovingTheComposerOrKeyboard() {
        let layout = ComposerPanelLayout(size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(top: 0, left: 62, bottom: 21, right: 62), bottom: 190, contentHeight: 356)
        XCTAssertEqual(layout.frame, CGRect(x: 217, y: 8, width: 440, height: 174))
        XCTAssertEqual(layout.content, CGRect(x: 0, y: 0, width: 440, height: 356))
    }

    func testPanelRestoresItsHeightAndStaysInsideTheSafeAreaWithoutKeyboard() {
        let layout = ComposerPanelLayout(size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(top: 0, left: 62, bottom: 21, right: 62), bottom: 402, contentHeight: 356)
        XCTAssertEqual(layout.frame, CGRect(x: 217, y: 17, width: 440, height: 356))
        XCTAssertEqual(ComposerPanelLayout.available(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 116, left: 0, bottom: 34, right: 0), bottom: 530), CGRect(x: 0, y: 116, width: 402, height: 414))
    }

    func testHeaderBoundsRespectTheHeaderAndComposer() {
        XCTAssertEqual(ComposerPanelLayout.available(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, left: 0, bottom: 34, right: 0), top: 116, bottom: 430), CGRect(x: 0, y: 116, width: 402, height: 314))
    }
}