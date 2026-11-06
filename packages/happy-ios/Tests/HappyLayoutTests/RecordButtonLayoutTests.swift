import HappyLayout
import XCTest

/// The microphone's press (`RecordGesture`), its circles' motion
/// (`RecordMotion`), its clock and the recording screen's frames
/// (`RecordOverlayLayout`), with Telegram's numbers.
final class RecordGestureTests: XCTestCase {
    private func held(at time: Double = 10) -> RecordGesture {
        var gesture = RecordGesture()
        gesture.begin(at: time)
        return gesture
    }

    func testLettingGoInPlaceSends() {
        var gesture = held()
        XCTAssertEqual(gesture.end(.zero, velocity: .zero, at: 11), .send)
        XCTAssertFalse(gesture.isLocked)
    }

    func testATapLandsLocked() {
        var gesture = held()
        XCTAssertEqual(gesture.end(.zero, velocity: .zero, at: 10.18), .lock)
        XCTAssertTrue(gesture.isLocked)
        XCTAssertEqual(gesture.lockness, 1)
        var longer = held()
        XCTAssertEqual(longer.end(.zero, velocity: .zero, at: 10.2), .send, "past 0.19 s it was a hold")
    }

    func testDraggingLeftPast150CancelsAtOnce() {
        var gesture = held()
        XCTAssertNil(gesture.move(CGPoint(x: -150, y: 0)))
        XCTAssertEqual(gesture.move(CGPoint(x: -150.5, y: -20)), .cancel)
    }

    func testDraggingUpPast110LocksAtOnce() {
        var gesture = held()
        XCTAssertNil(gesture.move(CGPoint(x: 0, y: -110)))
        XCTAssertFalse(gesture.isLocked)
        XCTAssertEqual(gesture.move(CGPoint(x: -30, y: -111)), .lock)
        XCTAssertTrue(gesture.isLocked)
    }

    func testMovingRightOrDownDoesNothing() {
        var gesture = held()
        XCTAssertNil(gesture.move(CGPoint(x: 400, y: 400)))
        XCTAssertEqual(gesture.translation, .zero)
        XCTAssertEqual(gesture.scale, 1)
        XCTAssertEqual(gesture.lockness, 0)
    }

    func testLettingGoPartWayLeftOrUp() {
        var left = held()
        XCTAssertEqual(left.end(CGPoint(x: -101, y: 0), velocity: .zero, at: 11), .cancel)
        var notFarEnough = held()
        XCTAssertEqual(notFarEnough.end(CGPoint(x: -100, y: 0), velocity: .zero, at: 11), .send)
        var up = held()
        XCTAssertEqual(up.end(CGPoint(x: 0, y: -61), velocity: .zero, at: 11), .lock)
        var lower = held()
        XCTAssertEqual(lower.end(CGPoint(x: 0, y: -60), velocity: .zero, at: 11), .send)
    }

    func testOnlyTheLongerDirectionCountsOnRelease() {
        var mostlyUp = held()
        XCTAssertEqual(mostlyUp.end(CGPoint(x: -50, y: -70), velocity: .zero, at: 11), .lock)
        var mostlyLeft = held()
        XCTAssertEqual(mostlyLeft.end(CGPoint(x: -105, y: -90), velocity: .zero, at: 11), .cancel)
    }

    func testAFlickCountsAsTheWholeWay() {
        var flickLeft = held()
        XCTAssertEqual(flickLeft.end(CGPoint(x: -10, y: 0), velocity: CGPoint(x: -401, y: 0), at: 11), .cancel)
        var flickUp = held()
        XCTAssertEqual(flickUp.end(CGPoint(x: 0, y: -10), velocity: CGPoint(x: 0, y: -401), at: 11), .lock)
        var slow = held()
        XCTAssertEqual(slow.end(CGPoint(x: 0, y: -10), velocity: CGPoint(x: -400, y: -400), at: 11), .send)
    }

