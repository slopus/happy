import XCTest

/// Home's bots and tasks under a real finger (`-screen groupedHome`, whose
/// computer keeps moves and archives as the daemon does): a task held still
/// lifts without a preview and goes back where it was, a task held and
/// moved up past another lands there and stays once the computer has it,
/// and a task swiped all the way across is archived.
/// `HAPPY_RECORD_SECONDS` records what the window draws meanwhile
/// (`-recordFrames`).
@MainActor
final class HomeReorderArchiveUITests: XCTestCase {
    private func shot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func wait(_ timeout: TimeInterval = 5, until condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return condition()
    }

    func testAHeldTaskMovesAndASwipedTaskArchives() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "groupedHome"]
        if let seconds = ProcessInfo.processInfo.environment["HAPPY_RECORD_SECONDS"] { app.launchArguments += ["-recordFrames", seconds] }
        app.launch()
        let landing = app.descendants(matching: .any)["row:space:Landing page copy"]
        let report = app.descendants(matching: .any)["row:space:Quarterly report"]
        XCTAssertTrue(report.waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 1)
        // The tasks up the screen, clear of the toolbar and the home indicator.
        let list = app.descendants(matching: .any)["home-list"]
        list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)), withVelocity: .slow, thenHoldForDuration: 0.3)
        Thread.sleep(forTimeInterval: 1)
        XCTAssertLessThan(report.frame.maxY, app.frame.height - 160, "the tasks are still at the bottom")
        XCTAssertLessThan(landing.frame.minY, report.frame.minY)
        shot("1-before")

        // Held still and let go: it lifted rather than showing its preview,
        // and is set down where it was.
        report.press(forDuration: 0.8)
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertFalse(app.descendants(matching: .any)["hold-dismiss"].exists, "the hold showed the preview")
        XCTAssertLessThan(landing.frame.minY, report.frame.minY, "a hold that didn't move moved the task")

        // Held, which lifts it, then moved: it is carried up past Landing
        // page copy and Fix login crash.
        let from = report.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = landing.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        from.press(forDuration: 0.8, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.4)
        XCTAssertTrue(wait { report.frame.minY < landing.frame.minY }, "the task didn't land where it was put")
        shot("2-moved")
        // The computer's own order, read again, agrees.
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertLessThan(report.frame.minY, landing.frame.minY, "the task went back")

        // Swiped all the way across: archived, its row gone.
        let onboarding = app.descendants(matching: .any)["row:space:Onboarding emails"]
        XCTAssertTrue(onboarding.exists)
        let right = onboarding.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5))
        let left = onboarding.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5))
        right.press(forDuration: 0.05, thenDragTo: left, withVelocity: .fast, thenHoldForDuration: 0.1)
        XCTAssertTrue(wait { !onboarding.exists }, "the swiped task is still listed")
        shot("3-archived")
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertFalse(onboarding.exists, "the archived task came back")

        // A short swipe stands it open on Archive; a tap elsewhere puts it back.
        let crash = app.descendants(matching: .any)["row:space:Fix login crash"]
        let start = crash.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        let open = crash.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: open, withVelocity: .slow, thenHoldForDuration: 0)
        Thread.sleep(forTimeInterval: 0.6)
        shot("4-swiped-open")
        landing.tap()
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertTrue(crash.exists)
        XCTAssertTrue(landing.exists, "the tap that put the swipe back opened a conversation")
        shot("5-closed")
        if ProcessInfo.processInfo.environment["HAPPY_RECORD_SECONDS"] != nil { Thread.sleep(forTimeInterval: 3) }
    }
}
