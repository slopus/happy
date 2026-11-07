import XCTest

/// File links against a throwaway Happy Agent (the perf gym's daemon and
/// fake model, driven by a script that plays the computer's side of
/// pairing): a task's reply links a file in its workspace and one that
/// isn't there. The first opens read-only at its line; the second turns
/// into its words. Runs only when `FILES_CHAT` names the task.
@MainActor
final class FileLinksUITests: XCTestCase {
    private let app = XCUIApplication()
    private var environment: [String: String] { ProcessInfo.processInfo.environment }

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments += ["-v2.direct", "YES"]
    }

    func testAFileLinkOpensTheFileReadOnly() throws {
        guard let chat = environment["FILES_CHAT"] else { throw XCTSkip("no file links run") }
        launch()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "row:", ":\(chat)")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row \(chat)")
        row.tap()
        func button(_ label: String) -> XCUIElement { app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch }
        let notes = button("notes.md")
        XCTAssertTrue(notes.waitForExistence(timeout: 30), "no notes.md button")
        pause(1.5)
        keep("40-file-links")

        notes.tap()
        let viewer = app.descendants(matching: .any).matching(identifier: "workspace-file").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 15), "the file link didn't open the viewer")
        XCTAssertTrue(app.staticTexts["notes.md:60"].waitForExistence(timeout: 5) || app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'notes.md:60'")).firstMatch.exists, "no notes.md:60 header")
        pause(1.5)
        keep("41-file-viewer")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(notes.waitForExistence(timeout: 10), "not back in the task")

        // Not in the workspace: no screen, no alert; its words.
        let gone = button("gone.md")
        XCTAssertTrue(gone.exists, "no gone.md button")
        gone.tap()
        pause(3)
        XCTAssertEqual(app.alerts.count, 0, "the missing file showed an alert")
        XCTAssertFalse(viewer.exists, "the missing file opened the viewer")
        XCTAssertFalse(button("gone.md").exists, "gone.md is still a button")
        keep("42-missing-file-words")
    }

    private func launch() {
        app.launch()
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:")).firstMatch
        if any.waitForExistence(timeout: 10) { return }
        print("HAPPY_PAIR_READY")
        let match = app.buttons["Emoji match"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "pairing never showed its emoji")
        pause(1.5)
        match.tap()
        XCTAssertTrue(any.waitForExistence(timeout: 90))
    }

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}
