import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The context meter under the agent chat's composer (desktop's
/// ContextMeter at the end of its composer's footer), the room the chat
/// screen makes for it, and the model chip's usage ring.
final class ContextMeterLayoutTests: XCTestCase {
    /// The full card with one line of text: 8 + 44 + 42 + 8.
    private let cardHeight: CGFloat = 102

    private func screen(width: CGFloat = 402, height: CGFloat = 874, keyboardTop: CGFloat = 874, meter: Bool) -> ChatScreenLayout {
        ChatScreenLayout(size: CGSize(width: width, height: height), safeArea: LayoutInsets(top: 62, bottom: 34), keyboardTop: keyboardTop, meter: meter) { _ in self.cardHeight }
    }

    // MARK: The screen

    func testWithoutAMeterTheCardIsWhereItWas() {
        let layout = screen(meter: false)
        XCTAssertEqual(layout.card, CGRect(x: 8, y: 730, width: 386, height: 102))
        XCTAssertNil(layout.meter)
        XCTAssertEqual(layout.listBottom, 152)
    }

    /// The meter's row takes the 8 under the card and 12 more; its bar ends
    /// where send does, 10 in from the card's edge.
    func testTheMeterRowSitsUnderTheCardItsBarUnderSend() throws {
        let layout = screen(meter: true)
        XCTAssertEqual(layout.card, CGRect(x: 8, y: 718, width: 386, height: 102))
        let meter = try XCTUnwrap(layout.meter)
        XCTAssertEqual(meter, CGRect(x: 174, y: 820, width: 210, height: 20))
        XCTAssertEqual(layout.listBottom, 164)
        // Its bar's right edge is send's.
        let card = AgentInputCardLayout(.init(width: 386, textContentHeight: 30, hasText: false))
        XCTAssertEqual(meter.maxX, layout.card.minX + card.primary.maxX)
        XCTAssertEqual(meter.maxY, 874 - 34, "the row ends on the safe area")
    }

    func testWithTheKeyboardUpTheRowRidesOnIt() {
        let layout = screen(keyboardTop: 538, meter: true)
        XCTAssertEqual(layout.card, CGRect(x: 8, y: 416, width: 386, height: 102))
        XCTAssertEqual(layout.meter, CGRect(x: 174, y: 518, width: 210, height: 20))
    }

    /// The narrowest phones keep the bar at their card's end.
    func testNarrowPhones() {
        XCTAssertEqual(screen(width: 320, height: 568, meter: true).meter, CGRect(x: 92, y: 514, width: 210, height: 20))
        XCTAssertEqual(screen(width: 375, height: 667, meter: true).meter, CGRect(x: 147, y: 613, width: 210, height: 20))
        XCTAssertEqual(screen(width: 320, height: 568, meter: true).card, CGRect(x: 8, y: 412, width: 304, height: 102))
    }

