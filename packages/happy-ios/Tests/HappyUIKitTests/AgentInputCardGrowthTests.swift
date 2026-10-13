#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A change to the text that moves the card's height tells the owner, so
/// the card grows and shrinks as it is typed in.
@MainActor
final class AgentInputCardGrowthTests: XCTestCase {
    private final class Owner: AgentInputCardDelegate {
        var invalidations = 0

        func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
            invalidations += 1
            card.frame.size.height = card.height(fitting: card.bounds.width)
        }
    }

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func laidOutCard(_ owner: Owner) -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        card.delegate = owner
        card.setText("one", selection: NSRange(location: 3, length: 0))
        card.frame = CGRect(x: 0, y: 0, width: 377, height: card.height(fitting: 377))
        card.layoutIfNeeded()
        return card
    }

    func testANewLineGrowsTheCard() {
        let owner = Owner()
        let card = laidOutCard(owner)
        let oneLine = card.bounds.height
        owner.invalidations = 0
        card.setText("one\ntwo", selection: NSRange(location: 7, length: 0))
        XCTAssertEqual(owner.invalidations, 1)
        XCTAssertGreaterThan(card.bounds.height, oneLine)

        // Back to one line: it shrinks.
        card.setText("one", selection: NSRange(location: 3, length: 0))
        XCTAssertEqual(owner.invalidations, 2)
        XCTAssertEqual(card.bounds.height, oneLine)
    }

    func testTypingOnTheSameLineLaysNothingOut() {
        let owner = Owner()
        let card = laidOutCard(owner)
        owner.invalidations = 0
        card.setText("ones", selection: NSRange(location: 4, length: 0))
        XCTAssertEqual(owner.invalidations, 0)
    }

    func testTheTextHeightIsMeasuredAgainAfterEachChange() {
        let owner = Owner()
        let card = laidOutCard(owner)
        let input = card.layoutInput(width: 377)
        card.setText("one\ntwo\nthree", selection: NSRange(location: 13, length: 0))
        XCTAssertGreaterThan(card.layoutInput(width: 377).textContentHeight, input.textContentHeight)
        XCTAssertTrue(card.layoutInput(width: 377).hasText)
        card.setText("", selection: NSRange(location: 0, length: 0))
        XCTAssertFalse(card.layoutInput(width: 377).hasText)
    }
}
#endif
