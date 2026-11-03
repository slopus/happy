import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The attach menu's gestures, as Telegram runs them, fed synthetic pans.
final class AttachMenuGesturesTests: XCTestCase {
    /// An iPhone 17 Pro's sheet: 217 between rest and expanded.
    private let edge: CGFloat = 217

    /// A pan's steps, the scroll view held where the sheet asks.
    private func run(_ pan: inout AttachSheetPan, _ translations: [CGFloat], scrolled: CGFloat? = nil) -> AttachSheetPan.Step? {
        var last: AttachSheetPan.Step?
        for translation in translations { last = pan.changed(translation: translation, scrolled: scrolled) }
        return last
    }

    // MARK: The sheet's drag

    func testFromRestAnUpwardDragRaisesTheTopAndAFlickExpands() {
        var pan = AttachSheetPan(expanded: false, fullSize: false, edge: edge)
        let step = run(&pan, [-10, -30, -60], scrolled: 0)
        XCTAssertEqual(step?.inset, 157)
        XCTAssertEqual(step?.drop, 0)
        // The grid at its top is held there, bounce off, its own pan reset.
        XCTAssertEqual(step?.pin, true)
        XCTAssertEqual(step?.stopBounce, true)
        XCTAssertEqual(step?.resetScrollTranslation, true)
        // 157 is past half of 217 and slow: back to rest, the grid pinned.
        XCTAssertEqual(pan.ended(translation: -60, velocity: -100, scrolled: 0), .init(outcome: .settle(expanded: false, springVelocity: nil), pin: true, velocity: -100))
        // Flicked up at 900 pt/s: expands on the spring, 900 / 157 relative.
        let flick = pan.ended(translation: -60, velocity: -900, scrolled: 0)
        guard case let .settle(true, velocity?) = flick.outcome else { return XCTFail("\(flick)") }
        XCTAssertEqual(velocity, 900 / 157, accuracy: 0.0001)
    }

    func testFromRestPastHalfWayUpExpandsWithoutAFlick() {
        var pan = AttachSheetPan(expanded: false, fullSize: false, edge: edge)
        _ = run(&pan, [-50, -120])
        XCTAssertEqual(pan.inset, 97)
        XCTAssertEqual(pan.ended(translation: -120, velocity: 0, scrolled: nil).outcome, .settle(expanded: true, springVelocity: 0))
        // Up past expanded the top stops at 0: no rubber band above it.
        _ = run(&pan, [-300])
        XCTAssertEqual(pan.inset, 0)
    }

    func testExpandedADragDownTakesTheTopFirstThenDrops() {
        var pan = AttachSheetPan(expanded: true, fullSize: false, edge: edge)
        var step = run(&pan, [100], scrolled: 0)
        XCTAssertEqual(step?.inset, 100)
        XCTAssertEqual(step?.drop, 0)
        step = run(&pan, [300], scrolled: 0)
        XCTAssertEqual(step?.inset, 217)
        XCTAssertEqual(step?.drop, 83)
        // 83 past rest is past 60: it goes.
        XCTAssertEqual(pan.ended(translation: 300, velocity: 0, scrolled: 0).outcome, .dismiss(velocity: 0))
    }

    func testExpandedPastHalfWayOrFlickedCollapses() {
        var pan = AttachSheetPan(expanded: true, fullSize: false, edge: edge)
        _ = run(&pan, [120], scrolled: 0)
        let end = pan.ended(translation: 120, velocity: 0, scrolled: 0)
        XCTAssertEqual(end.outcome, .settle(expanded: false, springVelocity: 0))
        XCTAssertTrue(end.pin)
        var short = AttachSheetPan(expanded: true, fullSize: false, edge: edge)
        _ = run(&short, [100], scrolled: 0)
        XCTAssertEqual(short.ended(translation: 100, velocity: 0, scrolled: 0).outcome, .settle(expanded: true, springVelocity: nil))
        // Flicked down at 400: the spring takes 400 over the 117 left.
        let flick = short.ended(translation: 100, velocity: 400, scrolled: 0)
        guard case let .settle(false, velocity?) = flick.outcome else { return XCTFail("\(flick)") }
        XCTAssertEqual(velocity, 400 / 117, accuracy: 0.0001)
    }

