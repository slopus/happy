import XCTest

/// A Gen UI's buttons in a conversation, tapped as a finger taps them
/// (`-screen genuiChat` with the action conformance document, made by the
/// conversation's own agent on a computer that reports plugins and secret
/// actions): a `message` goes as the person's next message, a `plugin`
/// opens the plugin's page, and what can't run here takes no tap.
@MainActor
final class GenUIActionsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
        app = XCUIApplication()
        app.launchArguments = ["-screen", "genuiChat", "-genuiCount", "1", "-genuiExamples", "actions"]
        app.launch()
    }

    /// With `GENUI_SHOTS` (`TEST_RUNNER_GENUI_SHOTS`), the screen is kept there as `name`.png.
    private func shoot(_ name: String) {
        guard let folder = ProcessInfo.processInfo.environment["GENUI_SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }

    private func button(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Scrolled to, as the transcript opens at its end.
    private func reach(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 20), "\(element) never drawn")
        for _ in 0..<6 where !element.isHittable { app.swipeDown() }
        XCTAssertTrue(element.isHittable)
        // The transcript settles before a press, as a finger waits for it.
        sleep(2)
    }

    func testAMessageGoesAsThePersonsNextMessage() {
        let ask = button("Ask for a summary")
        reach(ask)
        shoot("actions")
        ask.tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Summarise the failures")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 10), "the message never showed in the transcript")
        sleep(1)
        shoot("message-sent")
    }

    func testAPluginOpensItsPage() {
        let plugin = button("Get the Linear plugin")
        reach(plugin)
        plugin.tap()
        XCTAssertTrue(app.navigationBars["Plugins"].waitForExistence(timeout: 10), "no plugin page")
        sleep(1)
        shoot("plugin-page")
    }

    func testWhatCannotRunTakesNoTap() {
        // A cluster's secret on a Happy Agent computer.
        let add = button("Add Stripe key")
        reach(add)
        add.tap()
        sleep(1)
        XCTAssertFalse(app.navigationBars["Plugins"].exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Summarise")).count, 0)
        XCTAssertTrue(add.isHittable, "still on the conversation")
    }

    /// The secret form: prefilled, a value typed, saved, said so; tapped
    /// again it opens on the secret it made, to change it.
    func testASecretIsAddedThenChanged() {
        let add = button("Add Stripe keys")
        reach(add)
        add.tap()
        XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10), "no secret form")
        let name = app.textFields["genui-secret-name"]
        XCTAssertEqual(name.value as? String, "stripe")
        XCTAssertEqual(app.textFields["genui-secret-variable-0"].value as? String, "STRIPE_SECRET_KEY")
        let value = app.secureTextFields["genui-secret-value-0"]
        XCTAssertTrue(value.waitForExistence(timeout: 5))
        value.tap()
        value.typeText("sk_test_123")
        shoot("secret-form")
        app.buttons["genui-secret-save"].tap()
        XCTAssertTrue(app.staticTexts["Added stripe"].waitForExistence(timeout: 10), "not saved")
        shoot("secret-added")
        app.buttons["genui-secret-done"].tap()
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        sleep(1)
        shoot("secret-marked")

        add.tap()
        XCTAssertTrue(app.navigationBars["Change Secret"].waitForExistence(timeout: 10), "not opened on the saved secret")
        XCTAssertEqual(app.secureTextFields["genui-secret-value-0"].placeholderValue, "Keep the stored value")
        shoot("secret-change")
        app.buttons["genui-secret-save"].tap()
        XCTAssertTrue(app.staticTexts["Updated stripe"].waitForExistence(timeout: 10), "not changed")
        app.buttons["genui-secret-done"].tap()
    }
}

