import XCTest

/// Happy links as desktop reads them, on grouped home's computer
/// (`-screen groupedHome -linkChips`): Landing page copy's reply links a
/// task, a bot at work, an artifact and a task in bold by their live
/// names, an agent this phone doesn't hold and another server's task by
/// the placeholder, and a task by its bare address; the person's message
/// names its task too. Tapping the artifact's name opens it, and its
/// Markdown document keeps the words its links were written with.
@MainActor
final class LinkChipsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    func testLinksReadAsWhatTheyName() {
        app.launchArguments = ["-screen", "groupedHome", "-linkChips", "-shimmerPhase", "0.45"]
        app.launch()
        addTeardownBlock { [app] in app.terminate() }
        let landing = row("Landing page copy")
        XCTAssertTrue(landing.waitForExistence(timeout: 20), "no Landing page copy row")
        pause(2)
        landing.tap()

        // The reply: every link by what it names now (the spoken words keep
        // the Markdown's marks).
        let reply = message(beginningWith: "Here is where things stand")
        XCTAssertTrue(reply.waitForExistence(timeout: 15), "no reply")
        for words in ["Task: Quarterly report has", "Bot: Research Assistant is", "Artifact: Launch brief is", "Bold: **Onboarding emails** go",
                      "Archived: an unavailable agent", "Bare: https://link.happy.page/#1/", "Theirs: an unavailable agent"] {
            XCTAssertTrue(reply.label.contains(words), "\(words) not in \(reply.label)")
        }
        XCTAssertFalse(reply.label.contains("happy-reference"))
        // The person's own words name the task.
        XCTAssertTrue(message(beginningWith: "How is Fix login crash going?").exists, "the person's message")
        pause(1.5)
        keep("links-01-chat")

        // The artifact's name opens it.
        tapLine(3, at: 130, in: reply)
        let document = app.descendants(matching: .any)["artifact-document"]
        XCTAssertTrue(document.waitForExistence(timeout: 15), "the artifact's link opened nothing")
        // The document keeps the words its links were written with; an
        // empty `[]` reads as the name or the placeholder.
        let named = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "[Fix login crash]", "[the researcher]")
        expectation(for: named, evaluatedWith: document)
        waitForExpectations(timeout: 10)
        for words in ["[the list]", "[the old plan]", "[an unavailable agent]", "Their plan: https://link.happy.page/#1/"] {
            XCTAssertTrue(document.label.contains(words), "\(words) not in \(document.label)")
        }
        pause(1.5)
        keep("links-02-document")
    }

    /// Taps the reply's `line`th list item (its first paragraph above; 24
    /// a line, blocks 8 apart), `x` in from its left.
    private func tapLine(_ line: Int, at x: CGFloat, in reply: XCUIElement) {
        reply.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: 24 + 8 + 32 * CGFloat(line - 1) + 12)).tap()
    }

    private func row(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "row:", ":\(label)")).firstMatch
    }

    private func message(beginningWith words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "message", words)).firstMatch
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