    /// The compact card gives the transcript every point: no meter row.
    func testTheCompactCardHasNoMeterRow() {
        XCTAssertTrue(ChatScreenLayout.showsMeter(hasGauge: true, compact: false))
        XCTAssertFalse(ChatScreenLayout.showsMeter(hasGauge: true, compact: true))
        XCTAssertFalse(ChatScreenLayout.showsMeter(hasGauge: false, compact: false))
        // Sideways with the keyboard up, the meter's room is counted before
        // deciding, so the card goes compact as it would have anyway.
        let size = CGSize(width: 874, height: 402)
        let safe = LayoutInsets(top: 0, bottom: 21)
        XCTAssertTrue(ChatScreenLayout.compacts(size: size, safeArea: safe, keyboardTop: 402 - 190, meter: true) { _ in self.cardHeight })
        XCTAssertFalse(ChatScreenLayout.compacts(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34), keyboardTop: 538, meter: true) { _ in self.cardHeight })
    }

    // MARK: The meter

    private let percent = CGSize(width: 22, height: 13)
    private let tokens = CGSize(width: 50, height: 13)

    func testAtRestOnlyTheBarShows() {
        let layout = ContextMeterLayout(.init(percent: percent, tokens: tokens, revealed: false, fraction: 0.42, compactFraction: 0.75))
        XCTAssertEqual(layout.size, CGSize(width: 210, height: 20))
        XCTAssertEqual(layout.track, CGRect(x: 146, y: 8, width: 64, height: 4))
        XCTAssertEqual(layout.readout, CGRect(x: 146, y: 3.5, width: 0, height: 13))
        XCTAssertEqual(layout.fill.width, 64 * 0.42, accuracy: 0.0001)
        XCTAssertEqual(layout.fill.height, 4)
        XCTAssertEqual(layout.notch, CGRect(x: 47.5, y: 0, width: 1, height: 4))
        XCTAssertEqual(layout.touch, CGRect(x: 134, y: -4, width: 88, height: 28))
    }

    /// Revealed, the track grows about its centre and the numbers open 6
    /// to its left, the percentage first.
    func testRevealedTheNumbersSlideOutToTheLeft() {
        let layout = ContextMeterLayout(.init(percent: percent, tokens: tokens, revealed: true, fraction: 0.42, compactFraction: 0.4))
        XCTAssertEqual(layout.track, CGRect(x: 144, y: 7, width: 68, height: 6))
        XCTAssertEqual(layout.readout, CGRect(x: 64, y: 3.5, width: 76, height: 13))
        XCTAssertEqual(layout.percent, CGRect(x: 0, y: 0, width: 22, height: 13))
        XCTAssertEqual(layout.tokens, CGRect(x: 26, y: 0, width: 50, height: 13))
        XCTAssertEqual(layout.notch.minX, 26.7, accuracy: 0.0001)
        XCTAssertEqual(layout.notch.size, CGSize(width: 1, height: 6))
        XCTAssertEqual(layout.fill, CGRect(x: 0, y: 0, width: 68 * 0.42, height: 6))
        XCTAssertEqual(layout.touch, CGRect(x: 52, y: -8.5, width: 172, height: 37))
    }

    /// A readout longer than 140 is cut there, as `max-width: 140px`.
    func testALongReadoutIsCut() {
        let layout = ContextMeterLayout(.init(percent: CGSize(width: 40, height: 13), tokens: CGSize(width: 120, height: 13), revealed: true, fraction: 1, compactFraction: 0.75))
        XCTAssertEqual(layout.readout, CGRect(x: 0, y: 3.5, width: 140, height: 13))
        XCTAssertEqual(layout.fill.width, layout.track.width)
    }

    func testTheShinePassesTheWholeTrack() {
        let layout = ContextMeterLayout(.init(percent: percent, tokens: tokens, revealed: false, fraction: 0.5, compactFraction: 0.75))
        XCTAssertEqual(layout.shine.width, 64 * 0.32, accuracy: 0.0001)
        XCTAssertLessThan(layout.shinePass.lowerBound + layout.shine.width / 2, 0)
        XCTAssertGreaterThan(layout.shinePass.upperBound + layout.shine.width / 2, layout.track.width)
    }

    // MARK: The model chip's ring

    func testTheRingStandsBeforeTheName() {
        XCTAssertEqual(ChipRingLayout.contentSize(label: CGSize(width: 80, height: 17)), CGSize(width: 98, height: 17))
        let split = ChipRingLayout(content: CGRect(x: 4, y: 11.5, width: 98, height: 17), labelHeight: 17)
        XCTAssertEqual(split.ring, CGRect(x: 4, y: 14, width: 12, height: 12))
        XCTAssertEqual(split.label, CGRect(x: 22, y: 11.5, width: 80, height: 17))
    }

    /// A long model name on a narrow phone: the chip gives way, the ring
    /// stays whole and the name is cut.
    func testALongNameOnANarrowPhoneKeepsTheRingWhole() {
        let name = CGSize(width: 260, height: 17)
        let card = AgentInputCardLayout(.init(
            width: 304, textContentHeight: 30, hasText: false, showsAdd: true,
            model: .init(labelSize: ChipRingLayout.contentSize(label: name)),
            effort: .init(labelSize: CGSize(width: 34, height: 17)),
            separator: CGSize(width: 5, height: 17)
        ))
        let model = try! XCTUnwrap(card.middleContent.model)
        XCTAssertLessThan(model.label.width, ChipRingLayout.contentSize(label: name).width)
        let split = ChipRingLayout(content: model.label, labelHeight: name.height)
        XCTAssertEqual(split.ring.width, 12)
        XCTAssertEqual(split.ring.minX, model.label.minX)
        XCTAssertEqual(split.label.minX, split.ring.maxX + 6)
        XCTAssertEqual(split.label.maxX, model.label.maxX)
        XCTAssertEqual(split.label.width, model.label.width - 18)
        // The effort keeps its whole label beside it.
        XCTAssertEqual(card.middleContent.effort?.frame.width, 34)
    }

    /// Squeezed past the ring itself, nothing goes negative.
    func testASqueezedChipNeverGoesNegative() {
        let split = ChipRingLayout(content: CGRect(x: 0, y: 0, width: 8, height: 17), labelHeight: 17)
        XCTAssertEqual(split.ring, CGRect(x: 0, y: 2.5, width: 8, height: 12))
        XCTAssertEqual(split.label, CGRect(x: 8, y: 0, width: 0, height: 17))
    }
}
