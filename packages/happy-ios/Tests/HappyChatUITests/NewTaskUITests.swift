import XCTest

/// Home's compose on the grouped home (`-screen groupedHome`, whose
/// computer shows every task asked of it as a row of its own): compose and
/// back leaves no row; what was typed comes back with compose; and the
/// first message, sent with a quick double tap, makes one task, which
/// names the open conversation as it names itself.
@MainActor
final class NewTaskUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    func testComposeMakesATaskOnlyWithItsFirstMessage() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "groupedHome"]
        app.launch()
        defer { app.terminate() }
        func row(_ label: String) -> XCUIElement { app.descendants(matching: .any)["row:space:\(label)"] }
        func rows(_ label: String) -> Int { app.descendants(matching: .any).matching(identifier: "row:space:\(label)").count }
        XCTAssertTrue(row("Fix login crash").waitForExistence(timeout: 20))
        let compose = app.buttons["compose"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5))

        // Compose, type, back: nothing was made.
        compose.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        composer.typeText("Half a thought")
        capture("new-task-typed")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row("Fix login crash").waitForExistence(timeout: 10))
        sleep(2)
        XCTAssertEqual(rows("New Task"), 0, "compose and back made a task")
        XCTAssertEqual(rows("Half a thought"), 0)
        capture("new-task-back")

        // Compose again: the same new task, with what was typed.
        compose.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertEqual(composer.value as? String, "Half a thought", "what was typed didn't come back")
        composer.typeText(" about billing")
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        // A quick double tap.
        send.tap()
        if send.exists { send.tap() }
        let title = "Half a thought about billing"
        let named = app.navigationBars.staticTexts[title]
        XCTAssertTrue(named.waitForExistence(timeout: 10), "the open conversation wasn't named after its task")
        capture("new-task-sent")

        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the task's row didn't show on home")
        sleep(1)
        XCTAssertEqual(rows(title), 1, "the double tap made two tasks")
        XCTAssertEqual(rows("New Task"), 0, "a second task was made")
        capture("new-task-home")
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
