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

    func testALateFrameStepsOnceAsTelegramsDisplayLinkDoes() {
        var late = RecordMotion()
        late.step(level: 0, lift: -100, slide: 0)
        late.step(level: 0, lift: 0, slide: 0, frames: 5)
        XCTAssertEqual(late.lift, -21, accuracy: 1e-9)
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

    func testTheBarGrowsWithoutOvershootIn04Seconds() {
        XCTAssertEqual(RecordMotion.barGrowth(at: 0), 0)
        XCTAssertEqual(RecordMotion.barGrowth(at: 0.2), 0.821, accuracy: 0.001)
        XCTAssertEqual(RecordMotion.barGrowth(at: 0.4), 0.986, accuracy: 0.001)
        let steps = stride(from: 0.0, through: 1, by: 0.01).map { RecordMotion.barGrowth(at: $0) }
        XCTAssertEqual(steps, steps.sorted(), "only ever grows")
        XCTAssertLessThanOrEqual(steps.max() ?? 0, 1)
    }

    func testACancelThrowsTheDotInTelegramsBin() {
        XCTAssertEqual(RecordMotion.Metrics.cancelClockScale, 0.5)
        XCTAssertEqual(RecordMotion.Metrics.cancelFade, 0.25)
        XCTAssertEqual(RecordMotion.Metrics.binTravel, 0.4)
        XCTAssertEqual(RecordMotion.Metrics.binOut, 0.2)
        XCTAssertEqual(RecordOverlayLayout.bin(around: CGPoint(x: 44, y: 820)), CGRect(x: 24, y: 800, width: 40, height: 40))
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

    private func layout(cancelTranslation: CGFloat = 0, lockness: CGFloat = 0, growth: CGFloat = 1) -> RecordOverlayLayout {
        RecordOverlayLayout(.init(
            button: button,
            bar: bar,
            clock: CGSize(width: 60, height: 18),
            arrow: CGSize(width: 14, height: 14),
            label: CGSize(width: 100, height: 18),
            cancel: CGSize(width: 56, height: 22),
            cancelTranslation: cancelTranslation,
            lockness: lockness,
            growth: growth
        ))
    }

    func testTheCapsuleRunsFromTheLeadingEdgeUnderTheButton() {
        XCTAssertEqual(bar, CGRect(x: 16, y: 780, width: 358, height: 44))
        XCTAssertEqual(RecordOverlayLayout.capsule(button: button, leading: 400), button, "never past the button")
    }

    func testTheCirclesSitOnTheButton() {
        let layout = layout()
        XCTAssertEqual(layout.inner, CGRect(x: 297, y: 747, width: 110, height: 110))
        XCTAssertEqual(layout.outer, CGRect(x: 230, y: 680, width: 244, height: 244))
    }

    func testTheLockPillIs122AboveTheButton() {
        let layout = layout()
        XCTAssertEqual(layout.lockWrapper, CGRect(x: 332, y: 644, width: 40, height: 72))
        XCTAssertEqual(layout.lockPanel, CGRect(x: 0, y: 0, width: 40, height: 72))
        XCTAssertEqual(layout.lockGlyph, CGRect(x: 0, y: 6, width: 40, height: 60))
    }

    func testLockedThePillIsACircleWithTheStopInItsMiddle() {
        let layout = layout(lockness: 1)
        XCTAssertEqual(layout.lockPanel, CGRect(x: 0, y: 40, width: 40, height: 40))
        XCTAssertEqual(layout.lockGlyph, CGRect(x: 0, y: -10, width: 40, height: 60))
        // The animation's middle on the circle's, in the wrapper's space.
        XCTAssertEqual(layout.lockPanel.minY + layout.lockGlyph.midY, layout.lockPanel.midY)
        let halfway = self.layout(lockness: 0.5)
        XCTAssertEqual(halfway.lockPanel, CGRect(x: 0, y: 20, width: 40, height: 56))
        XCTAssertEqual(halfway.lockGlyph.minY, -2)
    }

    func testTheDotAndTheClockAtTheBarsLeftOnTheButtonsLine() {
        let layout = layout()
        XCTAssertEqual(layout.dot, CGRect(x: 32, y: 797, width: 10, height: 10))
        XCTAssertEqual(layout.clock, CGRect(x: 50, y: 793, width: 60, height: 18))
    }

    func testSlideToCancelIsCentredBetweenTheClockAndTheCircle() {
        let layout = layout()
        // The clock ends at 110 and the circle starts at 297: (187 - 120) / 2 in.
        XCTAssertEqual(layout.cancelLine, CGRect(x: 143, y: 793, width: 120, height: 18))
        XCTAssertEqual(layout.cancelArrow, CGRect(x: 143, y: 795, width: 14, height: 14))
        XCTAssertEqual(layout.cancelLabel, CGRect(x: 163, y: 793, width: 100, height: 18))
        XCTAssertEqual(layout.cancelLineAlpha, 1)
        XCTAssertEqual(layout.cancelButton, CGRect(x: 175, y: 791, width: 56, height: 22))
        XCTAssertLessThan(layout.cancelLine.maxX, layout.inner.minX, "clear of the circle")
    }

    func testABarEndingUnderTheCircleCentresTheLineInWhatShows() {
        // Home's toolbar: the bar's glass stops 12 short of the
        // microphone's, under the circle.
        let button = CGRect(x: 331, y: 803, width: 38, height: 38)
        let layout = RecordOverlayLayout(.init(
            button: button,
            bar: CGRect(x: 28, y: 798, width: 286, height: 48),
            clock: CGSize(width: 60, height: 18),
            arrow: CGSize(width: 14, height: 14),
            label: CGSize(width: 100, height: 18),
            cancel: CGSize(width: 56, height: 22)
        ))
        XCTAssertEqual(layout.clock.maxX, 122)
        XCTAssertEqual(layout.inner.minX, 295)
        XCTAssertEqual(layout.cancelLine.minX, 148, "(295 - 122 - 120) / 2 past the clock")
        XCTAssertEqual(layout.cancelButton.minX, 180)
    }

    func testTheLineFollowsTheFingerAtHalfItsPaceAndFadesAtTheClock() {
        XCTAssertEqual(layout(cancelTranslation: 8).cancelLine.minX, 143, "the first 8 points don't move it")
        XCTAssertEqual(layout(cancelTranslation: 10).cancelLine.minX, 142)
        XCTAssertEqual(layout(cancelTranslation: 48).cancelLine.minX, 123)
        // The clock ends at 110; the line fades over the 10 after it.
        XCTAssertEqual(layout(cancelTranslation: 20).cancelLineAlpha, 1)
        XCTAssertEqual(layout(cancelTranslation: 62).cancelLineAlpha, 0.6, accuracy: 1e-9)
        XCTAssertEqual(layout(cancelTranslation: 64).cancelLineAlpha, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout(cancelTranslation: 74).cancelLineAlpha, 0)
    }

    func testTheBarGrowsOutOfTheButtonAlongItsLine() {
        XCTAssertEqual(layout().bar, bar, "grown")
        XCTAssertEqual(layout(growth: 0).bar, button, "the button's own circle")
        XCTAssertEqual(layout(growth: 0.5).bar, CGRect(x: 173, y: 780, width: 201, height: 44))
        XCTAssertEqual(layout(growth: 2).bar, bar, "never past the bar")
        // What the bar holds stays where the grown bar puts it.
        XCTAssertEqual(layout().barContent, CGRect(x: 0, y: 0, width: 358, height: 44))
        XCTAssertEqual(layout(growth: 0.5).barContent, CGRect(x: -157, y: 0, width: 358, height: 44))
        XCTAssertEqual(layout(growth: 0).barContent, CGRect(x: -314, y: 0, width: 358, height: 44))
        XCTAssertEqual(layout(growth: 0.5).clock, layout().clock)
        XCTAssertEqual(layout(growth: 0.5).cancelLine, layout().cancelLine)
    }
}

final class RecordToolbarLayoutTests: XCTestCase {
    func testTheMicrophoneStandsAsTallAsTheToolbarsGlassButtons() {
        XCTAssertEqual(RecordToolbarLayout.Metrics.button, 38, "48 glass less 5 a side")
    }

    /// iPhone 17 Pro, as the simulator lays the toolbar out: the
    /// microphone's view at 331, its glass 326 to 374.
    func testTheBarRunsFromTheToolbarsEdgeTo12BeforeTheMicrophone() {
        let layout = RecordToolbarLayout(width: 402, microphone: CGRect(x: 331, y: 803, width: 38, height: 38))
        XCTAssertEqual(layout.bar, CGRect(x: 28, y: 798, width: 286, height: 48), "as far in as the microphone's glass")
        XCTAssertEqual(layout.barView, CGSize(width: 276, height: 38))
    }

    /// The microphone before compose: its glass 266 to 314, compose's 326
    /// to 374. The bar still starts 28 in, and stops 12 short of the
    /// microphone.
    func testWithComposeAfterTheMicrophoneTheBarStartsAsFarInAsComposeEnds() {
        let layout = RecordToolbarLayout(width: 402, microphone: CGRect(x: 271, y: 803, width: 38, height: 38), after: 1)
        XCTAssertEqual(layout.bar, CGRect(x: 28, y: 798, width: 226, height: 48))
        XCTAssertEqual(layout.barView, CGSize(width: 216, height: 38))
        XCTAssertEqual(RecordToolbarLayout.buttonRoom, 60)
    }

    func testANarrowToolbarStillHasAGlassButtonsWidth() {
        let layout = RecordToolbarLayout(width: 100, microphone: CGRect(x: 40, y: 10, width: 38, height: 38))
        XCTAssertEqual(layout.bar.width, 48)
        XCTAssertEqual(layout.barView, CGSize(width: 38, height: 38))
    }
}

final class RecordBlobTests: XCTestCase {
    func testTheCircleIsTheBlobsMiddle045() {
        XCTAssertEqual(RecordMotion.Metrics.innerDiameter, 110)
        XCTAssertEqual(RecordBlob.Metrics.side, 244)
        XCTAssertEqual(RecordBlob.Metrics.centreScale * 244, 110, accuracy: 1e-9)
    }

    func testTheOuterWaveGrowsFromTelegramsRestToTheCircleTimesPhiSquared() {
        let silent = RecordBlob.scales(level: 0, presence: 1)
        XCTAssertEqual(silent.outer, 0.627, accuracy: 1e-9)
        XCTAssertEqual(silent.middle, (0.627 * 110.0 / 244).squareRoot(), accuracy: 1e-9)
        let loud = RecordBlob.scales(level: 1, presence: 1)
        let phi = (1 + 5.0.squareRoot()) / 2
        XCTAssertEqual(loud.outer, 110.0 / 244 * phi * phi, accuracy: 1e-9)
        // The three circles grow by φ each at full voice.
        XCTAssertEqual(loud.middle / (110.0 / 244), phi, accuracy: 1e-9)
        XCTAssertEqual(loud.outer / loud.middle, phi, accuracy: 1e-9)
        XCTAssertEqual(RecordBlob.scales(level: 2, presence: 1).outer, loud.outer, "the level is clamped")
        XCTAssertEqual(RecordBlob.scales(level: 0, presence: 0.75).outer, 0.627 * 0.75, accuracy: 1e-9)
    }

    func testSpeechSwellsTheWavesAsTelegramsDo() {
        XCTAssertEqual(RecordBlob.swell(0), 0)
        // -30 dB, speech held at the phone: about a tenth.
        XCTAssertEqual(RecordBlob.swell(0.4), 0.08, accuracy: 1e-9)
        XCTAssertEqual(RecordBlob.swell(1), 0.5)
        XCTAssertEqual(RecordBlob.swell(3), 0.5)
    }

    func testThePresenceEasesFromRestingInAThirdOfASecond() {
        XCTAssertEqual(RecordBlob.presence(at: 0), 0.75)
        XCTAssertEqual(RecordBlob.presence(at: 0.175), 0.875, accuracy: 1e-6)
        XCTAssertEqual(RecordBlob.presence(at: 0.35), 1)
        XCTAssertEqual(RecordBlob.presence(at: 9), 1)
    }

    func testTheSameSeedMakesTheSameShapes() {
        var a = RecordBlob(seed: 7)
        var b = RecordBlob(seed: 7)
        XCTAssertEqual(a, b)
        a.advance(by: 3)
        b.advance(by: 3)
        XCTAssertEqual(a.outline(scale: 1, center: .zero), b.outline(scale: 1, center: .zero))
        XCTAssertNotEqual(RecordBlob(seed: 8).from, a.from)
    }

    func testEightPointsBetweenAboutTenEleventhsAndTheEdge() {
        var blob = RecordBlob(seed: 1)
        for _ in 0..<50 {
            XCTAssertEqual(blob.to.count, 8)
            for point in blob.to {
                let radius = (point.x * point.x + point.y * point.y).squareRoot()
                XCTAssertGreaterThanOrEqual(radius, 0.5 / 1.1 - 1e-9)
                XCTAssertLessThanOrEqual(radius, 0.5 + 1e-9)
            }
            blob.advance(by: blob.duration)
        }
    }

    func testSilenceMorphsAShapeIn1Over09SecondsAndALoudVoice4ASecond() {
        var blob = RecordBlob(seed: 3)
        XCTAssertEqual(blob.duration, 1 / 0.9, accuracy: 1e-9)
        blob.hear(1)
        blob.hear(0.2)
        // The loudest heard counts, from the next shape.
        XCTAssertEqual(blob.duration, 1 / 0.9, accuracy: 1e-9)
        blob.advance(by: 1 / 0.9)
        XCTAssertEqual(blob.duration, 0.25, accuracy: 1e-9)
        blob.advance(by: 0.25)
        XCTAssertEqual(blob.duration, 1 / 0.9, accuracy: 1e-9)
    }

    func testAMorphEndsWhereTheNextBegins() {
        var blob = RecordBlob(seed: 5)
        let target = blob.to
        blob.advance(by: blob.duration - 1e-6)
        XCTAssertEqual(blob.progress, 1, accuracy: 1e-4)
        blob.advance(by: 2e-6)
        XCTAssertEqual(blob.from, target)
        XCTAssertEqual(blob.progress, 0, accuracy: 1e-4)
    }

    func testTheOutlineOfACircleIsTheCircle() {
        // Eight points on a circle of radius 100: the curves pass through
        // them and their handles are the circle's tangents, 4/3·tan(π/16)
        // of the radius long.
        let points = (0..<8).map { index -> CGPoint in
            let angle = CGFloat(index) * .pi / 4
            return CGPoint(x: 100 * sin(angle), y: 100 * cos(angle))
        }
        let curves = RecordBlob.smooth(points)
        XCTAssertEqual(curves.count, 8)
        let handle = 4.0 / 3.0 * tan(Double.pi / 16) * 100
        for (index, curve) in curves.enumerated() {
            let next = points[(index + 1) % 8]
            XCTAssertEqual(curve.to, next)
            let from = points[index]
            let dx: CGFloat = curve.control1.x - from.x
            let dy: CGFloat = curve.control1.y - from.y
            XCTAssertEqual(Double((dx * dx + dy * dy).squareRoot()), handle, accuracy: 1e-9)
            // Tangent: square to the radius.
            let dot: CGFloat = dx * from.x + dy * from.y
            XCTAssertEqual(Double(dot), 0, accuracy: 1e-9)
        }
    }

    func testTheOutlineIsScaledToTheSquareRoundTheCentre() {
        let blob = RecordBlob(seed: 2)
        let curves = blob.outline(scale: 0.5, side: 200, center: CGPoint(x: 10, y: 20))
        for (curve, point) in zip(curves, blob.from.dropFirst() + [blob.from[0]]) {
            XCTAssertEqual(curve.to.x, 10 + point.x * 100, accuracy: 1e-9)
            XCTAssertEqual(curve.to.y, 20 + point.y * 100, accuracy: 1e-9)
        }
    }
}
