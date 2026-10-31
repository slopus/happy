import XCTest

/// Search on the grouped home (`-screen groupedHome`): focused with nothing
/// typed it shows the conversations last active; the header stays all the
/// while; and closing it, by its button or a pull, brings home back as it was.
@MainActor
final class HomeSearchRecentUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    func testEmptySearchShowsRecentAndTheHeaderStays() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "groupedHome"]
        app.launch()
        defer { app.terminate() }
        let field = app.searchFields["search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        let switcher = app.buttons["account-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 10))
        let header = switcher.frame

        field.tap()
        let results = app.scrollViews["search-results-list"]
        XCTAssertTrue(results.waitForExistence(timeout: 5))
        func row(_ kind: String, _ label: String) -> XCUIElement { results.descendants(matching: .any)["row:\(kind):\(label)"] }
        XCTAssertTrue(row("section", "Recent").waitForExistence(timeout: 5), "an empty search shows nothing")
        // Bots and tasks, newest first; a subtask's work counts for its own.
        let order = ["Fix login crash", "Research Assistant", "Landing page copy", "Happy", "Release Bot"]
        let frames = order.map { label -> CGRect in
            let element = row("space", label)
            XCTAssertTrue(element.exists, "\(label) isn't among the recent")
            return element.frame
        }
        XCTAssertEqual(frames.map(\.minY), frames.map(\.minY).sorted(), "the recent aren't newest first")
        XCTAssertFalse(row("session", "Write the regression test").exists, "a subtask stands alone among the recent")
        XCTAssertTrue(switcher.isHittable, "the header went with search")
        XCTAssertEqual(switcher.frame, header, "the header moved")
        capture("search-recent")

        field.typeText("release")
        XCTAssertTrue(row("space", "Release Bot").waitForExistence(timeout: 5))
        XCTAssertFalse(row("section", "Recent").exists)
        capture("search-typed")

        app.buttons["close"].tap()
        XCTAssertTrue(results.waitForNonExistence(timeout: 5), "closing left the results")
        XCTAssertTrue(switcher.isHittable)
        XCTAssertEqual(switcher.frame, header)
        capture("search-closed")

        // Again, closed by a pull from the top this time.
        field.tap()
        XCTAssertTrue(results.waitForExistence(timeout: 5))
        XCTAssertTrue(row("section", "Recent").waitForExistence(timeout: 5))
        let start = results.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        start.press(forDuration: 0.05, thenDragTo: results.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)), withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(results.waitForNonExistence(timeout: 5), "a full pull didn't close search")
        XCTAssertEqual(switcher.frame, header)
        capture("search-pulled-closed")
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
