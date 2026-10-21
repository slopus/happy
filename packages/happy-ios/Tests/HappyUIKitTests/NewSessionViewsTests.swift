#if canImport(UIKit)
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class NewSessionViewsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testNoSessionsOffersStartNewSessionAcrossTheScreen() async {
        let view = NoSessionsView(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        view.layoutIfNeeded()
        // Measured off the main thread, then laid out.
        await view.measured()
        view.layoutIfNeeded()
        XCTAssertEqual(view.startNewSession.title, "Start New Session")
        XCTAssertEqual(view.startNewSession.frame.width, 393, "alignSelf: 'stretch'")
        XCTAssertEqual(view.startNewSession.frame.height, 50, "a large RoundButton")
        XCTAssertTrue(view.showArchived.isHidden)
    }

    func testTheComposerHidesSettingsAndFadesSend() {
        let composer = NewSessionComposerView(frame: CGRect(x: 0, y: 0, width: 369, height: 98))
        composer.agentButton.update(key: "codex", label: "codex")
        composer.showsSettings = false
        composer.layoutIfNeeded()
        XCTAssertEqual(composer.sizeThatFits(CGSize(width: 369, height: 0)).height, 98)
        XCTAssertTrue(composer.settingsButton.isHidden)
        XCTAssertEqual(composer.sendButton.frame.size, CGSize(width: 38, height: 38))

        composer.sendButton.canSend = false
        XCTAssertFalse(composer.sendButton.isEnabled)
        XCTAssertEqual(composer.sendButton.alpha, NewSessionMaterial.sendInactiveOpacity, accuracy: 0.001)
        composer.sendButton.canSend = true
        XCTAssertTrue(composer.sendButton.isEnabled)
        XCTAssertEqual(composer.sendButton.alpha, 1)
    }

    func testThePromptReportsEachEditAndAGrownLine() async {
        let composer = NewSessionComposerView(frame: CGRect(x: 0, y: 0, width: 369, height: 98))
        composer.layoutIfNeeded()
        var reported: [String] = []
        var grew = 0
        composer.onTextChange = { reported.append($0) }
        composer.onHeightChange = { grew += 1 }
        composer.textView.text = "one"
        composer.textViewDidChange(composer.textView)
        XCTAssertEqual(reported, ["one"])
        composer.textView.text = "one\ntwo"
        composer.textViewDidChange(composer.textView)
        XCTAssertEqual(reported, ["one", "one\ntwo"])
        // Measured off the main thread.
        await composer.textMeasured()
        XCTAssertGreaterThan(grew, 0, "a second line grows the composer")

        composer.setText("from the dock")
        XCTAssertEqual(composer.text, "from the dock")
        XCTAssertEqual(reported.count, 2, "the draft's own text isn't reported back")
    }

    func testAPickersFieldStaysThroughARebuild() {
        let content = NewSessionPickerContentView()
        let field = NewSessionFieldRow(icon: .ionicons("search"), placeholder: "Search", isPath: false)
        let first = NewSessionOptionRow(icon: .octicons("circle"), iconSize: 16, iconTint: Palette.textSecondary, label: .option("MacBook"), detail: nil)
        content.setRows(header: [.field(field)], list: [.option(first)])
        let second = NewSessionOptionRow(icon: .octicons("circle"), iconSize: 16, iconTint: Palette.textSecondary, label: .option("Studio"), detail: nil)
        content.setRows(header: [.field(field)], list: [.option(second)])
        XCTAssertTrue(field.superview === content)
        XCTAssertNil(first.superview)
        XCTAssertNotNil(second.superview)
    }
}
#endif
