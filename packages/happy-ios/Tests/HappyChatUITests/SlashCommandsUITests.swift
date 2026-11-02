import XCTest

/// The Happy Agent composer's slash commands with a finger (`-screen
/// agentChat -slash`: an offline computer whose agent offers five commands,
/// one with a picture). `/` and a word open the palette on the commands that
/// start with it; a pick that takes arguments waits for them, and a typed
/// command runs on Return. The computer is away, so running one says so in
/// the app's words and gives the command back.
@MainActor
final class SlashCommandsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = .portrait
    }

    private func row(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "/\(name),")).firstMatch
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testTheComposerOffersTheAgentsCommandsAndRunsThem() {
        app = XCUIApplication()
        app.launchArguments = ["-screen", "agentChat", "-slash", "-chatLight"]
        app.launch()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "no composer")
        composer.tap()
        composer.typeText("/co")
        XCTAssertTrue(row("code-review").waitForExistence(timeout: 5), "the palette never opened")
        XCTAssertTrue(row("compact").exists)
        XCTAssertTrue(row("commit").exists)
        XCTAssertTrue(row("context").exists)
        XCTAssertFalse(row("deploy").exists, "filtered by the start of the name")
        keep("palette /co")

        row("code-review").tap()
        XCTAssertEqual(composer.value as? String, "/code-review ", "a skill waits for its arguments")
        XCTAssertTrue(row("code-review").waitForNonExistence(timeout: 3), "the palette closes once arguments follow")

        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "Users/steve")
        XCTAssertEqual(composer.value as? String, "/Users/steve")
        XCTAssertFalse(row("compact").exists, "a path is text")

        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 11) + "compa")
        XCTAssertTrue(row("compact").waitForExistence(timeout: 3))
        XCTAssertFalse(row("commit").exists)
        composer.typeText("\n")
        let refusal = app.alerts.firstMatch
        XCTAssertTrue(refusal.waitForExistence(timeout: 15), "Return ran nothing")
        XCTAssertTrue(refusal.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Couldn’t reach Happy Agent to run /compact")).firstMatch.exists,
                      "\(refusal.debugDescription)")
        keep("unreachable")
        refusal.buttons.firstMatch.tap()
        XCTAssertEqual(composer.value as? String, "/compact", "the command is given back")
    }
}
