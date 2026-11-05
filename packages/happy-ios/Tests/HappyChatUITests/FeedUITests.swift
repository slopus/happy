import XCTest

/// The Feed on a team computer that keeps one (`-screen agentFeed`): home's
/// row and its count, the entries by date, a new one arriving over the
/// stream, opening one, Mark All Read, Following with its switches, and a
/// peek. With `HAPPY_PREVIEW_DIR` set, it writes the screens, named by
/// `HAPPY_STYLE`.
@MainActor
final class FeedUITests: XCTestCase {
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

    private func until(_ what: String, timeout: TimeInterval = 10, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        XCTAssertTrue(condition(), what)
    }

    private func value(_ element: XCUIElement) -> String { element.value as? String ?? "" }

    func testTheFeed() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "agentFeed", "-live"]
        app.launch()

        // Home: the Feed row under Artifacts, with what is unread beside it.
        let row = app.descendants(matching: .any)["row:space:Activity"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), "home has no Activity row")
        until("the Activity row counts 3 unread") { value(row).contains("3") }
        sleep(1)
        keep("feed-home")

        row.tap()
        let list = app.descendants(matching: .any)["feed-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let todo = app.descendants(matching: .any)["item-2"]
        XCTAssertTrue(todo.waitForExistence(timeout: 10), "the entries didn't load")
        XCTAssertTrue(todo.label.contains("Groceries"))
        XCTAssertTrue(value(todo).hasPrefix("Unread"), "an open entry isn't unread: \(value(todo))")
        XCTAssertTrue(value(todo).contains("Oat milk"))
        XCTAssertFalse(value(app.descendants(matching: .any)["item-3"]).hasPrefix("Unread"), "a seen entry is unread")
        sleep(1)
        keep("feed-activity")

        // Bo adds a todo elsewhere: it comes in at the top, unread.
        let arrived = app.descendants(matching: .any)["item-50"]
        XCTAssertTrue(arrived.waitForExistence(timeout: 15), "the new entry didn't arrive")
        until("the new entry is unread") { value(arrived).hasPrefix("Unread") }
        sleep(1)
        keep("feed-live")

        // Opening an entry opens its subject and counts it seen.
        todo.tap()
        sleep(2)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        until("the opened entry is still unread") { !value(todo).hasPrefix("Unread") }

        // Mark All Read: no dot is left, and the button rests.
        let readAll = app.buttons["feed-read-all"]
        XCTAssertTrue(readAll.isEnabled)
        readAll.tap()
        until("an entry is still unread") { !value(arrived).hasPrefix("Unread") && !value(app.descendants(matching: .any)["item-1"]).hasPrefix("Unread") }
        until("Mark All Read is still on") { !readAll.isEnabled }
        sleep(1)
        keep("feed-read")

        // Following: a switch on each place; a muted one is off. The row is
        // one element, its value the switch's.
        app.segmentedControls["feed-tabs"].buttons.element(boundBy: 1).tap()
        let muted = app.descendants(matching: .any)["task:adas"]
        XCTAssertTrue(muted.waitForExistence(timeout: 10), "Following didn't load")
        XCTAssertEqual(value(muted), "Muted")
        XCTAssertEqual(value(app.descendants(matching: .any)["bot:research"]), "Following", "a place followed through everything is off")
        sleep(1)
        keep("feed-following")
        muted.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: muted.frame.width - 58, dy: 0)).tap()
        until("following didn't take") { value(app.descendants(matching: .any)["task:adas"]) == "Following" }

        // A peek at a place's newest entries.
        app.descendants(matching: .any)["bot:research"].tap()
        let peek = app.descendants(matching: .any)["feed-peek-list"]
        XCTAssertTrue(peek.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["artifact:roadmap"].waitForExistence(timeout: 10), "the peek is empty")
        sleep(1)
        keep("feed-peek")
    }
}
