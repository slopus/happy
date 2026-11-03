import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Telegram's time and delivery mark in a person's own bubble: its box,
/// and whether it rides the last line or takes one of its own.
final class MessageStatusLayoutTests: XCTestCase {
    /// "10:31" at 11 points, about as wide as it measures.
    private let status = MessageStatusLayout(time: CGSize(width: 28, height: 13))

    func testTheBoxKeepsTelegramsSlotForTheClockAndTheChecks() {
        XCTAssertEqual(status.size, CGSize(width: 46, height: 13))
        XCTAssertEqual(status.time, CGRect(x: 5, y: 1, width: 28, height: 13))
        // The clock's 11 square centred 8.5 past the time and 7.5 down.
        XCTAssertEqual(status.clock, CGRect(x: 36, y: 2, width: 11, height: 11))
        // The checks 3 down, 6 apart, the second reaching 5 past the slot.
        XCTAssertEqual(status.sentCheck, CGRect(x: 34, y: 3, width: 11, height: 9))
        XCTAssertEqual(status.readCheck, CGRect(x: 40, y: 3, width: 11, height: 9))
        XCTAssertEqual(status.failed, status.clock)
    }

    func testTheBoxRidesALastLineWithRoomForIt() {
        let placed = status.place(text: CGSize(width: 100, height: 24), trailing: 100, available: 314)
        XCTAssertTrue(placed.inline)
        XCTAssertEqual(placed.content, CGSize(width: 146, height: 24))
        XCTAssertEqual(placed.frame, CGRect(x: 100, y: 12, width: 46, height: 13))
        // A short last line under a wider one: no wider, no taller.
        let under = status.place(text: CGSize(width: 300, height: 48), trailing: 120, available: 314)
        XCTAssertTrue(under.inline)
        XCTAssertEqual(under.content, CGSize(width: 300, height: 48))
        XCTAssertEqual(under.frame, CGRect(x: 254, y: 36, width: 46, height: 13))
    }

    func testTheBoxTakesALineOfItsOwnWhenTheLastLineIsFull() {
        let placed = status.place(text: CGSize(width: 300, height: 48), trailing: 290, available: 314)
        XCTAssertFalse(placed.inline)
        XCTAssertEqual(placed.content, CGSize(width: 300, height: 61))
        XCTAssertEqual(placed.frame, CGRect(x: 254, y: 48, width: 46, height: 13))
        // Exactly the room: still on the line.
        XCTAssertTrue(status.place(text: CGSize(width: 268, height: 24), trailing: 268, available: 314).inline)
        // A block that can't share its last line (code, a list).
        XCTAssertFalse(status.place(text: CGSize(width: 40, height: 24), trailing: nil, available: 314).inline)
    }

    func testAShortMessagesBubbleIsAsWideAsTheTimeNeeds() {
        let placed = status.place(text: CGSize(width: 10, height: 24), trailing: nil, available: 314)
        XCTAssertEqual(placed.content, CGSize(width: 46, height: 37))
        XCTAssertEqual(placed.frame, CGRect(x: 0, y: 24, width: 46, height: 13))
    }

    func testPicturesAloneCarryThePillAtTheirCorner() {
        let placed = status.pill(over: CGRect(x: 100, y: 0, width: 200, height: 150))
        XCTAssertEqual(placed.pill, CGRect(x: 239, y: 127, width: 55, height: 17))
        // The time 7 into the pill; the box's gap hangs before it.
        XCTAssertEqual(placed.frame, CGRect(x: 241, y: 129, width: 46, height: 13))
        XCTAssertEqual(placed.frame.minX + status.time.minX, placed.pill.minX + 7)
    }

    // MARK: In the agents' bubble

    private func text(_ size: CGSize) -> Measurable { .fixed(size) }