    func testDismissal() {
        // From rest: 60 past it goes, 59 stays, any drop flicked at 300 goes.
        var pan = AttachSheetPan(expanded: false, fullSize: false, edge: edge)
        _ = run(&pan, [61])
        XCTAssertEqual(pan.ended(translation: 61, velocity: 0, scrolled: nil).outcome, .dismiss(velocity: 0))
        XCTAssertEqual(pan.ended(translation: 59, velocity: 0, scrolled: nil).outcome, .settle(expanded: false, springVelocity: nil))
        XCTAssertEqual(pan.ended(translation: 10, velocity: 301, scrolled: nil).outcome, .dismiss(velocity: 301))
        // Expanded with nothing dropped: a flick of 1800 still goes...
        var top = AttachSheetPan(expanded: true, fullSize: false, edge: edge)
        _ = run(&top, [0], scrolled: 0)
        XCTAssertEqual(top.ended(translation: 0, velocity: 1801, scrolled: 0).outcome, .dismiss(velocity: 1801))
        // ...unless the grid had scrolled, which keeps the flick.
        XCTAssertEqual(top.ended(translation: 0, velocity: 1801, scrolled: 40).outcome, .settle(expanded: true, springVelocity: nil))
        // A sheet that can't rest lower: 180.
        var full = AttachSheetPan(expanded: false, fullSize: true, edge: 0)
        _ = run(&full, [100])
        XCTAssertEqual(full.inset, 0)
        XCTAssertEqual(full.ended(translation: 100, velocity: 0, scrolled: nil).outcome, .settle(expanded: true, springVelocity: nil))
        XCTAssertEqual(full.ended(translation: 181, velocity: 0, scrolled: nil).outcome, .dismiss(velocity: 0))
    }

    func testPicksMakeAPullAsk() {
        var pan = AttachSheetPan(expanded: false, fullSize: false, edge: edge)
        XCTAssertFalse(pan.changed(translation: 40, scrolled: 0, guarded: true).ask)
        XCTAssertTrue(pan.changed(translation: 41, scrolled: 0, guarded: true).ask)
        XCTAssertFalse(pan.changed(translation: 41, scrolled: 0, guarded: false).ask)
        // Expanded, the pull only brings it to rest: no question, and no dismissal.
        var top = AttachSheetPan(expanded: true, fullSize: false, edge: edge)
        XCTAssertFalse(top.changed(translation: 300, scrolled: 0, guarded: true).ask)
        XCTAssertEqual(top.ended(translation: 300, velocity: 0, scrolled: 0, guarded: true).outcome, .settle(expanded: false, springVelocity: 0))
    }

    /// The grid scrolled down a page, expanded: a drag down scrolls it
    /// back while the sheet stays; at the top the sheet takes over with
    /// no jump, the finger's travel so far forgotten.
    func testAScrolledGridHandsTheFingerToTheSheetAtItsTop() {
        var pan = AttachSheetPan(expanded: true, fullSize: false, edge: edge)
        var scrolled: CGFloat = 300
        var translation: CGFloat = 0
        for _ in 0..<30 {
            translation += 10
            scrolled = max(0, scrolled - 10)
            let step = pan.changed(translation: translation, scrolled: scrolled)
            if step.resetTranslation { translation = 0 }
            if scrolled > 1 {
                XCTAssertEqual(step.inset, 0)
                XCTAssertFalse(step.pin)
            }
        }
        // 30 moves of 10: the grid took 300; the move that brought it to
        // its top is the sheet's first.
        XCTAssertEqual(scrolled, 0)
        XCTAssertEqual(pan.inset, 10)
        // Then each 10 more moves the sheet 10.
        for move in 2...6 {
            translation += 10
            let step = pan.changed(translation: translation, scrolled: 0)
            XCTAssertEqual(step.inset, CGFloat(move * 10))
            XCTAssertTrue(step.pin)
        }
    }

    /// At rest, a drag up on the grid moves the sheet until it is expanded,
    /// then the grid scrolls; the sheet keeps the travel it had.
    func testAtRestTheSheetTakesTheFingerUntilExpandedThenTheGridScrolls() {
        var pan = AttachSheetPan(expanded: false, fullSize: false, edge: edge)
        var step = pan.changed(translation: -100, scrolled: 0)
        XCTAssertEqual(step.inset, 117)
        XCTAssertTrue(step.resetScrollTranslation)
        step = pan.changed(translation: -217, scrolled: 0)
        XCTAssertEqual(step.inset, 0)
        // Past expanded the grid scrolls; the sheet keeps its last offset.
        step = pan.changed(translation: -260, scrolled: 43)
        XCTAssertEqual(step.inset, 0)
        XCTAssertFalse(step.pin)
        XCTAssertFalse(step.resetScrollTranslation)
        XCTAssertEqual(step.translation, -217)
        // Already expanded: nothing left to travel, so no spring velocity.
        XCTAssertEqual(pan.ended(translation: -260, velocity: -50, scrolled: 43).outcome, .settle(expanded: true, springVelocity: 0))
    }

    // MARK: Picking by dragging

