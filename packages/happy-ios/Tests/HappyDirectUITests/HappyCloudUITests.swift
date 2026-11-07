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
    /// From home or Start, through Connect to Happy Cloud, the ten taps and
    /// the test account's form, to its servers. The password is pasted,
    /// never typed: XCTest's log keeps whatever is typed.
    private func signInWithTestAccount(login: String, password: String) {
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
        // One quick burst: a phone's taps one by one can outlast the four seconds.
        logo.tap(withNumberOfTaps: 10, numberOfTouches: 1)
        if !form.waitForExistence(timeout: 2) { for _ in 0..<10 where !form.exists { logo.tap() } }
        require(form.waitForExistence(timeout: 3), "ten taps on the logo opened nothing")
        capture("03-test-sign-in")
        form.tap()
        form.typeText(login)
        let secret = element("cloud-test-password")
        // A phone lets only the app in front write the pasteboard: the
        // runner comes forward to write it, and again to empty it.
        onPasteboard(password)
        defer { onPasteboard("") }
        secret.tap()
        Thread.sleep(forTimeInterval: 0.5)
        secret.tap()
        let paste = app.menuItems["Paste"]
        if !paste.waitForExistence(timeout: 2) { secret.press(forDuration: 1.2) }
        require(paste.waitForExistence(timeout: 5), "no Paste in the password's menu")
        paste.tap()
        let allow = first([app.buttons["Allow Paste"], XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]], timeout: 3)
        allow?.tap()
        capture("04-filled")
        // Back in front after the pasteboard, a phone can call the button
        // not hittable for a moment: its place is tapped.
        let submit = element("cloud-test-submit")
        if submit.isHittable {
            submit.tap()
        } else {
            // Return in the password's field signs in as the button does.
            secret.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
            Thread.sleep(forTimeInterval: 0.8)
            app.typeText("\n")
        }
        Thread.sleep(forTimeInterval: 1)
    }

    /// Writes the pasteboard from the runner, brought in front for it, then
    /// puts the app back in front.
    private func onPasteboard(_ text: String) {
        if let id = Bundle.main.bundleIdentifier {
            let runner = XCUIApplication(bundleIdentifier: id)
            runner.activate()
            _ = runner.wait(for: .runningForeground, timeout: 5)
        }
        UIPasteboard.general.string = text
        app.activate()
        _ = app.wait(for: .runningForeground, timeout: 5)
    }

    /// A Happy Cloud server's controls follow the person's role: as
    /// `TEST_RUNNER_ROLE` (`owner` or `viewer`) on `TEST_RUNNER_ROLE_SERVER`,
    /// which holds the vaults Locked (owners only), Shared (read-only for
    /// the rest) and Policy, and the todo list Groceries, each joined. The
    /// owner runs first and starts a task the viewer then opens; each run
    /// signs out of the server at its end. Pictures of every screen.
    func testARolesControlsFollowItsPermissions() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["ROLE_SERVER"], let role = env["ROLE"] else { throw XCTSkip("no role run") }
        let owner = role == "owner"
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let card = element("cloud-server-\(server)")
        require(card.waitForExistence(timeout: 30), "@\(server) isn't among \(login)'s servers")
        capture("05-servers")
        card.tap()
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 6)
        capture("10-\(role)-home")
        tree("10-\(role)-home", app)
        let compose = element("compose")
        XCTAssertEqual(compose.exists, owner, "compose for the \(role)")

        // A conversation: the owner starts it, the viewer only reads it.
        let words = "Roles check from the owner."
        if owner {
            compose.tap()
            let composer = app.textViews["composer"]
            require(composer.waitForExistence(timeout: 15), "no composer")
            composer.tap()
            composer.typeText(words)
            app.buttons["Send"].tap()
            Thread.sleep(forTimeInterval: 8)
        } else {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Roles check'")).firstMatch
            require(row.waitForExistence(timeout: 30), "the owner's task isn't on the viewer's home")
            row.tap()
            require(element("read-only-note").waitForExistence(timeout: 15), "no read-only line in the composer's place")
            XCTAssertFalse(app.textViews["composer"].exists && app.textViews["composer"].isHittable, "the viewer has a composer")
            XCTAssertFalse(app.buttons["compose"].exists, "the viewer's chat offers a new task")
            XCTAssertFalse(app.staticTexts["Retry"].exists, "the viewer's chat offers Retry")
        }
        capture("11-\(role)-task")
        tree("11-\(role)-task", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        require(switcher.waitForExistence(timeout: 10), "no home after the task")

        // Groceries: the viewer gets no add row.
        open("Groceries")
        require(element("todo-list").waitForExistence(timeout: 10), "Groceries didn't open")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(app.descendants(matching: .any)["Add a todo"].exists, owner, "the add row for the \(role)")
        capture("12-\(role)-todos")
        goBack(switcher)

        // Locked: owners only.
        open("Locked")
        if owner {
            require(element("vault").waitForExistence(timeout: 10), "Locked didn't open for the owner")
            XCTAssertTrue(element("vault-add").waitForExistence(timeout: 5), "no + for the owner")
        } else {
            require(element("vault-locked").waitForExistence(timeout: 10), "Locked isn't locked for the viewer")
        }
        capture("13-\(role)-locked")
        goBack(switcher)

        // Shared: everyone reads, only the owner writes.
        open("Shared")
        require(element("vault").waitForExistence(timeout: 10), "Shared didn't open")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(element("vault-add").exists, owner, "+ in Shared for the \(role)")
        capture("14-\(role)-shared")
        goBack(switcher)

        // Policy: the owner opens it, its Global folder fixed; locked for the viewer.
        open("Policy")
        if owner {
            require(element("vault").waitForExistence(timeout: 10), "Policy didn't open for the owner")
            let global = app.buttons["Global"].firstMatch
            require(global.waitForExistence(timeout: 10), "no Global in Policy")
            global.press(forDuration: 1.0)
            Thread.sleep(forTimeInterval: 1)
            capture("15-owner-policy-menu")
            XCTAssertFalse(app.buttons["Rename"].exists || app.menuItems["Rename"].exists, "Global can be renamed")
            XCTAssertFalse(app.buttons["Delete"].exists || app.menuItems["Delete"].exists, "Global can be deleted")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        } else {
            require(element("vault-locked").waitForExistence(timeout: 10), "Policy isn't locked for the viewer")
            capture("15-viewer-policy")
        }
        goBack(switcher)

        // Out of the server, so the other role can connect to it here.
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
        confirm.tap()
        Thread.sleep(forTimeInterval: 2)
        capture("16-\(role)-signed-out")
    }

    /// A home row by its name, scrolled to if it must be.
    private func open(_ name: String) {
        let row = app.buttons["row:space:\(name)"].firstMatch
        for _ in 0..<3 where !row.isHittable { app.swipeUp() }
        require(row.waitForExistence(timeout: 15), "no \(name) on home")
        row.tap()
    }

    private func goBack(_ home: XCUIElement) {
        for _ in 0..<3 where !home.isHittable {
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { back.tap() } else { break }
            Thread.sleep(forTimeInterval: 1)
        }
        require(home.waitForExistence(timeout: 10), "no home")
    }

    private func waitGone(_ element: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, element.exists { Thread.sleep(forTimeInterval: 0.2) }
        return !element.exists
    }

    /// Signs in to the accounts service as the test account, the way the
    /// app does, and deletes its servers with these names.
    private nonisolated static func deleteServers(named names: Set<String>, login: String, password: String) async {
        let accounts = "https://auth.happy.engineering"
        func send(_ method: String, _ path: String, token: String? = nil, body: [String: String]? = nil) async -> (Int, Data) {
            var request = URLRequest(url: URL(string: accounts + path)!)
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try? JSONEncoder().encode(body)
            }
            guard let (data, response) = try? await URLSession.shared.data(for: request) else { return (0, Data()) }
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        }
        struct Pass: Decodable { let access_token: String }
        struct Servers: Decodable { struct Server: Decodable { let id: String; let name: String }; let servers: [Server] }
        let (_, passData) = await send("POST", "/v1/auth/password", body: ["login": login, "password": password])
        guard let token = (try? JSONDecoder().decode(Pass.self, from: passData))?.access_token else { return print("cleanup: no pass") }
        let (_, list) = await send("GET", "/v1/servers", token: token)
        for server in (try? JSONDecoder().decode(Servers.self, from: list))?.servers ?? [] where names.contains(server.name) {
            let (status, _) = await send("DELETE", "/v1/servers/\(server.id)", token: token)
            print("cleanup: deleted @\(server.name): \(status)")
        }
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
    /// and a message (with no provider set up, the answer is a card
    /// saying so), another server, and signing out. Runs only
    /// with `TEST_RUNNER_QA_LOGIN` and `TEST_RUNNER_QA_PASSWORD`; the
    /// password is pasted, never typed or written down.
    func testATestAccountRunsTheWholeFlow() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"] else { throw XCTSkip("no test account") }
        app.launch()
        let switcher = element("account-switcher")
        signInWithTestAccount(login: login, password: password)

        let create = element("cloud-create")
        require(create.waitForExistence(timeout: 30), "no servers after the test account's sign-in")
        Thread.sleep(forTimeInterval: 2)
        capture("05-servers")
        create.tap()
        let name = element("cloud-create-name")
        require(name.waitForExistence(timeout: 10), "no name field")
        name.tap()
        let server = "qa-ios-\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        // Whatever happens, the servers this run made go (owner DELETE; the
        // accounts service keeps them seven days before purging).
        addTeardownBlock { await Self.deleteServers(named: [server, server + "-b"], login: login, password: password) }
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
        // Exactly: its "-b" sibling is "Qa Ios 123456 B".
        let title = "Qa Ios \(number)"
        let first = (0..<accounts.count).map { accounts.element(boundBy: $0) }.first { $0.label.hasPrefix(title + ",") }
        require(first != nil, "@\(server) isn't in the switcher")
        first?.tap()
        Thread.sleep(forTimeInterval: 4)
        capture("13-switched")
        let current = switcher.value as? String ?? ""
        require(current == title, "switching opened \(current), not @\(server)")

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
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'settings:account:' AND (label == %@ OR label BEGINSWITH %@)", title, title + ",")).firstMatch
        require(waitGone(row, 10), "@\(server) is still in settings after signing out")
        capture("17-after-sign-out")
        app.buttons["BackButton"].firstMatch.tap()
        require(switcher.waitForExistence(timeout: 10), "no home after signing out of the server")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertNotEqual(switcher.value as? String, title, "the home is still @\(server)")
        capture("18-home-after")
    }
}
