#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A change to the text that moves the card's height tells the owner once
/// the text is measured off the main thread, so the card grows and shrinks
/// as it is typed in.
@MainActor
final class AgentInputCardGrowthTests: XCTestCase {
    private final class Owner: AgentInputCardDelegate {
        var invalidations = 0
        var animated: [Bool] = []

        func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
            invalidations += 1
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

    func testANewLineGrowsTheCardOnceMeasured() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        let oneLine = card.bounds.height
        owner.invalidations = 0
        card.setText("one\ntwo", selection: NSRange(location: 7, length: 0))
        // Until it is measured, the height laid out stays.
        XCTAssertEqual(card.height(fitting: 377), oneLine)
        await card.textMeasured()
        XCTAssertEqual(owner.invalidations, 1)
        XCTAssertGreaterThan(card.bounds.height, oneLine)

        // Back to one line: it shrinks.
        card.setText("one", selection: NSRange(location: 3, length: 0))
        await card.textMeasured()
        XCTAssertEqual(owner.invalidations, 2)
        XCTAssertEqual(card.bounds.height, oneLine)
    }

    func testClearingTheTextShrinksTheCardAtOnce() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        let oneLine = card.bounds.height
        card.setText("one\ntwo\nthree", selection: NSRange(location: 13, length: 0))
        await card.textMeasured()
        XCTAssertGreaterThan(card.bounds.height, oneLine)
        owner.invalidations = 0
        // An empty text is one line, with nothing to measure.
        card.setText("", selection: NSRange(location: 0, length: 0))
        XCTAssertEqual(owner.invalidations, 1)
        XCTAssertEqual(card.bounds.height, oneLine)
    }

    func testTypingOnTheSameLineLaysNothingOut() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        owner.invalidations = 0
        card.setText("ones", selection: NSRange(location: 4, length: 0))
        await card.textMeasured()
        XCTAssertEqual(owner.invalidations, 0)
    }

    func testTheMeasureAgreesWithTheTextView() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        for text in ["one", "one\ntwo", "one\n", String(repeating: "wrap me ", count: 12), "😀 e\u{301} 漢字"] {
            card.setText(text, selection: NSRange(location: 0, length: 0))
            _ = card.layoutInput(width: 377)
            await card.textMeasured()
            let width = card.layout(width: 377).text.width
            let native = ceil(card.textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
            // All under the cap, so measured whole, as `sizeThatFits` does.
            XCTAssertLessThan(native, 120)
            XCTAssertEqual(card.layoutInput(width: 377).textContentHeight, native, text.debugDescription)
        }
        withExtendedLifetime(owner) {}
    }

    func testALongPasteIsMeasuredOnlyToTheCap() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        card.setText(String(repeating: "line\n", count: 20_000), selection: NSRange(location: 0, length: 0))
        _ = card.layoutInput(width: 377)
        await card.textMeasured()
        let layout = card.layout(width: 377)
        XCTAssertEqual(layout.text.height, 120)
        XCTAssertTrue(layout.textScrolls)
        XCTAssertGreaterThanOrEqual(card.layoutInput(width: 377).textContentHeight, 120)
        withExtendedLifetime(owner) {}
    }

    func testAnOpeningDraftGrowsWithoutAnimating() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        owner.animated = []
        card.setText("one\ntwo\nthree", selection: NSRange(location: 13, length: 0), animatesHeight: false)
        await card.textMeasured()
        XCTAssertEqual(owner.animated, [false])
        XCTAssertTrue(card.animatesHeightChange)
        // Typing after it animates again.
        card.setText("one", selection: NSRange(location: 3, length: 0))
        await card.textMeasured()
        XCTAssertEqual(owner.animated, [false, true])
    }

    func testContentIsAnythingButWhitespace() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        for (text, expected) in [("", false), (" \n\t ", false), ("\u{00A0}", false), (" a ", true), ("😀", true), ("\n\n.", true)] {
            card.setText(text, selection: NSRange(location: 0, length: 0))
            XCTAssertEqual(card.hasContent, expected, text.debugDescription)
            XCTAssertEqual(card.hasContent, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.debugDescription)
        }
        withExtendedLifetime(owner) {}
    }

    func testTheStoredUnitsAreTheText() async {
        let owner = Owner()
        let card = await laidOutCard(owner)
        card.setText("😀 see @src", selection: NSRange(location: 11, length: 0))
        XCTAssertEqual(card.textUnits as String, card.text)
        XCTAssertEqual(
            ComposerAutocomplete.findActiveWord(units: card.textUnits, selection: card.selectedRange, prefixes: ComposerAutocomplete.chatPrefixes),
            ComposerAutocomplete.findActiveWord(card.text, selection: card.selectedRange, prefixes: ComposerAutocomplete.chatPrefixes)
        )
        withExtendedLifetime(owner) {}
    }
}
#endif
