import XCTest

/// The two kinds of account as the person reads them, Happy Agent and Happy
/// CLI, with one account of each kind (an agent connection, an account made
/// for a computer and a legacy one): the switcher's menu, the scanner's other
/// ways in, and Settings for each. With `HAPPY_PREVIEW_DIR` set, it writes
/// the screens, named by `HAPPY_STYLE`.
@MainActor
final class AccountKindNamingUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    private var style: String { ProcessInfo.processInfo.environment["HAPPY_STYLE"] ?? "light" }

    private func keep(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(style).png"))
        }
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-sessionCount", "6", "-accountMix"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["account-switcher"].waitForExistence(timeout: 20))
        return app
    }

    /// Nothing on screen says "legacy", nor "Legacy Account".
    private func assertNoLegacy(_ app: XCUIApplication, _ where: String) {
        let legacy = NSPredicate(format: "label CONTAINS[c] 'legacy'")
        XCTAssertEqual(app.descendants(matching: .any).matching(legacy).count, 0, "\(`where`) says legacy")
    }

    func testTheSwitcherAndAddingNameBothKinds() {
        let app = launch()
        app.buttons["account-switcher"].tap()
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
        // The rows look alike; VoiceOver hears each one's kind.
        XCTAssertTrue(app.buttons["Studio Mac, Happy Agent"].exists, "the agent connection's kind isn't spoken")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label ENDSWITH ', Happy CLI' OR label == 'Happy CLI'")).count, 2, "the two Happy CLI accounts")
        assertNoLegacy(app, "the switcher")
        sleep(1)
        keep("kinds-switcher")

        // Add: the scanner, whose ⋯ names what only Happy CLI has.
        app.buttons["Add"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let more = app.buttons["scanner-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 8), "the scanner has no ⋯")
        for button in ["Allow", "OK"] where springboard.alerts.buttons[button].exists {
            springboard.alerts.buttons[button].tap()
        }
        sleep(1)
        keep("kinds-scanner")
        more.tap()
        XCTAssertTrue(app.buttons["Restore Happy CLI account"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Happy CLI server"].exists)
        XCTAssertTrue(app.buttons["Enter link manually"].exists)
        assertNoLegacy(app, "the scanner's ⋯")
        sleep(1)
        keep("kinds-scanner-menu")
    }

    func testSettingsNamesEachKind() {
        let app = launch()
        app.buttons["settings"].tap()
        XCTAssertTrue(app.otherElements["settings"].waitForExistence(timeout: 10))
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'settings:account:'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(rows.count, 3, "one row for each account")
        // The page opens on the active Happy CLI account.
        let cli = NSPredicate(format: "label BEGINSWITH 'Happy CLI'")
        XCTAssertTrue(app.staticTexts.matching(cli).firstMatch.waitForExistence(timeout: 5), "the heading doesn't say Happy CLI")
        assertNoLegacy(app, "a Happy CLI account's settings")
        sleep(1)
        keep("kinds-settings-cli")
        // Agent connections come first: the agent's page says Happy Agent.
        rows.element(boundBy: 0).tap()
        let agent = NSPredicate(format: "label BEGINSWITH 'Happy Agent · '")
        XCTAssertTrue(app.staticTexts.matching(agent).firstMatch.waitForExistence(timeout: 10), "the heading doesn't say Happy Agent")
        assertNoLegacy(app, "the agent's settings")
        sleep(1)
        keep("kinds-settings-agent")
        // The account made for a computer is Happy CLI too.
        rows.element(boundBy: 1).tap()
        XCTAssertTrue(app.staticTexts.matching(cli).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(agent).firstMatch.exists)
        sleep(1)
        keep("kinds-settings-made")
    }

    /// One with a name of its own says its kind under it, with its login.
    func testANamedHappyCLIAccountSaysItsKindUnderItsName() {
        let app = launch(["-namedProfile"])
        app.buttons["settings"].tap()
        XCTAssertTrue(app.otherElements["settings"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Happy CLI · @steve"].waitForExistence(timeout: 10), "the heading doesn't say Happy CLI · @steve")
        XCTAssertTrue(app.staticTexts["settings-name"].exists)
        assertNoLegacy(app, "a named Happy CLI account's settings")
        sleep(1)
        keep("kinds-settings-cli-named")
    }
}
