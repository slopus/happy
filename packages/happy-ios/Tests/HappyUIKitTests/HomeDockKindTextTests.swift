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
        let kindText = HomeDockKindText()
        kindText.prepare(createsBot: false, text: prompt, width: width, card: card)
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
        let kindText = HomeDockKindText()
        kindText.prepare(createsBot: false, text: "first\nprompt", width: width, card: card)
        kindText.prepare(createsBot: false, text: "second\nprompt", width: width, card: card)
        await kindText.measuredLatest()
        XCTAssertNil(kindText.measured(createsBot: false, text: "first\nprompt", width: width))
        XCTAssertNotNil(kindText.measured(createsBot: false, text: "second\nprompt", width: width))
    }

    func testAnotherKindOrWidthIsNotTheSame() async {
        let card = makeCard()
        let kindText = HomeDockKindText()
        kindText.prepare(createsBot: true, text: "my bot", width: width, card: card)
        await kindText.measuredLatest()
        XCTAssertNotNil(kindText.measured(createsBot: true, text: "my bot", width: width))
        XCTAssertNil(kindText.measured(createsBot: false, text: "my bot", width: width))
        XCTAssertNil(kindText.measured(createsBot: true, text: "my bot", width: width - 1))
        XCTAssertNil(kindText.measured(createsBot: true, text: "my bot!", width: width))
    }

    func testNotYetMeasuredIsNil() {
        let card = makeCard()
        let kindText = HomeDockKindText()
        kindText.prepare(createsBot: false, text: "plan\nask", width: width, card: card)
        // The measurement lands on a later turn: a switch now sets the text
        // plainly and it is measured as any text is.
        XCTAssertNil(kindText.measured(createsBot: false, text: "plan\nask", width: width))
    }

    func testTheSameTextAgainKeepsItsMeasurement() async {
        let card = makeCard()
        let kindText = HomeDockKindText()
        kindText.prepare(createsBot: false, text: "plan\nask", width: width, card: card)
        await kindText.measuredLatest()
        kindText.prepare(createsBot: false, text: "plan\nask", width: width, card: card)
        XCTAssertNotNil(kindText.measured(createsBot: false, text: "plan\nask", width: width))
    }

    func testNoWidthMeasuresNothing() async {
        let card = makeCard()
        let kindText = HomeDockKindText()
        kindText.prepare(createsBot: false, text: "plan\nask", width: 0, card: card)
        await kindText.measuredLatest()
        XCTAssertNil(kindText.measured(createsBot: false, text: "plan\nask", width: 0))
    }
}
#endif
