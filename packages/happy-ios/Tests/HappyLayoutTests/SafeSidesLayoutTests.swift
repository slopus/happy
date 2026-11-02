import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import XCTest
@testable import HappyLayout

/// A phone held sideways: an iPhone 17 Pro on its side is 874 by 402, its
/// safe area 62 in from either side for the camera and the corners. What
/// reads or takes a touch keeps inside; backgrounds and scrims run edge to
/// edge.
final class SafeSidesLayoutTests: XCTestCase {
    private let sideways = CGSize(width: 874, height: 402)
    private let sides = LayoutInsets(top: 0, left: 62, bottom: 21, right: 62)

    func testTheSidesLeaveTheMiddleTopToBottom() {
        XCTAssertEqual(sides.sides(of: sideways), CGRect(x: 62, y: 0, width: 750, height: 402))
        XCTAssertEqual(LayoutInsets(left: 62).sides(of: sideways), CGRect(x: 62, y: 0, width: 812, height: 402))
        XCTAssertEqual(LayoutInsets.zero.sides(of: sideways), CGRect(origin: .zero, size: sideways))
        XCTAssertEqual(LayoutInsets(left: 500, right: 500).sides(of: sideways).width, 0)
    }

    func testAColumnCentresInWhatTheSidesLeave() {
        let column = ChatColumn(rowWidth: 874, sides: sides)
        XCTAssertEqual(column.x, 62)
        XCTAssertEqual(column.width, 750)
        let narrow = ChatColumn(rowWidth: 874, maxContentWidth: 600, sides: sides)
        XCTAssertEqual(narrow.x, 137)
        XCTAssertEqual(narrow.width, 600)
        // The camera on one side only.
        let left = ChatColumn(rowWidth: 874, maxContentWidth: 600, sides: LayoutInsets(left: 62))
        XCTAssertEqual(left.x, 168)
    }

    func testTheAgentChatsTranscriptCardAndJumpKeepInside() {
        let screen = ChatScreenLayout(size: sideways, safeArea: sides, keyboardTop: sideways.height) { _ in 60 }
        XCTAssertEqual(screen.list, CGRect(x: 62, y: 0, width: 750, height: 402))
        XCTAssertEqual(screen.card, CGRect(x: 70, y: 313, width: 734, height: 60))
        // The header's scrim runs edge to edge.
        XCTAssertEqual(screen.headerScrim.minX, 0)
        XCTAssertEqual(screen.headerScrim.width, 874)
        let foot = ChatFootLayout(size: sideways, card: screen.card)
        XCTAssertEqual(foot.jump.minX, 421)
        XCTAssertEqual(foot.scrim.minX, 0)
        XCTAssertEqual(foot.scrim.width, 874)
        // Upright, nothing moves.
        let upright = ChatScreenLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 116, bottom: 34), keyboardTop: 874) { _ in 60 }
        XCTAssertEqual(upright.list, CGRect(x: 0, y: 0, width: 402, height: 874))
        XCTAssertEqual(upright.card.minX, 8)
    }

    func testTheLegacyChatsDockKeepsItsBarsComposerAndButtonsInside() {
        let screen = LegacyChatScreenLayout(.init(
            size: sideways, safeArea: sides, keyboardTop: nil,
            accessories: [.inset(.fixed(CGSize(width: 100, height: 40))), .fullWidth(.fixed(CGSize(width: 100, height: 30)))],
            composerHeight: 80, hidesHeader: true
        ))
        XCTAssertEqual(screen.accessories, [CGRect(x: 70, y: 0, width: 734, height: 40), CGRect(x: 62, y: 40, width: 750, height: 30)])
        XCTAssertEqual(screen.composer, CGRect(x: 62, y: 70, width: 750, height: 80))
        // The dock that carries them, and the list, run edge to edge; the
        // list keeps its rows inside itself.
        XCTAssertEqual(screen.dock, CGRect(x: 0, y: 231, width: 874, height: 150))
        XCTAssertEqual(screen.list, CGRect(x: 0, y: 0, width: 874, height: 231))
        XCTAssertEqual(screen.backButton, CGRect(x: 78, y: 8, width: 44, height: 44))
        XCTAssertEqual(screen.scrollButton, CGRect(x: 421, y: 195, width: 32, height: 32))
        XCTAssertEqual(screen.placeholder, CGRect(x: 62, y: 0, width: 750, height: 231))
        XCTAssertEqual(screen.statusBarShadow?.width, 874)
    }

    func testTheLegacyChatsTabStripKeepsInside() {
        let screen = LegacyChatScreenLayout(.init(size: sideways, safeArea: LayoutInsets(top: 44, left: 62, bottom: 21, right: 62), keyboardTop: nil, composerHeight: 80, headerAccessory: 36))
        XCTAssertEqual(screen.headerAccessory, CGRect(x: 62, y: 44, width: 750, height: 36))
        XCTAssertEqual(screen.headerScrim.width, 874)
    }

    func testHomesRowsKeepInsideItsEdgeToEdgeContent() {
        let home = HomeLayout(size: sideways, contentTop: 50, chromeTop: 38, listBottom: 70, sides: sides)
        XCTAssertEqual(home.content, CGRect(x: 0, y: 0, width: 874, height: 402))
        XCTAssertEqual(home.column, CGRect(x: 62, y: 0, width: 750, height: 402))
        XCTAssertEqual(home.empty, CGRect(x: 62, y: 50, width: 750, height: 282))
        // On a wide window the readable column is clear of the sides already.
        let wide = HomeLayout(size: CGSize(width: 1180, height: 820), contentTop: 50, chromeTop: 38, listBottom: 70, maxWidth: 800, sides: LayoutInsets(top: 24, bottom: 20))
        XCTAssertEqual(wide.column, wide.content)
        // Only the sides that reach into it come off.
        let tight = HomeLayout(size: CGSize(width: 900, height: 400), contentTop: 0, chromeTop: 0, listBottom: 0, maxWidth: 800, sides: sides)
        XCTAssertEqual(tight.content, CGRect(x: 50, y: 0, width: 800, height: 400))
        XCTAssertEqual(tight.column, CGRect(x: 62, y: 0, width: 776, height: 400))
    }

    func testTheNewWorkPanelAndTheCLIPillCentreInWhatTheSidesLeave() {
        let panel = NewWorkLayout(width: 874, sides: LayoutInsets(left: 62), top: 40, bottom: 300, kindHeight: nil, rows: 1, note: nil)
        XCTAssertEqual(panel.block.minX, 308)
        XCTAssertEqual(panel.block.width, 320)
        let pill = CliWarningPillLayout(width: 874, sides: LayoutInsets(left: 62), top: 0, label: .fixed(CGSize(width: 115, height: 15)))
        XCTAssertEqual(pill.pill.minX, 375.5)
        XCTAssertEqual(pill.pill.width, 185)
    }
}
