import XCTest

/// Share links on grouped home (`-screen groupedHome -shareLinks`), whose
/// computer names its installation: Happy's detail offers "Copy link to
/// bot", which copies its link.happy.page link; a reply's share links to
/// this computer read as their live names and open in the app, and another
/// server's stays an address.
@MainActor
final class ShareLinksUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    func testShareLinksCopyAndOpenInTheApp() {
        app.launchArguments = ["-screen", "groupedHome", "-shareLinks"]
        app.launch()
        addTeardownBlock { [app] in app.terminate() }
        let happy = row("Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 20), "no Happy row")
        pause(2)

        // Happy's detail, which its name opens: its link in the bar.
        happy.tap()
        let title = app.descendants(matching: .any)["chat-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "no Happy conversation")
        title.tap()
        let copy = app.buttons["detail-copy-link"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "no Copy link on Happy's detail")
        XCTAssertEqual(copy.label, "Copy link to bot")
        pause(1)
        keep("share-01-copy-link")
        copy.tap()
        pause(1.5)
        // Back home: the detail, then the conversation.
        app.navigationBars.buttons.firstMatch.tap()
        pause(1)
        app.navigationBars.buttons.firstMatch.tap()
        pause(1.5)

        // The reply's links: Happy's and the task's by their live names.
        let landing = row("Landing page copy")
        XCTAssertTrue(landing.waitForExistence(timeout: 10))
        landing.tap()
        let reply = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "message", "Ask ")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10), "no reply")
        XCTAssertTrue(reply.label.hasPrefix("Ask Happy about the tone, and read Fix login crash first. Theirs: https://link.happy.page/"), reply.label)
        pause(1)
        keep("share-02-links-in-reply")

        // The task's link, "Fix login crash" at the first line's end, opens
        // its conversation.
        reply.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 306, dy: 22)).tap()
        XCTAssertTrue(app.navigationBars["Fix login crash"].waitForExistence(timeout: 5), "the task's link opened nothing")
        pause(1.5)
        keep("share-03-link-opened")
        app.navigationBars.buttons.firstMatch.tap()
        pause(1.5)

        // What was copied, pasted.
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        pause(1)
        composer.tap()
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Paste")).firstMatch
        if !paste.waitForExistence(timeout: 3) { composer.press(forDuration: 1.2) }
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "no Paste")
        paste.tap()
        pause(1)
        let pasted = composer.value as? String ?? ""
        XCTAssertTrue(pasted.hasPrefix("https://link.happy.page/#1/k3x9q2m7p0a4b8c1d5e6f7g2/agents/happy-agent?as=bot"), "copied \(pasted)")
        keep("share-04-copied-link")
    }

    private func row(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "row:", ":\(label)")).firstMatch
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