    func testTheCircleShrinksLeftToFourTenths() {
        var gesture = held()
        _ = gesture.move(CGPoint(x: -75, y: 0))
        XCTAssertEqual(gesture.scale, 0.75, accuracy: 1e-9)
        XCTAssertEqual(gesture.cancelTranslation, 75)
        _ = gesture.move(CGPoint(x: -149, y: 0))
        XCTAssertEqual(gesture.scale, 1 - 149.0 / 300, accuracy: 1e-9)
        var far = RecordGesture()
        _ = far.move(CGPoint(x: -280, y: 0))
        XCTAssertEqual(far.scale, 0.4, accuracy: 1e-9)
    }

    func testTheLockClosesOver105Up() {
        var gesture = held()
        _ = gesture.move(CGPoint(x: 0, y: -52.5))
        XCTAssertEqual(gesture.lockness, 0.5, accuracy: 1e-9)
        _ = gesture.move(CGPoint(x: 0, y: -108))
        XCTAssertEqual(gesture.lockness, 1)
    }

    func testASecondPressRightAfterIsIgnored() {
        let gesture = held(at: 10)
        XCTAssertFalse(gesture.accepts(at: 10.39))
        XCTAssertTrue(gesture.accepts(at: 10.4))
        XCTAssertTrue(RecordGesture().accepts(at: 0))
    }
}

final class RecordMotionTests: XCTestCase {
    func testTheRingIsTheCircleAtSilenceAndWholeAtFullVoice() {
        XCTAssertEqual(RecordMotion.Metrics.innerDiameter, 110)
        XCTAssertEqual(RecordMotion.Metrics.outerDiameter, 160)
        var motion = RecordMotion()
        XCTAssertEqual(motion.outerScale, 110.0 / 160, accuracy: 1e-9)
        for _ in 0..<400 { motion.step(level: 1, lift: 0, slide: 0) }
        XCTAssertEqual(motion.outerScale, 1, accuracy: 1e-6)
    }

    func testTheLevelKeepsNineTenthsAFrame() {
        var motion = RecordMotion()
        motion.step(level: 1, lift: 0, slide: 0)
        XCTAssertEqual(motion.level, 0.1, accuracy: 1e-9)
        motion.step(level: 1, lift: 0, slide: 0)
        XCTAssertEqual(motion.level, 0.19, accuracy: 1e-9)
    }

    func testTheDragKeepsSevenTenthsAFrameAndOnlyGoesUpAndLeft() {
        var motion = RecordMotion()
        motion.step(level: 0, lift: -100, slide: -50)
        XCTAssertEqual(motion.lift, -30, accuracy: 1e-9)
        XCTAssertEqual(motion.slide, -15, accuracy: 1e-9)
        motion.step(level: 0, lift: 100, slide: 100)
        XCTAssertEqual(motion.lift, 0)
        XCTAssertEqual(motion.slide, 0)
    }

    func testA120HzScreenMovesTheSameOverTheSameTime() {
        var sixty = RecordMotion()
        sixty.step(level: 1, lift: -100, slide: 0, frames: 1)
        var oneTwenty = RecordMotion()
        oneTwenty.step(level: 1, lift: -100, slide: 0, frames: 0.5)
        oneTwenty.step(level: 1, lift: -100, slide: 0, frames: 0.5)
        XCTAssertEqual(oneTwenty.level, sixty.level, accuracy: 1e-9)
        XCTAssertEqual(oneTwenty.lift, sixty.lift, accuracy: 1e-9)
    }

    func testTheAppearingSpringOvershootsAndSettles() {
        XCTAssertEqual(RecordMotion.appear(at: 0), 0)
        let peak = stride(from: 0.0, through: 0.5, by: 0.005).map { RecordMotion.appear(at: $0) }.max() ?? 0
        XCTAssertGreaterThan(peak, 1.05, "damping 0.55 overshoots")
        XCTAssertLessThan(peak, 1.2)
        XCTAssertEqual(RecordMotion.appear(at: 1), 1, accuracy: 0.01)
        XCTAssertFalse(RecordMotion.appearSettled(at: 0.5))
        XCTAssertTrue(RecordMotion.appearSettled(at: 0.75))
    }

