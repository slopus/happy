import XCTest

final class HomeBottomActionsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    func testBottomSearchUsesTheKeyboardAndComposeReturnsHome() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-fullHomeScroll", "-homeActionsOnly"]
        app.launch()
        defer { app.terminate() }
        let field = app.searchFields["search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        let compose = app.buttons["compose"]
        XCTAssertTrue(compose.exists)
        let window = app.windows.firstMatch
        XCTAssertGreaterThan(field.frame.minY, window.frame.midY)
        XCTAssertGreaterThan(compose.frame.minY, window.frame.midY)
        capture("home-bottom-actions")

        field.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        field.typeText("Conversation 12")
        XCTAssertLessThanOrEqual(field.frame.maxY, keyboard.frame.minY + 1)
        XCTAssertGreaterThan(field.frame.minY, app.navigationBars.firstMatch.frame.maxY + 40)
        print("HOME_BOTTOM_ACTIONS search=\(field.frame) keyboard=\(keyboard.frame)")
        capture("home-bottom-search-keyboard")

        let close = app.buttons["close"]
        XCTAssertTrue(close.waitForExistence(timeout: 3))
        close.tap()
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        compose.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.searchFields["search-field"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(compose.exists)
        capture("home-bottom-actions-restored")
    }

    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}