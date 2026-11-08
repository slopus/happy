import XCTest

/// Happy links as desktop reads them, on grouped home's computer
/// (`-screen groupedHome -linkChips`): Landing page copy's reply names an
/// artifact, a task, a bot and a Surface by their live names, an agent this
/// phone doesn't hold as words and another server's task as its address;
/// the person's message names its task as a link too. The artifact's name
/// opens it, and its Markdown document reads its own links the same way.
@MainActor
final class LinkChipsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    func testLinksReadAsWhatTheyName() {
        app.launchArguments = ["-screen", "groupedHome", "-linkChips"]
        app.launch()
        addTeardownBlock { [app] in app.terminate() }
        let landing = row("Landing page copy")
        XCTAssertTrue(landing.waitForExistence(timeout: 20), "no Landing page copy row")
        pause(2)
        landing.tap()

        // The reply: every link by what it names now.
        let reply = message(beginningWith: "Launch brief is ready")
        XCTAssertTrue(reply.waitForExistence(timeout: 15), "no reply")
        for words in ["Fix login crash is bisecting", "Research Assistant has the papers", "Surface: Groceries", "Archived: an unavailable agent", "Theirs: https://link.happy.page/"] {
            XCTAssertTrue(reply.label.contains(words), "\(words) not in \(reply.label)")
        }
        // The person's own words name the task.
        XCTAssertTrue(message(beginningWith: "How is Fix login crash going?").exists, "the person's message")
        pause(1.5)
        keep("chips-01-chat")

        // The artifact's name, the reply's first words, opens it.
        reply.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 30, dy: 12)).tap()
        let document = app.descendants(matching: .any)["artifact-document"]
        XCTAssertTrue(document.waitForExistence(timeout: 15), "the artifact's link opened nothing")
        let named = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@ AND label CONTAINS %@", "Owner: [Fix login crash]", "[Research Assistant]", "[Groceries]")
        expectation(for: named, evaluatedWith: document)
        waitForExpectations(timeout: 10)
        pause(1.5)
        keep("chips-02-document")
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