    func testTheCirclesFadeInFromAFifthInATenth() {
        XCTAssertEqual(RecordMotion.appearAlpha(at: 0), 0.2)
        XCTAssertEqual(RecordMotion.appearAlpha(at: 0.05), 0.6, accuracy: 1e-9)
        XCTAssertEqual(RecordMotion.appearAlpha(at: 0.1), 1)
    }

    func testTheLockShutsInAFifthOfASecondFromWhereTheFingerLeftIt() {
        XCTAssertEqual(RecordMotion.lockness(from: 0.4, at: 0), 0.4)
        XCTAssertEqual(RecordMotion.lockness(from: 0.4, at: 0.1), 0.7, accuracy: 1e-9)
        XCTAssertEqual(RecordMotion.lockness(from: 0.4, at: 0.2), 1)
    }

    func testTheLevelFromLoudness() {
        XCTAssertEqual(RecordMotion.level(rms: 0), 0)
        XCTAssertEqual(RecordMotion.level(rms: 1), 1)
        XCTAssertEqual(RecordMotion.level(rms: 0.01), 0.2, accuracy: 1e-6, "-40 dB")
        XCTAssertEqual(RecordMotion.level(rms: 0.1), 0.6, accuracy: 1e-6, "-20 dB")
        XCTAssertEqual(RecordMotion.level(rms: 0.001), 0, "-60 dB is silence")
    }

    func testTheClockReadsLikeTelegrams() {
        XCTAssertEqual(RecordClock.text(0), "0:00,00")
        XCTAssertEqual(RecordClock.text(2.54), "0:02,54")
        XCTAssertEqual(RecordClock.text(65.071), "1:05,07")
        XCTAssertEqual(RecordClock.text(3725.5), "1:02:05,50")
        XCTAssertEqual(RecordClock.text(-1), "0:00,00")
    }
}

final class RecordOverlayLayoutTests: XCTestCase {
    /// Home's toolbar on a 390-wide iPhone: the microphone at the right,
    /// the bar from the search field's edge.
    private let button = CGRect(x: 330, y: 780, width: 44, height: 44)
    private lazy var bar = RecordOverlayLayout.capsule(button: button, leading: 16)

    private func layout(cancelTranslation: CGFloat = 0, lockness: CGFloat = 0) -> RecordOverlayLayout {
        RecordOverlayLayout(.init(
            button: button,
            bar: bar,
            clock: CGSize(width: 60, height: 18),
            arrow: CGSize(width: 14, height: 14),
            label: CGSize(width: 100, height: 18),
            cancel: CGSize(width: 56, height: 22),
            cancelTranslation: cancelTranslation,
            lockness: lockness
        ))
    }

    func testTheCapsuleRunsFromTheLeadingEdgeUnderTheButton() {
        XCTAssertEqual(bar, CGRect(x: 16, y: 780, width: 358, height: 44))
        XCTAssertEqual(RecordOverlayLayout.capsule(button: button, leading: 400), button, "never past the button")
    }

    func testTheCirclesSitOnTheButton() {
        let layout = layout()
        XCTAssertEqual(layout.inner, CGRect(x: 297, y: 747, width: 110, height: 110))
        XCTAssertEqual(layout.outer, CGRect(x: 272, y: 722, width: 160, height: 160))
    }

    func testTheLockPillIs122AboveTheButton() {
        let layout = layout()
        XCTAssertEqual(layout.lockWrapper, CGRect(x: 332, y: 644, width: 40, height: 72))
        XCTAssertEqual(layout.lockPanel, CGRect(x: 0, y: 0, width: 40, height: 72))
        XCTAssertEqual(layout.lockGlyph, CGRect(x: 0, y: 6, width: 40, height: 40))
        XCTAssertEqual(layout.arrow, CGRect(x: 14, y: 50, width: 12, height: 12))
        XCTAssertEqual(layout.arrowAlpha, 1)
    }

