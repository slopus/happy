#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The card's text view is TextKit 2, as RN's `RCTUITextView` is, in the
/// frame measured with TextKit 1 off the main thread, as Fabric measures a
/// TextInput: at every text size the frame is the TextKit 1 height and the
/// view's own text fits inside it, in the same lines.
@MainActor
final class AgentInputCardTextKitTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func host(_ category: UIContentSizeCategory) -> (UIWindow, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = category
        host.traitOverrides.followsTextSize = true
        window.addSubview(host)
        return (window, host)
    }

    /// The card at 377 with `text` measured, laid out at its height.
    private func layOut(_ card: AgentInputCardView, _ text: String) async {
        card.text = text
        _ = card.layoutInput(width: 377)
        await card.textMeasured()
        card.frame = CGRect(x: 0, y: 0, width: 377, height: card.height(fitting: 377))
        card.layoutIfNeeded()
    }

    /// Asking it for its `layoutManager` is what would turn it into
    /// TextKit 1, and nothing does: not laying it out, reading its carets,
    /// selecting, editing, scrolling past the cap, another text size, or
    /// the flat panel.
    func testTheEditorKeepsTextKit2() async throws {
        let (window, host) = host(.large)
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        let editor = card.textView
        XCTAssertNotNil(editor.textLayoutManager, "made")
        host.addSubview(card)
        card.updateTraitsIfNeeded()
        await layOut(card, "hello")
        XCTAssertNotNil(editor.textLayoutManager, "measured and laid out")

        let end = try XCTUnwrap(editor.position(from: editor.beginningOfDocument, offset: 5))
        _ = editor.caretRect(for: end)
        _ = editor.firstRect(for: try XCTUnwrap(editor.textRange(from: editor.beginningOfDocument, to: end)))
        editor.selectedRange = NSRange(location: 2, length: 1)
        _ = card.textUnits.length
        XCTAssertNotNil(editor.textLayoutManager, "carets read and selected")

        editor.insertText(" there")
        editor.replace(try XCTUnwrap(editor.textRange(from: editor.beginningOfDocument, to: editor.beginningOfDocument)), withText: "Oh, ")
        card.setText("one\ntwo", selection: NSRange(location: 7, length: 0))
        await card.textMeasured()
        card.layoutIfNeeded()
        XCTAssertEqual(card.text, "one\ntwo")
        XCTAssertNotNil(editor.textLayoutManager, "edited")

        await layOut(card, (1...12).map { "line \($0)" }.joined(separator: "\n"))
        XCTAssertTrue(editor.isScrollEnabled)
        editor.scrollRangeToVisible(NSRange(location: card.textUnits.length, length: 0))
        XCTAssertNotNil(editor.textLayoutManager, "past the cap, scrolled")

        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        card.updateTraitsIfNeeded()
        await layOut(card, "hello")
        XCTAssertNotNil(editor.textLayoutManager, "at another text size")

        var configuration = card.configuration
        configuration.desktop = AgentInputDesktopConfiguration(send: AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false))
        card.configuration = configuration
        card.frame = CGRect(x: 0, y: 0, width: 800, height: card.height(fitting: 800))
        await card.textMeasured()
        card.layoutIfNeeded()
        XCTAssertTrue(card.textView === editor)
        XCTAssertNotNil(editor.textLayoutManager, "as the flat panel")
        withExtendedLifetime(window) {}
    }

    func testAtEveryTextSizeTheEditorFitsTheMeasuredHeight() async throws {
        let categories: [UIContentSizeCategory] = [
            .extraSmall, .large, .extraExtraExtraLarge,
            .accessibilityMedium, .accessibilityExtraLarge, .accessibilityExtraExtraExtraLarge,
        ]
        for category in categories {
            let (window, host) = host(category)
            // Under the 120 cap, where the frame is the text's height.
            for text in category.isAccessibilityCategory ? ["hello"] : ["hello", "one\ntwo"] {
                let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
                host.addSubview(card)
                card.updateTraitsIfNeeded()
                await layOut(card, text)
                let input = card.layoutInput(width: 377)
                let layout = card.layout(width: 377)
                let metrics = card.metrics
                XCTAssertFalse(layout.textScrolls)
                ComposerEditorGeometry.assertFits(
                    card.textView,
                    measured: input.textContentHeight,
                    frame: layout.text.height,
                    minimum: (input.lineHeight ?? metrics.inputLineHeight) + metrics.inputPaddingTop + metrics.inputPaddingBottom,
                    cap: metrics.inputMaxHeight,
                    scrolls: layout.textScrolls,
                    host: host,
                    "\(category.rawValue), \(text.count) characters"
                )
                card.removeFromSuperview()
            }
            withExtendedLifetime(window) {}
        }
    }
}
#endif