    /// Five pictures in a row of a 3-wide grid, 100 apart: a sideways drag
    /// over them picks all five, starting from one picked already.
    func testADragSidewaysPicksEveryPictureItPasses() {
        var picked: Set<Int> = [0]
        let item = { (point: CGPoint) -> (index: Int, picked: Bool)? in
            let index = Int(point.x / 100)
            guard (0..<5).contains(index), point.y >= 0, point.y < 100 else { return nil }
            return (index, picked.contains(index))
        }
        let set = { (index: Int, on: Bool) in if on { picked.insert(index) } else { picked.remove(index) } }
        var drag = AttachSelectionDrag(start: CGPoint(x: 150, y: 50))
        XCTAssertEqual(drag.moved(to: CGPoint(x: 155, y: 52), item: item, set: set), .none)
        // 9 sideways: picking starts; the first picture under the finger
        // (1, unpicked) says pick.
        XCTAssertEqual(drag.moved(to: CGPoint(x: 159, y: 52), item: item, set: set), .began)
        XCTAssertEqual(drag.phase, .picking(true))
        XCTAssertEqual(picked, [0, 1])
        for x in stride(from: 200, through: 480, by: 40) {
            XCTAssertEqual(drag.moved(to: CGPoint(x: CGFloat(x), y: 60), item: item, set: set), .none)
        }
        XCTAssertEqual(picked, [0, 1, 2, 3, 4])
        // Back to the start doesn't unpick what it passed.
        _ = drag.moved(to: CGPoint(x: 10, y: 60), item: item, set: set)
        XCTAssertEqual(picked, [0, 1, 2, 3, 4])
    }

    func testADragThatStartsOnAPickedPictureUnpicks() {
        var picked: Set<Int> = [1, 2, 3]
        let item = { (point: CGPoint) -> (index: Int, picked: Bool)? in (Int(point.x / 100), picked.contains(Int(point.x / 100))) }
        let set = { (index: Int, on: Bool) in if on { picked.insert(index) } else { picked.remove(index) } }
        var drag = AttachSelectionDrag(start: CGPoint(x: 150, y: 50))
        XCTAssertEqual(drag.moved(to: CGPoint(x: 140, y: 50), item: item, set: set), .began)
        XCTAssertEqual(drag.phase, .picking(false))
        for x in [220, 290, 350] { _ = drag.moved(to: CGPoint(x: CGFloat(x), y: 50), item: item, set: set) }
        XCTAssertEqual(picked, [])
    }

    func testUpOrDownFirstIsAScrollAndTheLeftEdgeIsTheSystems() {
        var drag = AttachSelectionDrag(start: CGPoint(x: 150, y: 50))
        let none = { (_: CGPoint) -> (index: Int, picked: Bool)? in nil }
        XCTAssertEqual(drag.moved(to: CGPoint(x: 154, y: 56), item: none, set: { _, _ in XCTFail() }), .failed)
        XCTAssertEqual(drag.moved(to: CGPoint(x: 250, y: 56), item: none, set: { _, _ in XCTFail() }), .failed)
        XCTAssertEqual(AttachSelectionDrag(start: CGPoint(x: 44, y: 50)).phase, .failed)
        XCTAssertEqual(AttachSelectionDrag(start: CGPoint(x: 44.5, y: 50)).phase, .tracking)
    }

    // MARK: The tab bar's lens

    func testTheLensFollowsTheFingerInsideTheBarAndPicksTheNearestTab() {
        let frames = [CGRect(x: 3, y: 0, width: 72, height: 62), CGRect(x: 85, y: 0, width: 72, height: 62)]
        var lens = AttachTabLens(location: CGPoint(x: 20, y: 30), frames: frames)
        XCTAssertEqual(lens?.item, 0)
        XCTAssertEqual(lens?.startX, 3)
        let resting = CGRect(x: 3, y: 3, width: 72, height: 56)
        lens?.moved(translation: 40, location: CGPoint(x: 60, y: 30), frames: frames)
        XCTAssertEqual(lens?.item, 0)
        // Lifted: 2 bigger each side.
        XCTAssertEqual(lens?.lens(selection: resting, width: 160), CGRect(x: 41, y: 1, width: 76, height: 60))
        lens?.moved(translation: 200, location: CGPoint(x: 220, y: 30), frames: frames)
        XCTAssertEqual(lens?.item, 1)
        // Kept 3 in from the bar's end.
        XCTAssertEqual(lens?.lens(selection: resting, width: 160), CGRect(x: 83, y: 1, width: 76, height: 60))
        // In the 10 between the tabs: the nearer one.
        XCTAssertEqual(AttachTabLens.item(at: CGPoint(x: 81, y: 30), frames: frames), 1)
        XCTAssertEqual(AttachTabLens.item(at: CGPoint(x: 78, y: 30), frames: frames), 0)
    }
}
