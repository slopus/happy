import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class HomeDockLayoutTests: XCTestCase {
    private func dock(entry: String = "Plan, ask, build…", safeBottom: CGFloat = 34) -> HomeDockLayout {
        HomeDockLayout(.init(size: phone, safeBottom: safeBottom, hairline: 0.5, entry: text(entry, lineHeight: 22, maxLines: 1)))
    }

    func testRestingDockSitsOnTheHomeIndicator() {
        let layout = dock()
        // 8 above the capsule, 56 of capsule, the 34 home indicator below.
        assertFrame(layout.dock, rect(0, 754, 393, 98))
        assertFrame(layout.composer, rect(16, 762, 361, 56))
        // From the capsule's middle down.
        assertFrame(layout.scrim, rect(0, 790, 393, 62))
    }

    func testCapsuleContents() {
        let layout = dock()
        // Inside the 0.5 rim: 7 of padding, the 42 button at the end.
        assertFrame(layout.send, rect(327.5, 769, 42, 42))
        // The text box stops 8 + 4 short of the button.
        assertFrame(layout.entry, rect(23.5, 762.5, 292, 55))
        // The text starts at the tangent: 7 + 21 in from the rim.
        assertFrame(layout.entryText, rect(44.5, 779, 136, 22))
    }

    func testLongPromptIsClampedToItsLane() {
        let layout = dock(entry: String(repeating: "x", count: 40))
        assertFrame(layout.entryText, rect(44.5, 779, 267, 22))
    }

    func testNoHomeIndicatorKeepsTenBelow() {
        let layout = dock(safeBottom: 0)
        assertFrame(layout.dock, rect(0, 778, 393, 74))
        assertFrame(layout.composer, rect(16, 786, 361, 56))
        assertFrame(layout.scrim, rect(0, 814, 393, 38))
    }

    func testContentInsetIsHappyAppsConstant() {
        XCTAssertEqual(HomeDockLayout.Metrics.contentInset, 108)
    }

    // MARK: Focus

    private let rowValues = ["MacBook Pro", "~/happy", "No worktree", "Claude Code"]

    private func focus(progress: String? = nil, hint: String? = nil, composerHeight: CGFloat = 102) -> HomeDockFocusLayout {
        HomeDockFocusLayout(.init(
            size: phone,
            safeBottom: 34,
            composerHeight: composerHeight,
            rows: rowValues.map { text($0, lineHeight: 22, maxLines: 1) },
            progress: progress.map { text($0, lineHeight: 14, maxLines: 1) },
            hint: hint.map { text($0, lineHeight: 14, maxLines: 1) }
        ))
    }

    func testFocusedComposerSitsEightAboveTheSafeArea() {
        assertFrame(focus().composer, rect(16, 708, 361, 102))
    }

    func testPickerRowsStackAboveTheStatusLinesRoom() {
        let layout = focus()
        XCTAssertEqual(layout.rows.count, 4)
        // 42 tall, 1 apart, 22 clear of the composer.
        assertFrame(layout.rows[0].frame, rect(24, 515, 345, 42))
        assertFrame(layout.rows[1].frame, rect(24, 558, 345, 42))
        assertFrame(layout.rows[2].frame, rect(24, 601, 345, 42))
        assertFrame(layout.rows[3].frame, rect(24, 644, 345, 42))
        // A 24 icon box after 6 of padding, the value 12 after it.
        assertFrame(layout.rows[0].icon, rect(30, 524, 24, 24))
        assertFrame(layout.rows[0].trigger, rect(66, 515, 297, 42))
        assertFrame(layout.rows[0].value, rect(66, 525, 88, 22))
        assertFrame(layout.rows[1].value, rect(66, 568, 56, 22))
    }

    func testLongRowValueLeavesTheTriggersSpacer() {
        let layout = HomeDockFocusLayout(.init(
            size: phone,
            safeBottom: 34,
            composerHeight: 102,
            rows: [text(String(repeating: "x", count: 60), lineHeight: 22, maxLines: 1)]
        ))
        // 297 of trigger less its 8pt minimum spacer.
        assertFrame(layout.rows[0].value, rect(66, 654, 289, 22))
    }

    func testRowsRideOnAGrowingComposer() {
        // Halfway open: the shell is 79, and the rows sit on it.
        let layout = focus(composerHeight: 79)
        assertFrame(layout.composer, rect(16, 731, 361, 79))
        assertFrame(layout.rows[3].frame, rect(24, 667, 345, 42))
    }

    func testStatusLineWithStop() {
        let layout = focus(progress: "Starting Claude Code…", hint: "To interrupt press stop")
        assertFrame(layout.progress, rect(16, 690, 361, 18))
        assertFrame(layout.progressDot, rect(32, 696, 6, 6))
        // The hint holds the right; the label gives way 6 short of it.
        assertFrame(layout.progressHint, rect(177, 692, 184, 14))
        assertFrame(layout.progressLabel, rect(44, 692, 127, 14))
        // Showing it moves nothing.
        assertFrame(layout.rows[3].frame, focus().rows[3].frame)
    }

    func testStatusLineWithoutStop() {
        let layout = focus(progress: "Starting Claude Code…")
        XCTAssertNil(layout.progressHint)
        assertFrame(layout.progressLabel, rect(44, 692, 168, 14))
    }

    func testNoStatusLineWhileIdle() {
        let layout = focus()
        XCTAssertNil(layout.progress)
        XCTAssertNil(layout.progressDot)
        XCTAssertNil(layout.progressLabel)
    }

    func testKeyboardShift() {
        // Down: the guide's top is the safe area's bottom.
        XCTAssertEqual(HomeDockFocusLayout.keyboardShift(keyboardTop: 818, size: phone, safeBottom: 34), 0)
        // Up: the composer ends 8 above the keyboard.
        let shift = HomeDockFocusLayout.keyboardShift(keyboardTop: 516, size: phone, safeBottom: 34)
        XCTAssertEqual(shift, -302)
        XCTAssertEqual(focus().composer.maxY + shift, 508)
    }

    // MARK: Motion

    func testMotionClosed() {
        let motion = HomeDockFocusMotion(progress: 0)
        XCTAssertEqual(motion.backdropAlpha, 0)
        XCTAssertEqual(motion.composerHeight(full: 102), 56)
        XCTAssertEqual(motion.composerAlpha, 0.72, accuracy: 0.0001)
        XCTAssertEqual(motion.composerScaleX, 0.96, accuracy: 0.0001)
        XCTAssertEqual(motion.row(0).alpha, 0)
        XCTAssertEqual(motion.row(0).offsetY, 10)
    }

    func testMotionOpen() {
        let motion = HomeDockFocusMotion(progress: 1)
        XCTAssertEqual(motion.backdropAlpha, 1)
        XCTAssertEqual(motion.composerHeight(full: 102), 102)
        XCTAssertEqual(motion.composerAlpha, 1)
        XCTAssertEqual(motion.composerScaleX, 1)
        XCTAssertEqual(motion.row(3).alpha, 1)
    }

    func testMotionMidway() {
        XCTAssertEqual(HomeDockFocusMotion(progress: 0.35).backdropAlpha, 1, accuracy: 0.0001)
        XCTAssertEqual(HomeDockFocusMotion(progress: 0.06).composerAlpha, 0.86, accuracy: 0.0001)
        // Each row a beat after the one above.
        let rows = HomeDockFocusMotion(progress: 0.32)
        XCTAssertEqual(rows.row(0).alpha, 0.5, accuracy: 0.0001)
        XCTAssertEqual(rows.row(0).offsetY, 5, accuracy: 0.0001)
        XCTAssertEqual(rows.row(1).alpha, 0.5 - 0.09 / 0.28, accuracy: 0.0001)
        XCTAssertEqual(rows.row(2).alpha, 0)
        XCTAssertEqual(HomeDockFocusMotion(progress: 0.5).composerHeight(full: 102), 79)
    }

    func testEasings() {
        XCTAssertEqual(HomeDockFocusMotion.easeOut(0.5), 0.875, accuracy: 0.0001)
        XCTAssertEqual(HomeDockFocusMotion.easeIn(0.5), 0.125, accuracy: 0.0001)
        XCTAssertEqual(HomeDockFocusMotion.easeOut(2), 1)
        XCTAssertEqual(HomeDockFocusMotion.easeIn(-1), 0)
    }

    func testRefusalFlashIsTwoBeats() {
        XCTAssertEqual(HomeDockRefusal.flashDuration, 0.65, accuracy: 0.0001)
        XCTAssertEqual(HomeDockRefusal.flash(at: 0), 0)
        XCTAssertEqual(HomeDockRefusal.flash(at: 0.045), 0.5, accuracy: 0.0001)
        XCTAssertEqual(HomeDockRefusal.flash(at: 0.09), 1, accuracy: 0.0001)
        XCTAssertEqual(HomeDockRefusal.flash(at: 0.22), 0, accuracy: 0.0001)
        XCTAssertEqual(HomeDockRefusal.flash(at: 0.31), 1, accuracy: 0.0001)
        XCTAssertEqual(HomeDockRefusal.flash(at: 0.65), 0)
    }

    func testDockTokensFromHappyApp() {
        let magenta = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in Palette.homeDock {
            XCTAssertNotEqual(token.light, magenta)
            XCTAssertNotEqual(token.dark, magenta)
        }
        XCTAssertEqual(Palette.homeDockBackdropDim.light.alpha, 0.88)
        XCTAssertEqual(TextStyles.homeDockEntry, TextStyle(.regular, size: 17))
        XCTAssertEqual(TextStyles.homeDockProgress, TextStyle(.regular, size: 11))
    }
}
