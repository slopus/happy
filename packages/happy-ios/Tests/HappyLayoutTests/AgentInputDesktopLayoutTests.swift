import Foundation
import HappyLayout
import XCTest
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// AgentInput.tsx's flat panel with `desktopActionControls`, as Yoga lays
/// it out on iOS.
final class AgentInputDesktopLayoutTests: XCTestCase {
    /// One line: 22 with the input's 8 + 8.
    private func input(
        width: CGFloat = 800,
        attachments: Int = 0,
        text: CGFloat = 38,
        hasText: Bool = true,
        minHeight: CGFloat? = nil,
        settings: Bool = true,
        stop: CGFloat? = 16,
        image: CGFloat? = 16,
        zen: Bool = false
    ) -> AgentInputDesktopLayout.Input {
        .init(
            width: width, attachmentCount: attachments, textContentHeight: text, hasText: hasText, inputMinHeight: minHeight,
            showsSettings: settings, stopContentWidth: stop, imageContentWidth: image, zenMode: zen
        )
    }

    func testTheFullRow() {
        let layout = AgentInputDesktopLayout(input())
        XCTAssertNil(layout.attachments)
        // 2 down, the 40 minimum outgrown by 38 + 4 + 4.
        assertFrame(layout.inputContainer, rect(8, 2, 784, 46))
        assertFrame(layout.text, rect(10, 6, 774, 38))
        XCTAssertFalse(layout.textScrolls)
        // The gear sets the row's height; send is centred on it, stop and
        // image keep to its top.
        assertFrame(layout.actionRow, rect(8, 48, 784, 40))
        assertFrame(layout.left, rect(8, 48, 744, 40))
        assertFrame(layout.leftContent.settings, rect(0, 0, 40, 40))
        assertFrame(layout.leftContent.stop, rect(48, 0, 32, 32))
        assertFrame(layout.leftContent.image, rect(88, 0, 32, 32))
        assertFrame(layout.send, rect(760, 52, 32, 32))
        assertSize(layout.size, CGSize(width: 800, height: 96))
        XCTAssertEqual(AgentInputDesktopLayout.textWidth(panelWidth: 800), 774)
    }

    func testWithoutTheGearTheRowIsSendsHeight() {
        let layout = AgentInputDesktopLayout(input(settings: false, image: nil))
        assertFrame(layout.actionRow, rect(8, 48, 784, 32))
        assertFrame(layout.left, rect(8, 48, 744, 32))
        XCTAssertNil(layout.leftContent.settings)
        assertFrame(layout.leftContent.stop, rect(0, 0, 32, 32))
        XCTAssertNil(layout.leftContent.image)
        assertFrame(layout.send, rect(760, 48, 32, 32))
        assertSize(layout.size, CGSize(width: 800, height: 88))

        // Nothing on the left at all: the group is there, empty.
        let bare = AgentInputDesktopLayout(input(settings: false, stop: nil, image: nil))
        assertFrame(bare.left, rect(8, 64, 744, 0))
        assertFrame(bare.send, rect(760, 48, 32, 32))
        XCTAssertEqual(bare.leftContent, .init())
    }

    func testZenModeLeavesSendAlone() {
        let layout = AgentInputDesktopLayout(input(zen: true))
        XCTAssertNil(layout.left)
        XCTAssertEqual(layout.leftContent, .init())
        assertFrame(layout.actionRow, rect(8, 48, 784, 32))
        assertFrame(layout.send, rect(760, 48, 32, 32))
        assertSize(layout.size, CGSize(width: 800, height: 88))
    }

    func testPicturesAboveTheTextAndAStopInFlight() {
        // The spinner is wider than the glyph and pushes image along.
        let layout = AgentInputDesktopLayout(input(attachments: 2, stop: 20))
        assertFrame(layout.attachments, rect(16, 2, 768, 64))
        assertFrame(layout.inputContainer, rect(8, 74, 784, 46))
        assertFrame(layout.text, rect(10, 78, 774, 38))
        assertFrame(layout.leftContent.stop, rect(48, 0, 36, 32))
        assertFrame(layout.leftContent.image, rect(92, 0, 32, 32))
        assertFrame(layout.send, rect(760, 124, 32, 32))
        assertSize(layout.size, CGSize(width: 800, height: 168))
    }

    func testTheTextGrowsToItsCapThenScrolls() {
        let tall = AgentInputDesktopLayout(input(text: 200))
        assertFrame(tall.inputContainer, rect(8, 2, 784, 128))
        assertFrame(tall.text, rect(10, 6, 774, 120))
        XCTAssertTrue(tall.textScrolls)
        // Emptied: one line, whatever was measured last.
        let empty = AgentInputDesktopLayout(input(text: 200, hasText: false))
        assertFrame(empty.text, rect(10, 6, 774, 38))
        XCTAssertFalse(empty.textScrolls)
        // A taller minimum centres the text in it.
        let roomy = AgentInputDesktopLayout(input(minHeight: 60))
        assertFrame(roomy.inputContainer, rect(8, 2, 784, 60))
        assertFrame(roomy.text, rect(10, 13, 774, 38))
    }

    func testANarrowPanelClipsTheLeftGroup() {
        let layout = AgentInputDesktopLayout(input(width: 100))
        assertFrame(layout.send, rect(60, 52, 32, 32))
        // Stop and image lie past its edge, cut off.
        assertFrame(layout.left, rect(8, 48, 44, 40))
        assertFrame(layout.leftContent.stop, rect(48, 0, 32, 32))
    }

    func testThePanelInTheComposer() {
        let layout = AgentInputLayout(.init(
            width: 1024,
            paddingH: AgentInputLayout.paddingH(screenWidth: 1024),
            screenWidth: 1024,
            panel: .desktop(input(width: 0))
        ))
        XCTAssertTrue(layout.isWide)
        XCTAssertNil(layout.cardLayout)
        assertFrame(layout.card, rect(12, 8, 1000, 96))
        assertFrame(layout.desktopLayout?.send, rect(960, 52, 32, 32))
        assertSize(layout.size, CGSize(width: 1024, height: 112))
        assertFrame(layout.autocomplete(rows: 1, border: 0), rect(12, -48, 1000, 48))
    }

    func testTheWindowNotTheComposerDecidesWide() {
        // An iPad mini's 768-point window with the sidebar out: the chat is
        // 518 wide, and happy-app's `screenWidth` is still the window's.
        let wide = AgentInputLayout(.init(
            width: 518,
            paddingH: AgentInputLayout.paddingH(screenWidth: 768),
            screenWidth: 768,
            panel: .desktop(input(width: 0))
        ))
        XCTAssertTrue(wide.isWide)
        assertFrame(wide.card, rect(12, 8, 494, 96))
        assertFrame(wide.autocomplete(rows: 1, border: 0), rect(12, -48, 494, 48))
        // A 694-point Split View half of a wide iPad is not.
        XCTAssertFalse(AgentInputLayout.isWide(screenWidth: 694))
        XCTAssertFalse(AgentInputLayout.isWide(screenWidth: 700))
        XCTAssertTrue(AgentInputLayout.isWide(screenWidth: 701))
        XCTAssertEqual(AgentInputLayout.paddingH(screenWidth: 700), 8)
    }
}
