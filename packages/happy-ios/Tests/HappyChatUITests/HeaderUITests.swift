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
}
