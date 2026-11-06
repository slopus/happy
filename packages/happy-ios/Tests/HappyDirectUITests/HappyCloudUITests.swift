import XCTest

/// Happy Cloud end to end on a phone, against the live cloud: Connect to
/// Happy Cloud, confirm, create an account in the browser, create a server
/// in the picker, sign in to it without a page, land on its home, start a
/// task and see its answer. Runs only with
/// `TEST_RUNNER_HAPPY_CLOUD_E2E=1`; `TEST_RUNNER_HAPPY_CLOUD_EMAIL` and
/// `TEST_RUNNER_HAPPY_CLOUD_PASSWORD` name the account it creates.
@MainActor
final class HappyCloudUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    override func setUp() { continueAfterFailure = false }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tree(_ name: String, _ of: XCUIApplication) {
        let attachment = XCTAttachment(string: of.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func require(_ found: Bool, _ message: String) {
        guard !found else { return }
        capture("failed")
        tree("failed-app", app)
        tree("failed-browser", browser)
        XCTFail(message)
    }

    /// The first of `candidates` to show within `timeout`.
    private func first(_ candidates: [XCUIElement], timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let hit = candidates.first(where: \.exists) { return hit }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return nil
    }

    func testConnectSignUpAndTalkToAnAgent() throws {
        try XCTSkipUnless(env["HAPPY_CLOUD_E2E"] == "1")
        let email = env["HAPPY_CLOUD_EMAIL"] ?? "ios-\(Int(Date().timeIntervalSince1970))@example.com"
        let password = env["HAPPY_CLOUD_PASSWORD"] ?? "Happy-cloud-\(Int(Date().timeIntervalSince1970))"
        app.launch()

        let switcher = element("account-switcher")
        let start = element("start-more")
        guard let entry = first([switcher, start], timeout: 30) else { return require(false, "neither home nor Start") }
        capture("1-home")
        entry.tap()
        let cloud = first([app.buttons["Connect to Happy Cloud"], app.buttons["account-cloud"]], timeout: 5)
        require(cloud != nil, "no Connect to Happy Cloud")
        capture("2-menu")
        cloud?.tap()

        let connect = app.alerts.buttons["Connect"]
        require(connect.waitForExistence(timeout: 10), "no confirm")
        capture("3-confirm")
        connect.tap()

        let consent = springboard.alerts.buttons["Continue"]
        require(consent.waitForExistence(timeout: 30), "no sign-in consent")
        consent.tap()
        Thread.sleep(forTimeInterval: 4)
        capture("4-auth-page")
        tree("4-auth-page", browser)

        // The auth server's page: Create account, then the form.
        if let create = first([browser.links["Create an account"], app.links["Create an account"], browser.links["Create account"], app.links["Create account"]], timeout: 20) {
            create.tap()
            Thread.sleep(forTimeInterval: 2)
        }
        capture("5-sign-up")
        tree("5-sign-up", browser)
        let web = browser.textFields.count > 0 ? browser : app
        let fields = web.textFields.allElementsBoundByIndex.filter(\.isHittable)
        let secure = web.secureTextFields.allElementsBoundByIndex.filter(\.isHittable)
        for field in fields {
            let label = (field.label + " " + ((field.placeholderValue) ?? "")).lowercased()
            field.tap()
            field.typeText(label.contains("mail") || label.contains("user") ? email : "iPhone Cloud")
        }
        for field in secure {
            field.tap()
            for own in [browser.buttons["Choose My Own Password"], app.buttons["Choose My Own Password"], springboard.buttons["Choose My Own Password"]] where own.waitForExistence(timeout: 2) { own.tap(); break }
            field.typeText(password)
        }
        capture("6-filled")
        let submit = first([web.buttons["Create account"]], timeout: 5)
        require(submit != nil, "no submit")
        submit?.tap()

        let create = element("cloud-create")
        require(create.waitForExistence(timeout: 30), "no picker after the account's sign-in")
        capture("7-picker")
        create.tap()
        let name = element("cloud-create-name")
        require(name.waitForExistence(timeout: 10), "no name field")
        name.tap()
        name.typeText("ios\(Int(Date().timeIntervalSince1970) % 1_000_000)")
        Thread.sleep(forTimeInterval: 1.5)
        capture("8-name")
        element("cloud-create-save").tap()
        // The server's own sign-in: iOS asks again, then no page.
        let again = springboard.alerts.buttons["Continue"]
        require(again.waitForExistence(timeout: 60), "no server sign-in consent")
        again.tap()

        require(switcher.waitForExistence(timeout: 60), "no home after sign-in")
        Thread.sleep(forTimeInterval: 5)
        capture("9-cloud-home")
        tree("9-cloud-home", app)

        let compose = element("compose")
        require(compose.waitForExistence(timeout: 20), "no compose")
        compose.tap()
        let composer = app.textViews["composer"]
        require(composer.waitForExistence(timeout: 10), "no composer")
        capture("10-new-task")
        composer.tap()
        composer.typeText("Reply with one short sentence: hello from Happy Cloud.")
        app.buttons["Send"].tap()
        Thread.sleep(forTimeInterval: 45)
        capture("11-reply")
        tree("11-reply", app)
        app.terminate()
        app.launch()
        Thread.sleep(forTimeInterval: 10)
        capture("12-relaunch")
    }
}
