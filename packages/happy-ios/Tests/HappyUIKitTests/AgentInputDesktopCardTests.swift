#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The card as the flat panel of a window wider than 700 points.
@MainActor
final class AgentInputDesktopCardTests: XCTestCase {
    private let send = AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false)

    private func card(desktop: AgentInputDesktopConfiguration?) -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
            placeholder: "Type a message ...", showsAdd: true, desktop: desktop
        ))
        card.frame = CGRect(x: 0, y: 0, width: 800, height: card.height(fitting: 800))
        card.layoutIfNeeded()
        return card
    }

    func testThePanelIsAsTallAsItsLayout() throws {
        let panel = card(desktop: AgentInputDesktopConfiguration(settings: AgentInputSettingsMenu(sections: []), showsStop: true, send: send))
        let layout = try XCTUnwrap(panel.desktopLayout(width: 800))
        XCTAssertEqual(panel.height(fitting: 800), layout.size.height)
        XCTAssertEqual(panel.textView.frame, layout.text)
        XCTAssertEqual(panel.textView.textContainerInset.top, AgentInputDesktopLayout.Metrics.textPaddingTop)
        if case .desktop = panel.panelInput(width: 800) {} else { XCTFail("the flat panel") }
        XCTAssertNil(card(desktop: nil).desktopLayout(width: 800))
    }

    func testACompactCardOnlyBuildsDesktopControlsWhenItBecomesWide() throws {
        let card = card(desktop: nil)
        func controls(_ view: UIView) -> [AgentInputDesktopControlsView] {
            (view as? AgentInputDesktopControlsView).map { [$0] } ?? view.subviews.flatMap(controls)
        }
        XCTAssertTrue(controls(card).isEmpty)
        var configuration = card.configuration
        configuration.desktop = AgentInputDesktopConfiguration(send: send)
        card.configuration = configuration
        let installed = try XCTUnwrap(controls(card).first)
        XCTAssertEqual(controls(card).count, 1)
        XCTAssertFalse(installed.isHidden)
        configuration.desktop = nil
        card.configuration = configuration
        XCTAssertTrue(installed.isHidden)
        configuration.desktop = AgentInputDesktopConfiguration(send: send)
        card.configuration = configuration
        XCTAssertTrue(controls(card).first === installed)
        XCTAssertFalse(installed.isHidden)
    }

    func testTheSameTextViewCarriesAcrossTheLine() {
        let card = card(desktop: nil)
        let textView = card.textView
        card.text = "hello"
        textView.selectedRange = NSRange(location: 2, length: 0)
        var configuration = card.configuration
        configuration.desktop = AgentInputDesktopConfiguration(send: send)
        card.configuration = configuration
        card.layoutIfNeeded()
        XCTAssertTrue(card.textView === textView)
        XCTAssertEqual(card.text, "hello")
        XCTAssertEqual(card.selectedRange, NSRange(location: 2, length: 0))
        XCTAssertEqual(textView.textContainerInset.top, AgentInputDesktopLayout.Metrics.textPaddingTop)

        configuration.desktop = nil
        card.configuration = configuration
        XCTAssertEqual(textView.textContainerInset.top, MobileComposerMetrics.mobile.inputPaddingTop)
        XCTAssertEqual(card.text, "hello")
    }
}
#endif
