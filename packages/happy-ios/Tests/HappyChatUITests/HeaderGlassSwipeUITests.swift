import XCTest

/// A swipe back from a chat held midway, through the whole app offline
/// (`-screen split`, dark): the header as it stands half way between the
/// chat and home, for a recording of its glass (`simctl io recordVideo`
/// while this runs). Let go of short of half way, the chat stays and its
/// title is still there; carried past it, home comes back.
/// `HostedHeaderGlassTransitionTests` reads the bar frame by frame through
/// a push and a pop; a held swipe can only be made from here.
final class HeaderGlassSwipeUITests: XCTestCase {
    override func setUp() {
        // The system's glass never lets the app idle: act without waiting.
        _ = skipsQuiescence
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testASwipeHeldMidwayLetGoOfAndThenCarriedThrough() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "split", "-narrow", "-agent", "-dark", "-open", "ipad-agent"]
        app.launch()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "the chat never opened")
        let window = app.windows.firstMatch
        if window.frame.width >= 768 { throw XCTSkip("a split window has nothing under the chat to go back to") }
        sleep(1)
        func hold(to x: CGFloat, for seconds: TimeInterval) {
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5)).press(
                forDuration: 0.05,
                thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)),
                withVelocity: .slow,
                thenHoldForDuration: seconds
            )
            sleep(1)
        }
        hold(to: 0.4, for: 2)
        XCTAssertTrue(composer.exists, "a swipe let go of short of half way left the chat")
        XCTAssertTrue(app.descendants(matching: .any)["chat-title"].firstMatch.exists, "the chat's title is gone")
        hold(to: 0.7, for: 2)
        XCTAssertTrue(app.buttons["account-switcher"].firstMatch.waitForExistence(timeout: 3), "carried past half way, home didn't come back")
    }
}