    func testLockedThePillIsACircleAndTheChevronIsGone() {
        let layout = layout(lockness: 1)
        XCTAssertEqual(layout.lockPanel, CGRect(x: 0, y: 40, width: 40, height: 40))
        XCTAssertEqual(layout.lockGlyph, CGRect(x: 0, y: -5, width: 40, height: 40))
        XCTAssertEqual(layout.arrow.minY, 11)
        XCTAssertEqual(layout.arrowAlpha, 0)
        let halfway = self.layout(lockness: 0.5)
        XCTAssertEqual(halfway.lockPanel, CGRect(x: 0, y: 20, width: 40, height: 56))
        XCTAssertEqual(halfway.arrowAlpha, 0.2, accuracy: 1e-9)
    }

    func testTheDotAndTheClockAtTheBarsLeftOnTheButtonsLine() {
        let layout = layout()
        XCTAssertEqual(layout.dot, CGRect(x: 32, y: 797, width: 10, height: 10))
        XCTAssertEqual(layout.clock, CGRect(x: 50, y: 793, width: 60, height: 18))
    }

    func testSlideToCancelIsCentredInTheBar() {
        let layout = layout()
        // Centred in the bar less 16: (358 - 16 - 120) / 2 in from its edge.
        XCTAssertEqual(layout.cancelLine, CGRect(x: 127, y: 793, width: 120, height: 18))
        XCTAssertEqual(layout.cancelArrow, CGRect(x: 127, y: 795, width: 14, height: 14))
        XCTAssertEqual(layout.cancelLabel, CGRect(x: 147, y: 793, width: 100, height: 18))
        XCTAssertEqual(layout.cancelLineAlpha, 1)
        XCTAssertEqual(layout.cancelButton, CGRect(x: 159, y: 791, width: 56, height: 22))
        XCTAssertLessThan(layout.cancelLine.maxX, layout.inner.minX, "clear of the circle")
    }

    func testTheLineFollowsTheFingerAtHalfItsPaceAndFadesAtTheClock() {
        XCTAssertEqual(layout(cancelTranslation: 8).cancelLine.minX, 127, "the first 8 points don't move it")
        XCTAssertEqual(layout(cancelTranslation: 10).cancelLine.minX, 126)
        XCTAssertEqual(layout(cancelTranslation: 48).cancelLine.minX, 107)
        // The clock ends at 110; the line fades over the 10 before it.
        XCTAssertEqual(layout(cancelTranslation: 20).cancelLineAlpha, 1)
        XCTAssertEqual(layout(cancelTranslation: 30).cancelLineAlpha, 0.6, accuracy: 1e-9)
        XCTAssertEqual(layout(cancelTranslation: 31).cancelLineAlpha, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout(cancelTranslation: 48).cancelLineAlpha, 0)
    }
}

final class RecordLockGlyphTests: XCTestCase {
    func testOpenTheShackleStandsHighWithItsRightLegShort() {
        let glyph = RecordLockGlyph(lockness: 0, scale: 2)
        XCTAssertEqual(glyph.shackle, CGRect(x: 14, y: 6, width: 12, height: 33))
        XCTAssertEqual(glyph.leftLegEnd, 22.5)
        XCTAssertEqual(glyph.rightLegEnd, 16.5)
        XCTAssertEqual(glyph.body, CGRect(x: 12, y: 22, width: 16, height: 16))
        XCTAssertEqual(glyph.keyhole, CGRect(x: 18, y: 28, width: 4, height: 4))
        XCTAssertEqual(glyph.lineWidth, 1.5)
    }

    func testShutTheShackleComesDownAndBothLegsMeetTheBody() {
        let glyph = RecordLockGlyph(lockness: 1, scale: 3)
        XCTAssertEqual(glyph.shackle.minY, 12)
        XCTAssertEqual(glyph.rightLegEnd, glyph.leftLegEnd)
        XCTAssertEqual(glyph.lineWidth, 5.0 / 3.0)
    }
}
