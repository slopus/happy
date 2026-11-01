import XCTest

/// Swipe back through the app's own cold start: AppCoordinator's window,
/// its `ShellViewController`, the stack it builds (`-screen split`, the
/// whole app offline). The isolated hosted tests build their navigation
/// before the shell; these build it as the app does.
///
/// A chat opened from home goes back by a swipe from the edge, by one from
/// mid-screen (iOS 26's content swipe), and stays after a swipe let go of
/// early. On an iPad the window is narrowed first (`-narrow`), to the
/// one stack; the swipes are made inside it.
final class SwipeBackUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func launch(_ arguments: [String]) {
        app = XCUIApplication()
        // On an iPad, narrowed to the one stack first.
        app.launchArguments = ["-screen", "split", "-narrow"] + arguments
        app.launch()
    }

    /// An iPad's window once `-narrow` has narrowed it; a phone's at once.
    private func requireOneStack() throws {
        let window = app.windows.firstMatch
        let deadline = Date().addingTimeInterval(10)
        while window.frame.width >= 768, Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
        if window.frame.width >= 768 { throw XCTSkip("a split window has nothing under the chat to go back to") }
    }

    private var composer: XCUIElement { app.textViews["composer"] }
    private var switcher: XCUIElement { app.buttons["account-switcher"].firstMatch }

    /// The agent's chat over its home, on a phone's one stack.
    private func openChat() throws {
        launch(["-agent", "-open", "ipad-agent"])
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "the chat never opened")
        try requireOneStack()
        sleep(1)
    }

    private func swipe(from: CGFloat, to: CGFloat) {
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.5)).press(
            forDuration: 0.05,
            thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.5)),
            withVelocity: .slow,
            thenHoldForDuration: 0.1
        )
        sleep(1)
    }

    private func atHome() -> Bool {
        switcher.waitForExistence(timeout: 3) && !composer.exists
    }

    func testAnEdgeSwipeGoesBack() throws {
        try openChat()
        swipe(from: 0.005, to: 0.95)
        XCTAssertTrue(atHome(), "the edge swipe didn't go back")
    }

    func testASwipeFromMidScreenGoesBack() throws {
        try openChat()
        swipe(from: 0.3, to: 0.95)
        XCTAssertTrue(atHome(), "the content swipe didn't go back")
    }

    func testASwipeLetGoOfEarlyStays() throws {
        try openChat()
        swipe(from: 0.005, to: 0.15)
        XCTAssertTrue(composer.exists, "a swipe let go of early left the chat")
        // And the stack still goes back afterwards.
        swipe(from: 0.005, to: 0.95)
        XCTAssertTrue(atHome(), "after a cancelled swipe, the next one didn't go back")
    }

    /// A Happy CLI chat over the legacy home, by the edge.
    func testALegacyChatGoesBackByTheEdge() throws {
        launch(["-open", "seeded-main"])
        try requireOneStack()
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 20))
        sleep(2)
        let list = app.descendants(matching: .any)["home-list"]
        swipe(from: 0.005, to: 0.95)
        XCTAssertTrue(switcher.waitForExistence(timeout: 3) || list.exists, "the legacy chat didn't go back")
    }
}
