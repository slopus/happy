import XCTest

/// Happy Cloud end to end on a phone, against the live cloud: Connect to
/// Happy Cloud, Sign in with Apple (a person at the phone finishes Apple's
/// sheet), create a server in the picker, connect to it with no browser,
/// land on its home, start a task and see its answer. Runs only with
/// `TEST_RUNNER_HAPPY_CLOUD_E2E=1`.
@MainActor
final class HappyCloudUITests: XCTestCase {
    private let app = XCUIApplication()
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

        let apple = element("cloud-apple")
        require(apple.waitForExistence(timeout: 10), "no welcome")
        capture("3-welcome")
        apple.tap()
        // Apple's sheet needs the person: Face ID or the passcode.
        let create = element("cloud-create")
        require(create.waitForExistence(timeout: 180), "no picker after the account's sign-in")
        capture("7-picker")
        create.tap()
        let name = element("cloud-create-name")
        require(name.waitForExistence(timeout: 10), "no name field")
        name.tap()
        name.typeText("ios\(Int(Date().timeIntervalSince1970) % 1_000_000)")
        Thread.sleep(forTimeInterval: 1.5)
        capture("8-name")
        element("cloud-create-save").tap()
        // The server's token comes from the accounts API: no browser.

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

    /// The whole flow with a test account, no person needed: ten taps on
    /// the logo, its login and password, a new server, its home, a task
    /// and a message (with no provider set up, the answer is the card
    /// asking to connect one), another server, and signing out. Runs only
    /// with `TEST_RUNNER_QA_LOGIN` and `TEST_RUNNER_QA_PASSWORD`; the
    /// password is typed, never written down.
    func testATestAccountRunsTheWholeFlow() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"] else { throw XCTSkip("no test account") }
        app.launch()

        let switcher = element("account-switcher")
        let start = element("start-more")
        guard let entry = first([switcher, start], timeout: 30) else { return require(false, "neither home nor Start") }
        capture("01-before")
        entry.tap()
        let cloud = first([app.buttons["Connect to Happy Cloud"], app.buttons["account-cloud"]], timeout: 5)
        require(cloud != nil, "no Connect to Happy Cloud")
        cloud?.tap()

        let logo = element("cloud-logo")
        require(logo.waitForExistence(timeout: 10), "no welcome")
        capture("02-welcome")
        let form = element("cloud-test-login")
        for _ in 0..<10 where !form.exists { logo.tap() }
        require(form.waitForExistence(timeout: 3), "ten taps on the logo opened nothing")
        capture("03-test-sign-in")
        form.tap()
        form.typeText(login)
        let secret = element("cloud-test-password")
        secret.tap()
        secret.typeText(password)
        capture("04-filled")
        element("cloud-test-submit").tap()

        let create = element("cloud-create")
        require(create.waitForExistence(timeout: 30), "no servers after the test account's sign-in")
        Thread.sleep(forTimeInterval: 2)
        capture("05-servers")
        create.tap()
        let name = element("cloud-create-name")
        require(name.waitForExistence(timeout: 10), "no name field")
        name.tap()
        let server = "qa-ios-\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        name.typeText(server)
        Thread.sleep(forTimeInterval: 1.5)
        capture("06-name")
        element("cloud-create-save").tap()

        require(switcher.waitForExistence(timeout: 90), "no home after creating \(server)")
        Thread.sleep(forTimeInterval: 5)
        capture("07-home")
        tree("07-home", app)

        let compose = element("compose")
        require(compose.waitForExistence(timeout: 20), "no compose")
        compose.tap()
        let composer = app.textViews["composer"]
        require(composer.waitForExistence(timeout: 15), "no composer")
        capture("08-new-task")
        composer.tap()
        composer.typeText("Hello from the iOS test account.")
        app.buttons["Send"].tap()
        Thread.sleep(forTimeInterval: 20)
        capture("09-sent")
        tree("09-sent", app)

        let back = app.navigationBars.buttons.element(boundBy: 0)
        if back.exists { back.tap() }
        require(switcher.waitForExistence(timeout: 10), "no home to switch from")
        switcher.tap()
        Thread.sleep(forTimeInterval: 1)
        capture("10-switcher")
        tree("10-switcher", app)
        let others = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'account-' AND NOT (identifier IN %@)", ["account-add", "account-cloud", "account-cloud-sign-out"]))
        let other = (0..<others.count).map { others.element(boundBy: $0) }.first { !$0.isSelected && $0.label != server && !$0.label.contains(server) }
        if let other {
            other.tap()
            Thread.sleep(forTimeInterval: 4)
            capture("11-switched")
            switcher.tap()
            Thread.sleep(forTimeInterval: 1)
        }
        let signOut = element("account-cloud-sign-out")
        require(signOut.waitForExistence(timeout: 5), "no Sign Out of Happy Cloud while the pass lasts")
        capture("12-sign-out-menu")
        signOut.tap()
        Thread.sleep(forTimeInterval: 1)
        switcher.tap()
        Thread.sleep(forTimeInterval: 1)
        capture("13-signed-out")
        XCTAssertFalse(element("account-cloud-sign-out").exists, "still signed in to Happy Cloud")
    }
}
