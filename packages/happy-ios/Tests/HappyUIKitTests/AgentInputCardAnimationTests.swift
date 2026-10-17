#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Only a height the text made animates: chips that come with a session's
/// record, a picture, a new text size take their height at once.
@MainActor
final class AgentInputCardAnimationTests: XCTestCase {
    private final class Owner: AgentInputCardDelegate {
        var animated: [Bool] = []

        func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
            animated.append(card.animatesHeightChange)
            card.frame.size.height = card.height(fitting: card.bounds.width)
        }
    }

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func laidOutCard(_ owner: Owner) async -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        card.delegate = owner
        card.frame = CGRect(x: 0, y: 0, width: 377, height: card.height(fitting: 377))
        card.setText("one", selection: NSRange(location: 3, length: 0))
        await card.textMeasured()
        card.layoutIfNeeded()
        return card
    }

    func testChipsArrivingDoNotAnimate() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        owner.animated = []
        var configuration = card.configuration
        configuration.permission = AgentInputChipConfiguration(content: .label("Default"), accessibilityLabel: "Permissions", menu: nil)
        configuration.model = AgentInputChipConfiguration(content: .label("Opus 5.5"), accessibilityLabel: "Model", menu: nil)
        card.configuration = configuration
        XCTAssertEqual(owner.animated, [false])
        XCTAssertTrue(card.animatesHeightChange)
    }

    func testANewTextSizeDoesNotAnimate() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        card.traitOverrides.followsTextSize = true
        owner.animated = []
        card.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        card.updateTraitsIfNeeded()
        XCTAssertEqual(owner.animated.first, false)
        XCTAssertFalse(owner.animated.contains(true))
    }

    func testTypingANewLineAnimates() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        owner.animated = []
        card.setText("one\ntwo", selection: NSRange(location: 7, length: 0))
        await card.textMeasured()
        XCTAssertEqual(owner.animated, [true])
    }
}
#endif
