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
            let row = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'roles check'")).firstMatch
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

    /// "Edit name" on the server's picture renames the server
    /// (`TEST_RUNNER_RENAME_SERVER`), then puts its name back; a viewer
    /// (`TEST_RUNNER_ROLE` `viewer`) isn't offered it.
    /// AI providers on a live server (`PROVIDERS_SERVER`): the list, the
    /// chooser offering what the server runs, and a refused key answered
    /// with the server's words. The key is a made-up one.
    func testGProvidersAreListedAndARefusedKeySaysWhy() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["PROVIDERS_SERVER"] else { throw XCTSkip("no providers run") }
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let card = element("cloud-server-\(server)")
        require(card.waitForExistence(timeout: 30), "@\(server) isn't among \(login)'s servers")
        card.tap()
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 120), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 4)
        let gear = app.buttons["settings"].firstMatch
        require(gear.waitForExistence(timeout: 5), "no settings on the home")
        gear.tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'AI providers'")).firstMatch
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        require(row.waitForExistence(timeout: 10), "no AI providers in Settings")
        capture("40-settings")
        row.tap()
        let free = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Happy (free)'")).firstMatch
        require(free.waitForExistence(timeout: 20), "no Happy (free) connection")
        Thread.sleep(forTimeInterval: 1)
        capture("41-providers")
        app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Add a provider'")).firstMatch.tap()
        let key = app.buttons["Add API key · OpenAI"]
        require(key.waitForExistence(timeout: 10), "no chooser")
        Thread.sleep(forTimeInterval: 1)
        capture("42-chooser")
        key.tap()
        let mine = app.buttons["My account"]
        if mine.waitForExistence(timeout: 5) {
            capture("43-save-to")
            mine.tap()
        }
        let field = app.secureTextFields["provider-secret"]
        require(field.waitForExistence(timeout: 10), "no key field")
        field.tap()
        field.typeText("sk-not-a-real-key")
        capture("44-key")
        app.alerts.buttons["Connect"].tap()
        let refused = app.alerts["Couldn’t add the key"]
        require(refused.waitForExistence(timeout: 40), "no refusal")
        Thread.sleep(forTimeInterval: 1)
        capture("45-refused")
        refused.buttons["Cancel"].tap()
    }

    func testEServerIsRenamedFromItsSettings() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["RENAME_SERVER"] else { throw XCTSkip("no rename run") }
        let owner = env["ROLE"] != "viewer"
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let card = element("cloud-server-\(server)")
        require(card.waitForExistence(timeout: 30), "@\(server) isn't among \(login)'s servers")
        card.tap()
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 4)
        let gear = app.buttons["settings"].firstMatch
        require(gear.waitForExistence(timeout: 5), "no settings on the home")
        gear.tap()
        let picture = element("settings-agent-menu")
        let editName = app.buttons["Edit name"].firstMatch
        let avatar = app.buttons["Change avatar"].firstMatch
        if picture.waitForExistence(timeout: 10) {
            picture.tap()
            require(avatar.waitForExistence(timeout: 5), "no menu")
            if !owner { XCTAssertFalse(editName.exists, "the viewer is offered Edit name") }
        } else {
            // A viewer may have no menu on the picture at all.
            require(!owner && element("settings-avatar").exists, "no menu on the server's picture")
        }
        capture("20-\(owner ? "owner" : "viewer")-menu")
        // Renamed, then given its own name back: shown as Settings shows it.
        var shown = ""
        for to in owner ? ["Probe Links Renamed", server] : [] {
            if !editName.exists {
                picture.tap()
                require(editName.waitForExistence(timeout: 5), "no Edit name")
            }
            editName.tap()
            let alert = app.alerts["Server Name"]
            require(alert.waitForExistence(timeout: 5), "Edit name didn't ask for the server's name")
            let field = alert.textFields.firstMatch
            let from = field.value as? String ?? ""
            XCTAssertTrue(app.staticTexts[from].exists, "the prompt holds \(from), not the name Settings shows")
            if shown.isEmpty { shown = from }
            field.tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: from.count + 2) + to)
            Thread.sleep(forTimeInterval: 1)
            capture("21-rename-to-\(to == server ? "back" : "new")")
            alert.buttons["Save"].tap()
            require(waitGone(alert, 5), "Save didn't close the prompt")
            XCTAssertFalse(app.alerts["Could not rename the server"].waitForExistence(timeout: 4), "the server refused the name")
            let expected = to == server ? shown : to
            require(app.staticTexts[expected].waitForExistence(timeout: 20), "Settings doesn't show \(expected)")
            capture("22-renamed-\(to == server ? "back" : "new")")
        }
        if app.buttons["Change avatar"].exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap() }

        // Out of the server, so the other role can connect to it here.
        let rowOut = element("settings:disconnect")
        for _ in 0..<4 where !rowOut.isHittable { app.swipeUp() }
        require(rowOut.waitForExistence(timeout: 5), "no Sign Out on the server's settings")
        rowOut.tap()
        let confirm = app.alerts.buttons["Sign Out"]
        require(confirm.waitForExistence(timeout: 5), "no confirmation")
        confirm.tap()
        Thread.sleep(forTimeInterval: 2)
    }

    /// The settings links and buttons an agent wrote on a cloud server
    /// (`.context/links-task.py` makes the task): each opens where
    /// `SettingsLinkPlace` says, the web fallback in Safari.
    func testBSettingsLinksOpenWhereTheySay() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LINKS_SERVER"] else { throw XCTSkip("no links run") }
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let card = element("cloud-server-\(server)")
        require(card.waitForExistence(timeout: 30), "@\(server) isn't among \(login)'s servers")
        card.tap()
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 4)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Settings links check'")).firstMatch
        for _ in 0..<3 where !row.isHittable { app.swipeUp() }
        require(row.waitForExistence(timeout: 30), "no Settings links check on home")
        row.tap()
        func button(_ label: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch }
        let general = button("General settings")
        require(general.waitForExistence(timeout: 20), "no General settings button")
        Thread.sleep(forTimeInterval: 2)
        capture("20-links-task")
        tree("20-links-task", app)
        let chat = app.navigationBars.buttons.element(boundBy: 0)

        general.tap()
        let settingsRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'settings:'")).firstMatch
        require(settingsRow.waitForExistence(timeout: 10), "General settings didn't open Settings")
        capture("21-general")
        chat.tap()
        require(general.waitForExistence(timeout: 10), "not back in the task")

        button("Your servers").tap()
        let close = element("cloud-close")
        require(close.waitForExistence(timeout: 10), "Your servers didn't open Happy Cloud")
        Thread.sleep(forTimeInterval: 1.5)
        capture("22-servers")
        close.tap()
        require(general.waitForExistence(timeout: 10), "not back in the task after Happy Cloud")

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        button("Usage on the web").tap()
        require(safari.wait(for: .runningForeground, timeout: 15), "Usage on the web didn't open Safari")
        Thread.sleep(forTimeInterval: 4)
        capture("23-usage-web")
        tree("23-usage-web", safari)
        app.activate()
        require(general.waitForExistence(timeout: 15), "not back in the task after Safari")

        // The inline link, the line under the last button: its word.
        let usage = button("Usage on the web")
        usage.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 1)).withOffset(CGVector(dx: 30, dy: 22)).tap()
        require(safari.wait(for: .runningForeground, timeout: 15), "the Providers link didn't open Safari")
        Thread.sleep(forTimeInterval: 4)
        capture("24-providers-web")
        tree("24-providers-web", safari)
        app.activate()
        require(general.waitForExistence(timeout: 15), "not back in the task after Safari")
        goBack(switcher)

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
    }

    /// A task's reply with a Happy link of every kind (`.context/entity-links.py`):
    /// a task, an artifact and a Surface open their screens under their live
    /// names; a file link this server can't open yet (501) turns into its
    /// words; the rest read as words.
    func testDEntityLinksOpenWhereTheAppHasAScreen() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["ENTITY_SERVER"] else { throw XCTSkip("no entity links run") }
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let card = element("cloud-server-\(server)")
        require(card.waitForExistence(timeout: 30), "@\(server) isn't among \(login)'s servers")
        card.tap()
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 4)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Entity links check'")).firstMatch
        for _ in 0..<3 where !row.isHittable { app.swipeUp() }
        require(row.waitForExistence(timeout: 30), "no Entity links check on home")
        row.tap()
        func button(_ label: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch }
        // The live names, not the written labels.
        let task = button("Link target")
        require(task.waitForExistence(timeout: 20), "the agent button isn't named Link target")
        let report = button("Q3 summary")
        require(report.waitForExistence(timeout: 20), "the artifact button isn't named Q3 summary")
        let list = button("Groceries")
        require(list.waitForExistence(timeout: 10), "the Surface button isn't named Groceries")
        Thread.sleep(forTimeInterval: 2)
        capture("30-entity-links")
        tree("30-entity-links", app)
        let back = app.navigationBars.buttons.element(boundBy: 0)

        task.tap()
        require(app.navigationBars.staticTexts["Link target"].waitForExistence(timeout: 10) || button("Link target").waitForExistence(timeout: 1), "the agent link didn't open its conversation")
        Thread.sleep(forTimeInterval: 1.5)
        capture("31-agent")
        back.tap()
        require(report.waitForExistence(timeout: 10), "not back in the task")

        report.tap()
        let markdown = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Revenue is up'")).firstMatch
        require(markdown.waitForExistence(timeout: 20), "the artifact link didn't open the artifact")
        capture("32-artifact")
        back.tap()
        require(list.waitForExistence(timeout: 10), "not back in the task after the artifact")

        list.tap()
        require(button("Milk").waitForExistence(timeout: 15), "the Surface link didn't open Groceries")
        capture("33-surface")
        back.tap()
        require(list.waitForExistence(timeout: 10), "not back in the task after the Surface")

        // No workspace files on this server yet: the button becomes its words, with no alert.
        let file = app.buttons.matching(NSPredicate(format: "label == 'notes.md'")).firstMatch
        require(file.waitForExistence(timeout: 5), "no notes.md button")
        file.tap()
        Thread.sleep(forTimeInterval: 4)
        require(app.alerts.count == 0, "the file link showed an alert")
        require(!app.buttons.matching(NSPredicate(format: "label == 'notes.md'")).firstMatch.exists, "the file button is still a button")
        capture("34-file-words")
        tree("34-file-words", app)
        goBack(switcher)

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
    }

    /// A fresh cloud server's Chief of Staff: its greeting is on home as an
    /// ordinary bot conversation, nothing opens it on its own, and its
    /// providers button opens the server's web settings. A viewer reads it
    /// and can't write to it.
    func testCChiefOfStaffGreetsAndOffersProviders() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["COS_SERVER"] else { throw XCTSkip("no Chief of Staff run") }
        let owner = env["ROLE"] != "viewer"
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let card = element("cloud-server-\(server)")
        require(card.waitForExistence(timeout: 30), "@\(server) isn't among \(login)'s servers")
        card.tap()
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 5)
        // Home, not the conversation: nothing navigates to it on its own.
        XCTAssertFalse(app.navigationBars.buttons.element(boundBy: 0).exists && !switcher.isHittable, "the app left home on its own")
        capture("30-cos-home")
        tree("30-cos-home", app)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Chief of Staff'")).firstMatch
        for _ in 0..<3 where !row.isHittable { app.swipeUp() }
        require(row.waitForExistence(timeout: 30), "no Chief of Staff on home")
        row.tap()
        let greeting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'What would you like to call me'")).firstMatch
        require(greeting.waitForExistence(timeout: 20), "no greeting in the Chief of Staff's conversation")
        let providers = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Add provider credentials'")).firstMatch
        require(providers.waitForExistence(timeout: 10), "no providers button")
        Thread.sleep(forTimeInterval: 1.5)
        capture("31-\(owner ? "owner" : "viewer")-cos")
        tree("31-cos", app)
        if owner {
            XCTAssertTrue(app.textViews["composer"].exists, "the owner can't write to the Chief of Staff")
        } else {
            require(element("read-only-note").waitForExistence(timeout: 10), "the viewer can write to the Chief of Staff")
        }
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        providers.tap()
        require(safari.wait(for: .runningForeground, timeout: 15), "the providers button didn't open Safari")
        Thread.sleep(forTimeInterval: 4)
        capture("32-providers-web")
        tree("32-providers-web", safari)
        app.activate()
        require(providers.waitForExistence(timeout: 15), "not back in the Chief of Staff after Safari")
        goBack(switcher)

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
