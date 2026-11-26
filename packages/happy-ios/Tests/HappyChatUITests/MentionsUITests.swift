import XCTest

/// The agent composer's `@` mentions with a finger (`-screen mentions`: a
/// team's computer whose bootstrap names Steve, signed in, and five
/// teammates). `@` and a few letters open the palette on the people whose
/// names hold them; a tap writes "@Name", and the message goes as the
/// person's link, which the transcript draws as the mention.
@MainActor
final class MentionsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = .portrait
    }

    private func row(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func mention(_ arguments: [String]) -> XCUIElement {
        app = XCUIApplication()
        app.launchArguments = ["-screen", "mentions"] + arguments
        app.launch()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "no composer")
        composer.tap()
        composer.typeText("Ask @")
        XCTAssertTrue(row("Ada Lovelace").waitForExistence(timeout: 5), "the palette never opened")
        XCTAssertTrue(row("Max Müller").exists)
        XCTAssertFalse(row("Steve").exists, "the reader is not offered")

        composer.typeText("an")
        XCTAssertTrue(row("Anna Petrova").waitForExistence(timeout: 3))
        XCTAssertFalse(row("Ada Lovelace").exists, "filtered by the name")
        keep("palette @an")

        row("Anna Petrova").tap()
        XCTAssertEqual(composer.value as? String, "Ask @Anna Petrova ")
        XCTAssertTrue(row("Anna Petrova").waitForNonExistence(timeout: 3), "the palette closes after the pick")
        return composer
    }

    func testATaskChatOnHappyCloudMentionsATeammate() {
        let composer = mention([])
        composer.typeText("about the visuals")
        app.buttons["Send"].firstMatch.tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "@Anna Petrova about the visuals")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "nothing was sent: \(app.debugDescription)")
        keep("sent")
    }

    func testNewWorkOnAHappyAgentDaemonMentionsATeammate() {
        _ = mention(["-server", "agent", "-open", "new"])
    }
}
