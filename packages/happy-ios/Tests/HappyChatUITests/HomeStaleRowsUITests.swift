import XCTest

/// Home while its agents work (`-churn`: line counts tick, runs start and
/// stop, new tasks arrive on top), under a real finger: flicks up and down
/// that glide and stop, the app sent to the background and back. The
/// harness checks every row on the list after each quiet moment and keeps
/// what it finds in its Documents (`stale-rows.txt`); this test reads the
/// same check off the screen's accessibility.
@MainActor
final class HomeStaleRowsUITests: XCTestCase {
    func testRowsStayCurrentUnderAFinger() {
        continueAfterFailure = true
        _ = skipsQuiescence
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "groupedHome", "-lineCounts", "-dark", "-churn", "-noJumps"]
        app.launch()
        let list = app.descendants(matching: .any)["home-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 30))
        let minutes = Double(ProcessInfo.processInfo.environment["HAPPY_STALE_MINUTES"] ?? "") ?? 4
        let end = Date().addingTimeInterval(minutes * 60)
        var step = 0
        while Date() < end {
            step += 1
            switch Int.random(in: 0..<12) {
            case 0...3: list.swipeUp(velocity: XCUIGestureVelocity(CGFloat.random(in: 300...3000)))
            case 4...7: list.swipeDown(velocity: XCUIGestureVelocity(CGFloat.random(in: 300...3000)))
            case 8:
                // A flick, stopped by a finger mid-glide.
                list.swipeUp(velocity: .fast)
                list.tap()
            case 9:
                XCUIDevice.shared.press(.home)
                Thread.sleep(forTimeInterval: Double.random(in: 0.5...4))
                app.activate()
            default:
                Thread.sleep(forTimeInterval: Double.random(in: 0.2...2))
            }
            if step % 15 == 0 {
                let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                shot.name = "home-step-\(step)"
                shot.lifetime = .keepAlways
                add(shot)
            }
        }
        // A last check, at rest.
        Thread.sleep(forTimeInterval: 14)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "home-end"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
