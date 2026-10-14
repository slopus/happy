#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Session | Bot puts the other kind's text in the open composer's card
/// at its measured height: measured off the main thread while the card
/// held the first, for exactly that text, kind and width.
@MainActor
final class HomeDockKindTextTests: XCTestCase {
    private let width: CGFloat = 361

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func makeCard() -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: ""))
        card.frame = CGRect(x: 0, y: 0, width: width, height: card.height(fitting: width))
        return card
    }

    func testTheSwitchsFirstFrameHasTheTextsHeight() async throws {
        let card = makeCard()
        card.setText("my bot", selection: NSRange(location: 6, length: 0), animatesHeight: false)
        let prompt = "plan\nask\nbuild\nship"
        let kindText = HomeDockKindText(card: card)
        kindText.prepare(createsBot: false, text: prompt, width: width)
        await kindText.measuredLatest()
        let measured = kindText.measured(createsBot: false, text: prompt, width: width)
        XCTAssertNotNil(measured)

        card.setText(try XCTUnwrap(measured), selection: NSRange(location: 20, length: 0), animatesHeight: false)
        XCTAssertTrue(card.isTextMeasured(fitting: width), "nothing left to measure")
        let first = card.height(fitting: width)

        // As tall as the same text measured the ordinary way.
        let other = makeCard()
        other.setText(prompt, selection: NSRange(location: 20, length: 0))
        _ = other.height(fitting: width)
        await other.textMeasured()
        XCTAssertEqual(other.height(fitting: width), first)
    }

    func testOnlyTheLatestTextIsKept() async {
        let card = makeCard()
        let kindText = HomeDockKindText(card: card)
        kindText.prepare(createsBot: false, text: "first\nprompt", width: width)
        kindText.prepare(createsBot: false, text: "second\nprompt", width: width)
        await kindText.measuredLatest()
        XCTAssertNil(kindText.measured(createsBot: false, text: "first\nprompt", width: width))
        XCTAssertNotNil(kindText.measured(createsBot: false, text: "second\nprompt", width: width))
    }

    func testAnotherKindOrWidthIsNotTheSame() async {
        let card = makeCard()
        let kindText = HomeDockKindText(card: card)
        kindText.prepare(createsBot: true, text: "my bot", width: width)
        await kindText.measuredLatest()
        XCTAssertNotNil(kindText.measured(createsBot: true, text: "my bot", width: width))
        XCTAssertNil(kindText.measured(createsBot: false, text: "my bot", width: width))
        XCTAssertNil(kindText.measured(createsBot: true, text: "my bot", width: width - 1))
        XCTAssertNil(kindText.measured(createsBot: true, text: "my bot!", width: width))
    }

    func testNotYetMeasuredIsNil() {
        let card = makeCard()
        let kindText = HomeDockKindText(card: card)
        kindText.prepare(createsBot: false, text: "plan\nask", width: width)
        // The measurement lands on a later turn: a switch now sets the text
        // plainly and it is measured as any text is.
        XCTAssertNil(kindText.measured(createsBot: false, text: "plan\nask", width: width))
    }

    func testTheSameTextAgainKeepsItsMeasurement() async {
        let card = makeCard()
        let kindText = HomeDockKindText(card: card)
        kindText.prepare(createsBot: false, text: "plan\nask", width: width)
        await kindText.measuredLatest()
        kindText.prepare(createsBot: false, text: "plan\nask", width: width)
        XCTAssertNotNil(kindText.measured(createsBot: false, text: "plan\nask", width: width))
    }

    func testATextSizeChangeIsMeasuredAgain() async throws {
        let card = makeCard()
        let kindText = HomeDockKindText(card: card)
        let prompt = "plan\nask\nbuild"
        let caret = NSRange(location: 14, length: 0)
        kindText.prepare(createsBot: false, text: prompt, width: width)
        await kindText.measuredLatest()
        let before = try XCTUnwrap(kindText.measured(createsBot: false, text: prompt, width: width))
        card.setText(before, selection: caret, animatesHeight: false)
        XCTAssertTrue(card.isTextMeasured(fitting: width))
        let designed = card.height(fitting: width)

        // The card now follows the person's largest text size.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        host.traitOverrides.followsTextSize = true
        window.addSubview(host)
        host.addSubview(card)
        card.updateTraitsIfNeeded()
        XCTAssertNotEqual(card.textKey(fitting: width), before.key)
        XCTAssertNil(kindText.measured(createsBot: false, text: prompt, width: width), "measured at the old size")

        // Asked again, it is measured at the new size: taller, and final.
        kindText.prepare(createsBot: false, text: prompt, width: width)
        await kindText.measuredLatest()
        let after = try XCTUnwrap(kindText.measured(createsBot: false, text: prompt, width: width))
        XCTAssertEqual(after.key, card.textKey(fitting: width))
        card.setText(after, selection: caret, animatesHeight: false)
        XCTAssertTrue(card.isTextMeasured(fitting: width))
        XCTAssertGreaterThan(card.height(fitting: width), designed)
        withExtendedLifetime(window) {}
    }

    func testNoWidthMeasuresNothing() async {
        let card = makeCard()
        let kindText = HomeDockKindText(card: card)
        kindText.prepare(createsBot: false, text: "plan\nask", width: 0)
        await kindText.measuredLatest()
        XCTAssertNil(kindText.measured(createsBot: false, text: "plan\nask", width: 0))
    }
}
#endif
