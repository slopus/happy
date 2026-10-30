import XCTest

/// The legacy home's bar with its seeded sessions, driven by a finger: the
/// account switcher's native menu opens and lists the account, Add and
/// Manage Accounts. With `HAPPY_PREVIEW_DIR` set, it writes the screens.
final class HeaderUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    private func keep(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    func testTheAccountSwitcherOpensItsMenu() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", "UITableView", "-sessionCount", "40"]
        app.launch()
        let switcher = app.buttons["account-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["settings"].exists)
        let style = ProcessInfo.processInfo.environment["HAPPY_STYLE"] ?? "light"
        sleep(1)
        keep("legacy-home-\(style)")
        app.swipeUp()
        sleep(1)
        keep("legacy-home-scrolled-\(style)")
        switcher.tap()
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Manage Accounts"].exists)
        sleep(1)
        keep("account-menu-\(style)")
        app.buttons["Manage Accounts"].tap()
        XCTAssertTrue(app.staticTexts["Accounts"].waitForExistence(timeout: 5))
        sleep(1)
        keep("manage-accounts-\(style)")
    }

    /// The same screen in the real tablet shell: `TabletShellViewController`
    /// with its sidebar, the persistent header, and home as the stack's
    /// root, which is what `-screen home` mounts. Beside the sidebar home
    /// itself draws nothing, so this is the one test that the accounts are
    /// still reachable there — at the blank root, and with a session open in
    /// the detail, where a tablet has no back button in the bar.
    func testTheSwitcherOpensItsMenuBesideTheSidebar() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", "UITableView", "-sessionCount", "40"]
        app.launch()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        // `TabletBreakpoint`: a narrow window has no shell to test.
        try XCTSkipUnless(window.frame.width >= 768, "a phone-wide window has no sidebar")
        let style = ProcessInfo.processInfo.environment["HAPPY_STYLE"] ?? "light"
        let switcher = app.buttons["account-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 20))
        // Beside the sidebar home draws nothing and has no dock, so the
        // chat's composer is what tells a session open from the blank root.
        let composer = app.textViews.firstMatch
        sleep(2)
        XCTAssertTrue(app.buttons["Back"].exists, "the shell's persistent header is up")
        XCTAssertFalse(composer.exists, "nothing is open in the detail yet")
        keep("shell-root-\(style)")

        switcher.tap()
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Manage Accounts"].exists)
        sleep(1)
        keep("shell-root-menu-\(style)")
        // Away from the menu, which leaves the shell as it was.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)).tap()
        sleep(1)

        // A session from the sidebar, which is the only way in beside it.
        let row = app.staticTexts["Session 35"]
        if row.waitForExistence(timeout: 5) {
            row.tap()
        } else {
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.14, dy: 0.2)).tap()
        }
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "no session opened in the detail")
        sleep(2)
        keep("shell-detail-\(style)")

        XCTAssertTrue(switcher.exists, "with a session open the accounts are still reachable")
        switcher.tap()
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
        sleep(1)
        keep("shell-detail-menu-\(style)")
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)).tap()
        sleep(1)

        // Back to the blank root, where there is no composer again, so the
        // same signal can tell the next session open.
        app.buttons["Back"].tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: composer)
        wait(for: [closed], timeout: 15)

        // The whole row opens its session, not only the words in it: a
        // point inside the cell but past the end of the title, taken from
        // the title's own frame, so it is the cell being tested and not a
        // guess at where the rows are.
        let other = app.staticTexts["Session 33"]
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        let body = other.frame
        window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: body.maxX + 40, dy: body.midY))
            .tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "a tap in the row's body, off its title, did not open the session")
    }
}
