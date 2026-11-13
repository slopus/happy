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

    /// The screen, kept in the result as `name`, and with `GENUI_SHOTS`
    /// (`TEST_RUNNER_GENUI_SHOTS`) there as `name`.png.
    private func shoot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let folder = ProcessInfo.processInfo.environment["GENUI_SHOTS"] else { return }
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
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

    /// A store that never heard the server serves secret actions draws
    /// them disabled; the artifact's page reads health as it shows and
    /// enables them.
    func testTheArtifactPageReadsWhatTheServerRunsAgain() {
        app.terminate()
        app.launchArguments += ["-genuiUntold"]
        app.launch()
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Open", "actions")).firstMatch
        reach(card)
        // Untold, the conversation's secret button takes no tap.
        let add = button("Add Stripe keys")
        reach(add)
        add.tap()
        sleep(1)
        XCTAssertFalse(app.navigationBars["New Secret"].exists, "enabled before health was read")
        reach(card)
        card.tap()
        XCTAssertTrue(app.otherElements["artifact"].waitForExistence(timeout: 10), "no artifact page")
        let pageAdd = button("Add Stripe keys")
        XCTAssertTrue(pageAdd.waitForExistence(timeout: 20), "the page never drew its Gen UI")
        sleep(2)
        shoot("page-served")
        pageAdd.tap()
        XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10), "the page never enabled its secret action")
        app.buttons["genui-secret-cancel"].tap()
    }

    /// Happy Cloud's manifest leaves the render document out of a version's
    /// files and serves it all the same (`-genuiUnlisted`, at a second
    /// version): the card and the page it opens draw it, never the entry's
    /// JSON as a page.
    func testARenderDocumentTheFilesDontListDrawsOnTheCardAndItsPage() {
        app.terminate()
        app.launchArguments += ["-genuiUnlisted"]
        app.launch()
        let add = button("Add Stripe keys")
        reach(add)
        shoot("unlisted-card")
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Open", "actions")).firstMatch
        reach(card)
        card.tap()
        let page = app.otherElements["artifact"]
        XCTAssertTrue(page.waitForExistence(timeout: 10), "no artifact page")
        let pageAdd = page.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Add Stripe keys")).firstMatch
        XCTAssertTrue(pageAdd.waitForExistence(timeout: 20), "the page never drew its Gen UI")
        XCTAssertEqual(app.webViews.count, 0, "the entry opened as a page")
        sleep(1)
        shoot("unlisted-page")
    }

    /// For the eye: a secret card at the largest text size, where its
    /// variable names are wider than their column and break at `_`.
    func testVariableNamesBreakAtUnderscoresWhenNarrow() {
        app.terminate()
        app.launchArguments = ["-screen", "genuiChat", "-genuiCount", "1", "-genuiExamples", "13-secret",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let name = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "STRIPE_WEBHOOK_SECRET")).firstMatch
        reach(name)
        shoot("underscore-breaks")
    }

    /// For the eye: a secret button before and after its form saved, light
    /// and dark: the same label and colours, its lock turned to a check.
    func testASavedSecretButtonShowsACheck() {
        for mode in ["light", "dark"] {
            app.terminate()
            app.launchArguments = ["-screen", "genuiChat", "-genuiCount", "1", "-genuiExamples", "13-secret"] + (mode == "dark" ? ["-chatDark"] : [])
            app.launch()
            let add = button("Add Stripe keys")
            reach(add)
            shoot("secret-unsaved-\(mode)")
            add.tap()
            XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10), "no secret form")
            let first = app.secureTextFields["genui-secret-value-0"]
            XCTAssertTrue(first.waitForExistence(timeout: 5))
            first.tap()
            // Return goes on to the next value.
            // Return goes on: past the next variable's name to its value.
            first.typeText("sk_test_123\n")
            app.typeText("\n")
            app.typeText("whsec_123")
            shoot("secret-filled-\(mode)")
            app.buttons["genui-secret-save"].tap()
            XCTAssertTrue(app.navigationBars["Secret Added"].waitForExistence(timeout: 10), "not saved")
            app.buttons["genui-secret-done"].tap()
            XCTAssertTrue(add.waitForExistence(timeout: 5))
            XCTAssertEqual(add.label, "Add Stripe keys")
            sleep(1)
            shoot("secret-saved-\(mode)")
        }
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
        XCTAssertEqual(value.placeholderValue, "Value")
        shoot("secret-form-empty")
        value.tap()
        value.typeText("sk_test_123")
        shoot("secret-form")
        app.buttons["genui-secret-save"].tap()
        XCTAssertTrue(app.navigationBars["Secret Added"].waitForExistence(timeout: 10), "not saved")
        XCTAssertTrue(app.staticTexts["Added stripe"].exists)
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
        XCTAssertTrue(app.navigationBars["Secret Updated"].waitForExistence(timeout: 10), "not changed")
        app.buttons["genui-secret-done"].tap()
    }
}