    func testTheAgentsBubbleGrowsAroundTheTimeOnItsLastLine() {
        let layout = MessageLayout.user(width: 390, text: text(CGSize(width: 100, height: 24)), showsStatus: false,
                                        delivery: status, trailing: text(CGSize(width: 100, height: 24)))
        // 146 of content and 12 either side, at the right, 16 in.
        XCTAssertEqual(layout.bubble, CGRect(x: 204, y: 8, width: 170, height: 44))
        XCTAssertEqual(layout.text, CGRect(x: 216, y: 18, width: 100, height: 24))
        XCTAssertEqual(layout.delivery, CGRect(x: 316, y: 30, width: 46, height: 13))
        XCTAssertEqual(layout.size.height, 60)
        XCTAssertNil(layout.deliveryPill)
    }

    func testTheAgentsBubbleTakesALineForTheTimeUnderAFullLine() {
        let layout = MessageLayout.user(width: 390, text: text(CGSize(width: 300, height: 48)), showsStatus: false,
                                        delivery: status, trailing: text(CGSize(width: 290, height: 24)))
        XCTAssertEqual(layout.bubble, CGRect(x: 50, y: 8, width: 324, height: 81))
        XCTAssertEqual(layout.text, CGRect(x: 62, y: 18, width: 300, height: 48))
        XCTAssertEqual(layout.delivery, CGRect(x: 316, y: 66, width: 46, height: 13))
    }

    func testTheBubbleIsTheSameForEveryMark() {
        // The box is the same whatever mark it shows, so no state moves it.
        let one = MessageLayout.user(width: 390, text: text(CGSize(width: 100, height: 24)), showsStatus: false, delivery: status, trailing: text(CGSize(width: 100, height: 24)))
        let again = MessageLayout.user(width: 390, text: text(CGSize(width: 100, height: 24)), showsStatus: false, delivery: MessageStatusLayout(time: CGSize(width: 28, height: 13)), trailing: text(CGSize(width: 100, height: 24)))
        XCTAssertEqual(one, again)
    }

    func testAFoldedMessageSetsTheTimeBesideShowFull() {
        let fold = MessageLayout.Fold(preview: text(CGSize(width: 300, height: 1680)), control: text(CGSize(width: 70, height: 20)), opened: false, lineHeight: 24)
        let layout = MessageLayout.user(width: 390, text: text(CGSize(width: 300, height: 2400)), fold: fold, showsStatus: false,
                                        delivery: status, trailing: text(CGSize(width: 290, height: 24)))
        // Show full's line has the room the text's last one hasn't.
        XCTAssertEqual(layout.foldControl, CGRect(x: 62, y: 1706, width: 70, height: 20))
        XCTAssertEqual(layout.delivery, CGRect(x: 316, y: 1714, width: 46, height: 13))
        XCTAssertEqual(layout.bubble?.height, 1680 + 8 + 20 + 20)
    }

    // MARK: In the Happy CLI bubble

    private func legacy(_ text: CGSize, trailing: CGFloat?, delivery: MessageStatusLayout?) -> UserMessageLayout {
        UserMessageLayout(.init(width: 390, content: .text([.text(.fixed(text))]), delivery: delivery,
                                trailing: trailing.map { .fixed(width: $0, height: 24) }))
    }

    func testTheHappyCLIBubbleGrowsAroundTheTimeOnItsLastLine() {
        let plain = legacy(CGSize(width: 100, height: 24), trailing: 100, delivery: nil)
        let timed = legacy(CGSize(width: 100, height: 24), trailing: 100, delivery: status)
        let bubble = try! XCTUnwrap(plain.bubble), with = try! XCTUnwrap(timed.bubble)
        // As tall, 46 wider to the left, the text where it was against the bubble's left.
        XCTAssertEqual(with.height, bubble.height)
        XCTAssertEqual(with.maxX, bubble.maxX)
        XCTAssertEqual(with.width, bubble.width + 46)
        XCTAssertEqual(timed.markdownOrigin.x, with.minX + UserMessageLayout.Metrics.bubblePaddingH)
        XCTAssertEqual(timed.size, plain.size)
        let box = try! XCTUnwrap(timed.delivery)
        XCTAssertEqual(box.maxX, with.maxX - UserMessageLayout.Metrics.bubblePaddingH)
        // On the paragraph's foot, not the margin's under it.
        XCTAssertEqual(box.maxY, timed.markdownOrigin.y + MarkdownLayout.Metrics.textMarginTop + 24 + 1)
        XCTAssertNil(plain.delivery)
    }

