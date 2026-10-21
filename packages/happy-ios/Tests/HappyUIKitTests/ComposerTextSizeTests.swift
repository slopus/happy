#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The composer's card at the person's text size where it follows it, and
/// at the designed size where it doesn't (Home's dock).
@MainActor
final class ComposerTextSizeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let largest = TextScale(.accessibilityExtraExtraExtraLarge)

    private func host(follows: Bool) -> (UIWindow, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        host.traitOverrides.followsTextSize = follows
        window.addSubview(host)
        return (window, host)
    }

    private func card() -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
            placeholder: "Type a message ...",
            model: AgentInputChipConfiguration(content: .label("Opus 5.5"), accessibilityLabel: "MODEL", menu: nil)
        ))
        card.text = "hello"
        return card
    }

    func testAFollowingCardDrawsAndMeasuresAtTheTextSize() async throws {
        let (window, host) = host(follows: true)
        let card = card()
        host.addSubview(card)
        card.updateTraitsIfNeeded()
        let font = try XCTUnwrap(card.textView.font)
        XCTAssertEqual(font.pointSize, 16 * largest.multiplier, accuracy: 0.001)
        _ = card.layoutInput(width: 377)
        await card.textMeasured()
        let input = card.layoutInput(width: 377)
        XCTAssertEqual(input.lineHeight ?? 0, 22 * largest.multiplier, accuracy: 0.001)
        // The text is measured at the size it is drawn at: one line and
        // the 4 + 4, as a TextKit 1 twin of the text view sizes itself
        // (Fabric's measure); the TextKit 2 view's own line fits that.
        XCTAssertEqual(input.textContentHeight, ceil(22 * largest.multiplier + 8))
        let textWidth = card.layout(width: 377).text.width
        let twin = ComposerEditorGeometry.textKit1Twin(of: card.textView)
        XCTAssertEqual(input.textContentHeight, ComposerEditorGeometry.ownHeight(twin, width: textWidth))
        XCTAssertNotNil(card.textView.textLayoutManager)
        XCTAssertLessThanOrEqual(ComposerEditorGeometry.ownHeight(card.textView, width: textWidth), input.textContentHeight)
        XCTAssertEqual(card.height(fitting: 377), AgentInputCardLayout(input).size.height)
        withExtendedLifetime(window) {}
    }

    func testHomesCardStaysAtTheDesignedSize() throws {
        let (window, host) = host(follows: false)
        let card = card()
        host.addSubview(card)
        card.updateTraitsIfNeeded()
        XCTAssertEqual(try XCTUnwrap(card.textView.font).pointSize, 16)
        XCTAssertNil(card.layoutInput(width: 377).lineHeight)
        withExtendedLifetime(window) {}
    }

    func testTheChatsComposerFollowsOnItsOwn() {
        let (window, host) = host(follows: false)
        let view = UIView()
        view.traitOverrides.followsTextSize = true
        host.addSubview(view)
        view.updateTraitsIfNeeded()
        XCTAssertEqual(view.traitCollection.textEnvironment?.scale, largest)
        withExtendedLifetime(window) {}
    }
}
#endif
