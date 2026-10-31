import XCTest

@MainActor
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
        XCTAssertGreaterThan(field.frame.minY, window.frame.midY)
        XCTAssertTrue(app.buttons["account-switcher"].isHittable, "the header stays while search is open")
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

    func testLastRowClearsSearchAndTheAccountMenuUsesOneLine() {
        let app = XCUIApplication()
        app.launchArguments = ["-fullHomeScroll", "-homeActionsOnly"]
        app.launch()
        defer { app.terminate() }
        let field = app.searchFields["search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        let selector = app.buttons["account-switcher"]
        XCTAssertTrue(selector.exists)
        selector.tap()
        let choice = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Personal MacBook Pro")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(choice.frame.height, 52, "the native account menu row must stay on one line")
        capture("home-account-single-line")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).tap()

        let last = app.buttons["Conversation 119"]
        for _ in 0..<24 {
            if last.exists, last.frame.maxY <= field.frame.minY - 8 { break }
            app.swipeUp(velocity: .fast)
        }
        XCTAssertTrue(last.exists)
        XCTAssertLessThanOrEqual(last.frame.maxY, field.frame.minY - 8, "the entire last row must clear the floating search bar")
        capture("home-last-row-clearance")
    }

    func testSearchCoversHomeAndSupportsCancelledAndCompletedPulls() {
        let app = XCUIApplication()
        app.launchArguments = ["-fullHomeScroll", "-homeActionsOnly"]
        app.launch()
        defer { app.terminate() }
        let field = app.searchFields["search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        let first = app.buttons["Conversation 0"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        let original = first.frame
        field.tap()
        let layer = app.scrollViews["search-results-list"]
        XCTAssertTrue(layer.waitForExistence(timeout: 5))
        XCTAssertFalse(first.isHittable, "empty search must cover the home list")
        XCTAssertTrue(app.buttons["account-switcher"].isHittable, "the header stays while search is open")
        capture("home-search-empty-overlay")

        let start = layer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        start.press(forDuration: 0.05, thenDragTo: layer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30)), withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(layer.exists, "a short pull should return search to its open position")
        capture("home-search-pull-cancelled")
        start.press(forDuration: 0.05, thenDragTo: layer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.58)), withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(app.buttons["account-switcher"].waitForExistence(timeout: 5))
        XCTAssertTrue(layer.waitForNonExistence(timeout: 5), "a complete pull should dismiss search")
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in first.exists && first.frame == original }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 5), .completed)
        XCTAssertTrue(first.isHittable)
        XCTAssertEqual(first.frame, original, "dismissal must restore the original list position")
        capture("home-search-pull-dismissed")
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