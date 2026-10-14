#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The card's text view lays its text out with TextKit 1, the TextKit its
/// height is measured with off the main thread, so at every text size the
/// view needs exactly the height measured for it.
@MainActor
final class AgentInputCardTextKitTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testTheEditorIsTextKit1() {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        // Read first: asking for `layoutManager` would turn a TextKit 2
        // view into TextKit 1 and hide it.
        XCTAssertNil(card.textView.textLayoutManager)
        XCTAssertNotNil(card.textView.layoutManager)
    }

    func testAtEveryTextSizeTheEditorNeedsTheMeasuredHeight() async throws {
        let categories: [UIContentSizeCategory] = [
            .extraSmall, .large, .extraExtraExtraLarge,
            .accessibilityMedium, .accessibilityExtraLarge, .accessibilityExtraExtraExtraLarge,
        ]
        for category in categories {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            let host = UIView(frame: window.bounds)
            host.traitOverrides.preferredContentSizeCategory = category
            host.traitOverrides.followsTextSize = true
            window.addSubview(host)
            let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
            host.addSubview(card)
            card.updateTraitsIfNeeded()
            // Under the 120 cap, where the view's own height is the text's.
            for text in category.isAccessibilityCategory ? ["hello"] : ["hello", "one\ntwo"] {
                card.text = text
                _ = card.layoutInput(width: 377)
                await card.textMeasured()
                let input = card.layoutInput(width: 377)
                let textWidth = card.layout(width: 377).text.width
                let needed = card.textView.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height
                XCTAssertEqual(input.textContentHeight, ceil(needed), "\(category.rawValue), \(text.count) characters")
            }
            XCTAssertNil(card.textView.textLayoutManager)
            withExtendedLifetime(window) {}
        }
    }
}
#endif
