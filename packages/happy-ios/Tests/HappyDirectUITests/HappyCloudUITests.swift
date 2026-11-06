import XCTest
import UIKit

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
    private func waitGone(_ element: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, element.exists { Thread.sleep(forTimeInterval: 0.2) }
        return !element.exists
    }

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
    /// password is pasted, never typed or written down.
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
        // Pasted, not typed: XCTest's log keeps whatever is typed.
        let secret = element("cloud-test-password")
        UIPasteboard.general.string = password
        defer { UIPasteboard.general.string = "" }
        secret.tap()
        secret.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        require(paste.waitForExistence(timeout: 5), "no Paste in the password's menu")
        paste.tap()
        let allow = first([app.buttons["Allow Paste"], XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]], timeout: 3)
        allow?.tap()
        UIPasteboard.general.string = ""
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
        require(switcher.waitForExistence(timeout: 10), "no home after the task")

        // A second server: one the account already has, or a new one.
        switcher.tap()
        let more = element("account-cloud")
        require(more.waitForExistence(timeout: 5), "no Connect to Happy Cloud in the switcher")
        more.tap()
        require(element("cloud-servers").waitForExistence(timeout: 15), "the pass didn't open Your Servers")
        Thread.sleep(forTimeInterval: 2)
        capture("10-servers-again")
        let cards = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cloud-server-' AND identifier != %@", "cloud-server-\(server)"))
        let second: String
        if cards.count > 0 {
            let card = cards.element(boundBy: 0)
            second = String(card.identifier.dropFirst("cloud-server-".count))
            card.tap()
        } else {
            second = server + "-b"
            element("cloud-create").tap()
            require(name.waitForExistence(timeout: 10), "no name field")
            name.tap()
            name.typeText(second)
            Thread.sleep(forTimeInterval: 1.5)
            element("cloud-create-save").tap()
        }
        require(switcher.waitForExistence(timeout: 90), "no home of @\(second)")
        Thread.sleep(forTimeInterval: 3)
        capture("11-second-home")

        // Back to the first, from the switcher.
        switcher.tap()
        Thread.sleep(forTimeInterval: 1)
        capture("12-switcher")
        tree("12-switcher", app)
        let accounts = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'account-' AND NOT (identifier IN %@)", ["account-add", "account-cloud", "account-cloud-sign-out"]))
        require(accounts.count >= 2, "the switcher has \(accounts.count) accounts, not both servers")
        // The switcher names a server from its handle: qa-ios-123456 is "Qa Ios 123456".
        let number = String(server.split(separator: "-").last ?? "")
        let first = (0..<accounts.count).map { accounts.element(boundBy: $0) }.first { $0.label.contains(" \(number)") }
        require(first != nil, "@\(server) isn't in the switcher")
        first?.tap()
        Thread.sleep(forTimeInterval: 4)
        capture("13-switched")
        let current = switcher.value as? String ?? ""
        require(current.contains(number), "switching opened \(current), not @\(server)")

        // Sign out of Happy Cloud: the pass goes, the servers stay.
        switcher.tap()
        let signOut = element("account-cloud-sign-out")
        require(signOut.waitForExistence(timeout: 5), "no Sign Out of Happy Cloud while the pass lasts")
        capture("14-sign-out-menu")
        signOut.tap()
        Thread.sleep(forTimeInterval: 1)
        switcher.tap()
        Thread.sleep(forTimeInterval: 1)
        capture("15-signed-out")
        XCTAssertFalse(element("account-cloud-sign-out").exists, "still signed in to Happy Cloud")
        XCTAssertGreaterThanOrEqual(accounts.count, 2, "signing out of Happy Cloud took a server away")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.6)).tap()

        // And out of this server, from its settings.
        let gear = app.buttons["settings"].firstMatch
        require(gear.waitForExistence(timeout: 5), "no settings on the home")
        gear.tap()
        Thread.sleep(forTimeInterval: 1.5)
        let rowOut = element("settings:disconnect")
        for _ in 0..<4 where !rowOut.isHittable { app.swipeUp() }
        require(rowOut.waitForExistence(timeout: 5), "no Sign Out on the server's settings")
        rowOut.tap()
        let confirm = app.alerts.buttons["Sign Out"]
        require(confirm.waitForExistence(timeout: 5), "no confirmation")
        capture("16-sign-out-server")
        confirm.tap()
        // Settings stays, on the next account; this server's row is gone.
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'settings:account:' AND label BEGINSWITH %@", "Qa Ios \(number)")).firstMatch
        require(waitGone(row, 10), "@\(server) is still in settings after signing out")
        capture("17-after-sign-out")
        app.buttons["BackButton"].firstMatch.tap()
        require(switcher.waitForExistence(timeout: 10), "no home after signing out of the server")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse((switcher.value as? String ?? "").contains(number), "the home is still @\(server)")
        capture("18-home-after")
    }
}
