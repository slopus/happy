#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A probe, not a contract: prints how the card's text lays out in a
/// TextKit 1 and a TextKit 2 text view next to the height measured off the
/// main thread, line by line and at every text size, and which Writing
/// Tools experience each view resolves to. React Native's composer is a
/// TextKit 2 `RCTUITextView` in a frame Fabric measured with TextKit 1;
/// these numbers say whether the card could be the same.
///
/// Each case prints one `TKPROBE` line:
/// `measure` the card's measured text height (`-` past the 120 cap),
/// `tk1`/`tk2` each view's own height, and `carets` the top and height of
/// the caret at each line's start, then at the end.
@MainActor
final class ComposerTextKitProbeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
        .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
        .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
    ]

    private let texts = [
        "hello",
        "one\ntwo",
        "one\ntwo\nthree",
        "one\ntwo\nthree\nfour\nfive",
        "A paragraph long enough to wrap onto a second and a third line at the width of the composer on a phone.",
    ]

    /// A text view laid out like the card's: its text, attributes and
    /// insets, sized to fit at `width`.
    private func twin(of view: UITextView, textKit2: Bool, width: CGFloat) -> UITextView {
        let twin = UITextView(usingTextLayoutManager: textKit2)
        twin.textContainerInset = view.textContainerInset
        twin.textContainer.lineFragmentPadding = 0
        twin.isScrollEnabled = false
        twin.attributedText = view.attributedText
        let height = twin.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        twin.frame = CGRect(x: 0, y: 0, width: width, height: height)
        twin.layoutIfNeeded()
        return twin
    }

    private func carets(_ view: UITextView, text: String) -> String {
        var offsets = [0]
        for (offset, character) in text.utf16.enumerated() where character == 0x0A {
            offsets.append(offset + 1)
        }
        offsets.append(text.utf16.count)
        return offsets.map { offset in
            guard let position = view.position(from: view.beginningOfDocument, offset: offset) else { return "?" }
            let caret = view.caretRect(for: position)
            return String(format: "%.3f/%.3f", caret.minY, caret.height)
        }.joined(separator: ",")
    }

    private func number(_ value: CGFloat) -> String {
        String(format: "%.3f", value)
    }

    func testTextKit1AndTextKit2AgainstTheMeasure() async throws {
        for category in categories {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            let host = UIView(frame: window.bounds)
            host.traitOverrides.preferredContentSizeCategory = category
            host.traitOverrides.followsTextSize = true
            window.addSubview(host)
            let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
            host.addSubview(card)
            card.updateTraitsIfNeeded()
            for text in texts {
                card.text = text
                _ = card.layoutInput(width: 377)
                await card.textMeasured()
                let input = card.layoutInput(width: 377)
                let layout = card.layout(width: 377)
                let width = layout.text.width
                let tk1 = twin(of: card.textView, textKit2: false, width: width)
                let tk2 = twin(of: card.textView, textKit2: true, width: width)
                // Read before anything that could turn it into TextKit 1.
                XCTAssertNotNil(tk2.textLayoutManager)
                XCTAssertNil(tk1.textLayoutManager)
                let measure = layout.textScrolls ? "-" : number(input.textContentHeight)
                print("TKPROBE \(category.rawValue) lines=\(text.split(separator: "\n").count) chars=\(text.count) width=\(number(width)) measure=\(measure) tk1=\(number(tk1.frame.height)) tk2=\(number(tk2.frame.height)) tk1carets=\(carets(tk1, text: text)) tk2carets=\(carets(tk2, text: text))")
                XCTAssertNotNil(tk2.textLayoutManager)
            }
            withExtendedLifetime(window) {}
        }
    }

    func testWhichWritingToolsEachTextKitGets() {
        let tk1 = UITextView(usingTextLayoutManager: false)
        let tk2 = UITextView(usingTextLayoutManager: true)
        XCTAssertNil(tk1.textLayoutManager)
        XCTAssertNotNil(tk2.textLayoutManager)
        if #available(iOS 18.2, *) {
            // Through KVC: on a device without Writing Tools the coordinator
            // may be nil, though it's declared nonnull.
            func behavior(_ view: UITextView) -> String {
                guard let coordinator = view.value(forKey: "writingToolsCoordinator") as? UIWritingToolsCoordinator else { return "nil" }
                return "\(coordinator.behavior.rawValue)"
            }
            print("TKPROBE writingTools available=\(UIWritingToolsCoordinator.isWritingToolsAvailable) preferred tk1=\(tk1.writingToolsBehavior.rawValue) tk2=\(tk2.writingToolsBehavior.rawValue) resolved tk1=\(behavior(tk1)) tk2=\(behavior(tk2))")
        }
        XCTAssertNotNil(tk2.textLayoutManager)
    }
}
#endif
