import CoreGraphics
import HappyLayout
import XCTest

/// Going back by dragging the screen right, from anywhere on it.
final class SwipeBackLayoutTests: XCTestCase {
    private func decide(_ x: CGFloat, _ y: CGFloat, from start: CGFloat = 200, edgeOnly: Bool = false) -> SwipeBack.Decision {
        SwipeBack.decide(startX: start, width: 402, translation: CGPoint(x: x, y: y), edgeOnly: edgeOnly)
    }

    func testTheThresholdsAreStricterThanTelegrams() {
        XCTAssertEqual(SwipeBack.Metrics.edgeWidth, 16)
        XCTAssertEqual(SwipeBack.Metrics.horizontalSlop, 8)
        XCTAssertEqual(SwipeBack.Metrics.verticalSlop, 2)
        XCTAssertEqual(SwipeBack.Metrics.decideDistance, 18)
        XCTAssertEqual(SwipeBack.Metrics.minimumVelocity, 20)
        XCTAssertEqual(SwipeBack.Metrics.completeProgress, 0.33)
        XCTAssertEqual(SwipeBack.Metrics.completeVelocity, 1300)
    }

    func testAShortDragWaits() {
        XCTAssertEqual(decide(0, 0), .undecided)
        XCTAssertEqual(decide(8, 0), .undecided)
        XCTAssertEqual(decide(2, 2), .undecided)
    }

    func testARightwardDragPastTheSlopGoesBack() {
        XCTAssertEqual(decide(8.5, 0), .begin)
        XCTAssertEqual(decide(9, 4), .begin)
        // Not twice as far sideways: waits for the deciding distance.
        XCTAssertEqual(decide(9, 5), .undecided)
        XCTAssertEqual(decide(14, 12), .begin)
    }

    func testADownwardDragIsAScrollAtOnce() {
        XCTAssertEqual(decide(0, 2.5), .fail)
        XCTAssertEqual(decide(1, 3), .fail)
        XCTAssertEqual(decide(12, 14), .fail)
    }

    func testLeftIsNeverBack() {
        XCTAssertEqual(decide(-1, 0), .fail)
        XCTAssertEqual(decide(-1, 0, from: 4), .fail)
    }

    func testFromTheEdgeOnlyTheDirectionMatters() {
        XCTAssertEqual(decide(7, 30, from: 10), .undecided)
        XCTAssertEqual(decide(8, 30, from: 10), .begin)
        XCTAssertTrue(SwipeBack.allows(startX: 15.9, width: 402, edgeOnly: true))
    }

    func testOnSidewaysContentOnlyTheEdgeGoesBack() {
        XCTAssertFalse(SwipeBack.allows(startX: 16, width: 402, edgeOnly: true))
        XCTAssertTrue(SwipeBack.allows(startX: 16, width: 402, edgeOnly: false))
        XCTAssertEqual(decide(30, 0, edgeOnly: true), .fail)
        XCTAssertEqual(decide(8, 0, from: 4, edgeOnly: true), .begin)
    }

    func testTheVelocityGate() {
        XCTAssertTrue(SwipeBack.shouldBegin(velocity: CGPoint(x: 20, y: 0)))
        XCTAssertFalse(SwipeBack.shouldBegin(velocity: CGPoint(x: 19, y: 0)))
        XCTAssertFalse(SwipeBack.shouldBegin(velocity: CGPoint(x: 100, y: 251)))
        XCTAssertTrue(SwipeBack.shouldBegin(velocity: CGPoint(x: 100, y: 249)))
    }

    func testProgressAndCompletion() {
        XCTAssertEqual(SwipeBack.progress(translation: 134, width: 402), 134.0 / 402)
        XCTAssertEqual(SwipeBack.progress(translation: -5, width: 402), 0)
        XCTAssertEqual(SwipeBack.progress(translation: 500, width: 402), 1)
        XCTAssertFalse(SwipeBack.completes(progress: 0.33, velocity: 1300))
        XCTAssertTrue(SwipeBack.completes(progress: 0.34, velocity: 0))
        XCTAssertTrue(SwipeBack.completes(progress: 0.05, velocity: 1301))
    }

    func testFinishTimingFollowsTheFinger() {
        // 201 left at 2010 a second: 0.1 s.
        XCTAssertEqual(SwipeBack.finishDuration(progress: 0.5, width: 402, velocity: 2010), 0.1, accuracy: 1e-9)
        XCTAssertEqual(SwipeBack.finishDuration(progress: 0.5, width: 402, velocity: 100_000), 0.05)
        XCTAssertEqual(SwipeBack.finishDuration(progress: 0.5, width: 402, velocity: 10), 0.2)
        XCTAssertEqual(SwipeBack.finishDuration(progress: 0, width: 402, velocity: 0), 0.5)
    }

    func testFramesAtAThird() {
        let frames = SwipeBack.frames(progress: 1.0 / 3, width: 402, scale: 3)
        XCTAssertEqual(frames.topX, 134)
        XCTAssertEqual(frames.bottomX, -80.4, accuracy: 1e-9)
        XCTAssertEqual(frames.dimAlpha, 0.1, accuracy: 1e-9)
        XCTAssertEqual(frames.shadowAlpha, 0.6, accuracy: 1e-9)
        // On the screen's pixels.
        XCTAssertEqual(SwipeBack.frames(progress: 0.5, width: 393, scale: 3).topX, 196.333333333333314, accuracy: 1e-9)
        XCTAssertEqual(SwipeBack.frames(progress: 0, width: 402, scale: 3), .init(topX: 0, bottomX: -120.6, dimAlpha: 0.15, shadowAlpha: 0.9))
        XCTAssertEqual(SwipeBack.frames(progress: 1, width: 402, scale: 3), .init(topX: 402, bottomX: 0, dimAlpha: 0, shadowAlpha: 0))
    }
}
