import XCTest

/// What's New flung by a finger in `HappyChatHarness` (`-screen whatsnew`),
/// for a screen recording of a fast scroll: down to the end and back up.
/// Asserts only that the screen opened and scrolled.
final class WhatsNewScrollUITests: XCTestCase {
    func testFastFlingsThroughWhatsNew() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "whatsnew"] + extraArguments
        app.launch()
        let probe = app.otherElements["whatsnew-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 30))
        let deadline = Date().addingTimeInterval(60)
        while probe.value as? String != "done", Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertEqual(probe.value as? String, "done")
        let list = app.scrollViews.firstMatch
        XCTAssertTrue(list.exists)
        for _ in 0..<6 { list.swipeUp(velocity: .fast) }
        for _ in 0..<6 { list.swipeDown(velocity: .fast) }
    }

    /// `WHATSNEW_UI_ARGS` in the test's environment, split on spaces (a text
    /// size, `-UIPreferredContentSizeCategoryName …`).
    private var extraArguments: [String] {
        (ProcessInfo.processInfo.environment["WHATSNEW_UI_ARGS"] ?? "").split(separator: " ").map(String.init)
    }
}