    func testTheHappyCLIBubbleTakesALineForTheTimeAfterACodeBlock() {
        let plain = legacy(CGSize(width: 100, height: 24), trailing: nil, delivery: nil)
        let timed = legacy(CGSize(width: 100, height: 24), trailing: nil, delivery: status)
        let bubble = try! XCTUnwrap(plain.bubble), with = try! XCTUnwrap(timed.bubble)
        XCTAssertEqual(with.width, bubble.width)
        // Under the last block, partly in the margin it keeps.
        let grows = 13 - MarkdownLayout.Metrics.textMarginBottom
        XCTAssertEqual(with.height, bubble.height + grows)
        XCTAssertEqual(timed.size.height, plain.size.height + grows)
        let box = try! XCTUnwrap(timed.delivery)
        XCTAssertEqual(box.minY, timed.markdownOrigin.y + MarkdownLayout.Metrics.textMarginTop + 24)
    }

    // MARK: Nothing moves

    /// The text sizes the chats follow, smallest, designed, and the
    /// accessibility sizes up to the largest.
    private let scales: [CGFloat] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge]
        .map { (category: TextSizeCategory) in category.reactNativeMultiplier }

    /// Times as the bubble measures them in tabular digits at 11 points:
    /// "1:00 PM", "10:10 AM", "11:59 AM", "12:00 PM", and 24-hour "01:00"
    /// and "23:59" (one width: every digit is as wide as any other).
    private let times: [(String, CGFloat)] = [("1:00 PM", 41), ("10:10 AM", 48), ("11:59 AM", 48), ("12:00 PM", 47.5), ("01:00", 30), ("23:59", 30)]

    /// The marks' own boxes at a scale: the clock and the failed disc share
    /// a square, and each check is drawn in its own.
    private func marks(_ status: MessageStatusLayout) -> [CGRect] {
        [status.clock, status.sentCheck, status.readCheck, status.failed]
    }

    func testEveryMarkIsDrawnInsideOneBoxWhateverItsState() {
        for scale in scales {
            for (name, width) in times {
                let status = MessageStatusLayout(time: CGSize(width: width * scale, height: 13 * scale), scale: scale)
                // The mark's frame holds all four, so it is the same frame
                // whichever one shows, and so is the tap target over it.
                for mark in marks(status) {
                    XCTAssertTrue(status.mark.contains(mark), "\(name) at \(scale): \(mark) outside \(status.mark)")
                }
                // Nothing reaches back over the time.
                XCTAssertGreaterThan(status.mark.minX, status.time.maxX, "\(name) at \(scale)")
                // Past the box only the overhang, at most 5: inside the
                // agents' bubble's 12 of padding, the Happy CLI bubble's 12
                // and the pill's 7, at every text size.
                XCTAssertLessThanOrEqual(status.overhang, MessageStatusLayout.Metrics.overhang + 0.0001, "\(name) at \(scale)")
                XCTAssertLessThan(status.overhang, MessageLayout.Metrics.bubblePaddingH)
                XCTAssertLessThan(status.overhang, UserMessageLayout.Metrics.bubblePaddingH)
                XCTAssertLessThan(status.overhang, MessageStatusLayout.Metrics.pillPadding.right)
                // And no lower than the box's foot plus the padding under it.
                XCTAssertLessThanOrEqual(status.mark.maxY, status.size.height + 1, "\(name) at \(scale)")
            }
        }
    }

    func testTheDesignedSizeIsTelegramsBox() {
        let status = MessageStatusLayout(time: CGSize(width: 28, height: 13), scale: 1)
        XCTAssertEqual(status, self.status)
        XCTAssertEqual(status.mark, CGRect(x: 34, y: 2, width: 17, height: 11))
        XCTAssertEqual(status.overhang, 5)
    }

    func testTheMarksGrowWithTheTextAndTheSlotTakesWhatTheOverhangCannot() {
        let large = MessageStatusLayout(time: CGSize(width: 28, height: 13), scale: 2)
        XCTAssertEqual(large.clock.size, CGSize(width: 22, height: 22))
        XCTAssertEqual(large.readCheck.size, CGSize(width: 22, height: 18))
        XCTAssertEqual(large.readCheck.minX - large.sentCheck.minX, 12)
        // 36 of reach past the time, 5 of it in the padding.
        XCTAssertEqual(large.size.width, 5 + 28 + 31)
        XCTAssertEqual(large.overhang, 5)
        // Smaller than designed, all of it shrinks.
        let small = MessageStatusLayout(time: CGSize(width: 28, height: 13), scale: 0.5)
        XCTAssertEqual(small.size.width, 5 + 28 + 6.5)
        XCTAssertEqual(small.overhang, 2.5)
    }

    /// The agents' bubble and the Happy CLI bubble, inline and on a line
    /// of their own, at every text size and for every time: the box, the
    /// bubble and the text are a function of the time's size alone. The
    /// mark's state is no input, so the clock, one check, two and the
    /// refusal are one layout; and the mark stays inside the bubble.
    func testTheBubblesFramesDependOnTheTimeAloneAndHoldEveryMark() {
        for scale in scales {
            let line = 24 * scale
            for (name, width) in times {
                let status = MessageStatusLayout(time: CGSize(width: width * scale, height: 13 * scale), scale: scale)
                for (placement, last) in [("inline", 100 * scale), ("own-line", 310)] {
                    let words = CGSize(width: min(310, max(100 * scale, last)), height: line * 2)
                    let agent = MessageLayout.user(width: 390, text: text(words), showsStatus: false, delivery: status, trailing: text(CGSize(width: last, height: line)))
                    let again = MessageLayout.user(width: 390, text: text(words), showsStatus: false, delivery: MessageStatusLayout(time: CGSize(width: width * scale, height: 13 * scale), scale: scale), trailing: text(CGSize(width: last, height: line)))
                    XCTAssertEqual(agent, again, "\(name) \(placement) at \(scale)")
                    let bubble = try! XCTUnwrap(agent.bubble), box = try! XCTUnwrap(agent.delivery)
                    let mark = status.mark.offsetBy(dx: box.minX, dy: box.minY)
                    XCTAssertTrue(bubble.contains(mark), "agent \(name) \(placement) at \(scale): \(mark) leaves \(bubble)")
                    XCTAssertEqual(box.maxX, bubble.maxX - MessageLayout.Metrics.bubblePaddingH, "agent \(name) \(placement) at \(scale)")

                    let legacy = legacy(words, trailing: last, delivery: status)
                    let legacyBubble = try! XCTUnwrap(legacy.bubble), legacyBox = try! XCTUnwrap(legacy.delivery)
                    XCTAssertTrue(legacyBubble.contains(status.mark.offsetBy(dx: legacyBox.minX, dy: legacyBox.minY)), "legacy \(name) \(placement) at \(scale)")
                }
            }
        }
    }

    /// The box over pictures sent alone keeps its pill whatever the mark,
    /// and the mark stays in the pill.
    func testThePillHoldsEveryMarkAtEveryTextSize() {
        for scale in scales {
            for (name, width) in times {
                let status = MessageStatusLayout(time: CGSize(width: width * scale, height: 13 * scale), scale: scale)
                let placed = status.pill(over: CGRect(x: 100, y: 0, width: 260, height: 200))
                let mark = status.mark.offsetBy(dx: placed.frame.minX, dy: placed.frame.minY)
                XCTAssertTrue(placed.pill.insetBy(dx: -0.001, dy: -0.001).contains(mark), "\(name) at \(scale): \(mark) leaves \(placed.pill)")
            }
        }
    }
}
