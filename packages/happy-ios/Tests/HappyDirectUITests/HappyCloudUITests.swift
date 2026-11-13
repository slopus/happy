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

    /// Happy Cloud's first screen: Start's own Use Happy Cloud, or home's
    /// switcher and its Connect to Happy Cloud.
    private func openCloud(capturing name: String) {
        let switcher = element("account-switcher")
        let start = app.buttons["start-cloud"]
        guard let entry = first([switcher, start], timeout: 30) else { return require(false, "neither home nor Start") }
        capture(name)
        entry.tap()
        guard entry === switcher else { return }
        let cloud = first([app.buttons["account-cloud"]], timeout: 5)
        require(cloud != nil, "no Connect to Happy Cloud")
        cloud?.tap()
    }

    /// Joins `server` from Join a server's list, then Continue opens it.
    private func open(server: String, login: String) {
        let join = element("cloud-server-\(server)")
        let next = element("cloud-servers-continue")
        require(join.waitForExistence(timeout: 30) || next.exists, "@\(server) isn't among \(login)'s servers")
        capture("05-servers")
        if join.exists { join.tap() }
        require(next.waitForExistence(timeout: 90), "@\(server) never joined")
        next.tap()
    }

    /// From home or Start, through Connect to Happy Cloud (Start's own Use
    /// Happy Cloud), the ten taps and the test account's form, to its
    /// servers. The password is pasted, never typed: XCTest's log keeps
    /// whatever is typed.
    private func signInWithTestAccount(login: String, password: String, openingCloud: Bool = true) {
        if openingCloud { openCloud(capturing: "01-before") }

        // The Happy mark over the first slide's title, which says nothing to
        // VoiceOver: tapped where it is drawn.
        let title = app.staticTexts["Happy Cloud"]
        require(title.waitForExistence(timeout: 10), "no welcome")
        capture("02-welcome")
        let logo = title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: -70))
        let form = element("cloud-test-login")
        // Quick bursts: a phone's taps one by one can outlast the four seconds.
        for _ in 0..<5 { logo.doubleTap() }
        if !form.waitForExistence(timeout: 2) { for _ in 0..<5 where !form.exists { logo.doubleTap() } }
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
        open(server: server, login: login)
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
        open(server: server, login: login)
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 120), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 4)
        let gear = app.buttons["settings"].firstMatch
        require(gear.waitForExistence(timeout: 5), "no settings on the home")
        gear.tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Inference'")).firstMatch
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        require(row.waitForExistence(timeout: 10), "no Inference in Settings")
        capture("40-settings")
        row.tap()
        let free = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Happy (free)'")).firstMatch
        require(free.waitForExistence(timeout: 20), "no Happy (free) connection")
        Thread.sleep(forTimeInterval: 1)
        capture("41-providers")
        app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Add a provider'")).firstMatch.tap()
        let chatGPT = app.buttons["settings:provider-family-chatgpt"]
        require(chatGPT.waitForExistence(timeout: 10), "no chooser")
        XCTAssertTrue(app.buttons["settings:provider-family-grok"].exists, "no Grok in the chooser")
        Thread.sleep(forTimeInterval: 1)
        capture("42-chooser")
        chatGPT.tap()
        let key = app.buttons["settings:provider-method-api-key-openai"]
        require(key.waitForExistence(timeout: 10), "no OpenAI key in ChatGPT's ways")
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

        // ChatGPT's device sign-in, on the server: a code to enter at
        // OpenAI, then cancelled. No token ever reaches the phone.
        let add = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Add a provider'")).firstMatch
        require(add.waitForExistence(timeout: 10), "no Add after the refusal")
        add.tap()
        require(chatGPT.waitForExistence(timeout: 10), "no chooser after the refusal")
        chatGPT.tap()
        let signIn = app.buttons["settings:provider-method-sign-in"]
        require(signIn.waitForExistence(timeout: 10), "the server's ChatGPT sign-in isn't offered")
        signIn.tap()
        if mine.waitForExistence(timeout: 5) { mine.tap() }
        let code = app.staticTexts["provider-device-code"]
        require(code.waitForExistence(timeout: 20), "no device screen")
        let shown = NSPredicate(format: "label MATCHES '[A-Z0-9]{3,}-[A-Z0-9]{3,}'")
        require(XCTWaiter.wait(for: [expectation(for: shown, evaluatedWith: code)], timeout: 120) == .completed, "no code from OpenAI: \(code.label)")
        XCTAssertTrue(app.buttons["provider-device-open"].isEnabled, "Open OpenAI is off")
        capture("46-device-code")
        app.buttons["provider-device-cancel"].tap()
        require(add.waitForExistence(timeout: 10), "cancel didn't come back to the list")

        // Claude's: a setup token only, with no page to open and no code to paste.
        add.tap()
        let claude = app.buttons["settings:provider-family-claude"]
        require(claude.waitForExistence(timeout: 10), "no Claude in the chooser")
        claude.tap()
        let setupToken = app.buttons["settings:provider-method-setup-token"]
        require(setupToken.waitForExistence(timeout: 10), "the server's Claude setup token isn't offered")
        setupToken.tap()
        if mine.waitForExistence(timeout: 5) { mine.tap() }
        let token = app.buttons["provider-claude-token"]
        require(token.waitForExistence(timeout: 20), "no Claude screen")
        XCTAssertFalse(app.buttons["provider-claude-open"].exists, "no Claude page to open")
        XCTAssertFalse(app.textFields["provider-claude-code"].exists, "no code field")
        capture("47-claude")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        require(add.waitForExistence(timeout: 10), "back didn't come to the list")
    }

    func testEServerIsRenamedFromItsSettings() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["RENAME_SERVER"] else { throw XCTSkip("no rename run") }
        let owner = env["ROLE"] != "viewer"
        app.launch()
        signInWithTestAccount(login: login, password: password)
        open(server: server, login: login)
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
        open(server: server, login: login)
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
        open(server: server, login: login)
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
        open(server: server, login: login)
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
    /// app does, and deletes its servers with these names: each server's
    /// owner DELETE (`/v0/server`, confirmed by its name) with that
    /// server's token. A delete that doesn't answer 204, or a server still
    /// listed after, fails the test.
    private nonisolated static func deleteServers(named names: Set<String>, login: String, password: String) async {
        let accounts = "https://auth.happy.engineering"
        func send(_ method: String, _ url: String, token: String? = nil, body: [String: String]? = nil) async -> (Int, Data) {
            var request = URLRequest(url: URL(string: url)!)
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
        struct ServerToken: Decodable { let access_token: String?; let token: String? }
        struct Servers: Decodable { struct Server: Decodable { let id: String; let name: String; let url: String }; let servers: [Server] }
        let (_, passData) = await send("POST", accounts + "/v1/auth/password", body: ["login": login, "password": password])
        guard let pass = (try? JSONDecoder().decode(Pass.self, from: passData))?.access_token else { return XCTFail("cleanup: no pass") }
        let (_, list) = await send("GET", accounts + "/v1/servers", token: pass)
        for server in (try? JSONDecoder().decode(Servers.self, from: list))?.servers ?? [] where names.contains(server.name) {
            let (_, tokenData) = await send("POST", accounts + "/v1/servers/\(server.id)/token", token: pass, body: [:])
            let issued = try? JSONDecoder().decode(ServerToken.self, from: tokenData)
            guard let token = issued?.access_token ?? issued?.token else {
                XCTFail("cleanup: no token for @\(server.name)")
                continue
            }
            let (status, _) = await send("DELETE", URL(string: server.url)!.appending(path: "v0/server").absoluteString, token: token, body: ["confirm": server.name])
            print("cleanup: deleted @\(server.name): \(status)")
            if status != 204 { XCTFail("cleanup: deleting @\(server.name) answered \(status)") }
        }
        let (_, after) = await send("GET", accounts + "/v1/servers", token: pass)
        let left = (try? JSONDecoder().decode(Servers.self, from: after))?.servers.filter { names.contains($0.name) }.map(\.name) ?? []
        if !left.isEmpty { XCTFail("cleanup: still listed: \(left)") }
    }

    private func first(_ candidates: [XCUIElement], timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let hit = candidates.first(where: \.exists) { return hit }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return nil
    }

    /// An invite link (`TEST_RUNNER_INVITE_URL`) opened from Notes opens
    /// the app on Happy Cloud's welcome; the test account signs in, the
    /// invite shows its server, and Join lands on that server's home. The
    /// first launch points the app at the deployment in `CLOUD_ACCOUNTS`,
    /// `CLOUD_BASE`, `CLOUD_WEB` and `CLOUD_INVITE`, kept for the launch
    /// the link makes. Then each link in `INVITE_STATES`
    /// (`name=url,name=url`, `mismatch` joined to see its refusal) opens on
    /// the same layout: the title, the status line and the button sit where
    /// they sat when the first invite was ready. Every step is filmed.
    func testInviteLinkOpensTheAppAndJoins() throws {
        guard let link = env["INVITE_URL"].flatMap(URL.init(string:)), let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"],
              let accounts = env["CLOUD_ACCOUNTS"], let base = env["CLOUD_BASE"], let web = env["CLOUD_WEB"], let invite = env["CLOUD_INVITE"]
        else { throw XCTSkip("no invite run") }
        app.launchArguments = ["-HappyCloudAccounts", accounts, "-HappyCloudBase", base, "-HappyCloudWeb", web, "-HappyCloudInvite", invite]
        app.launch()
        require(first([element("account-switcher"), app.buttons["start-cloud"]], timeout: 30) != nil, "the app didn't start")
        app.terminate()

        openFromNotes(link)
        let title = app.staticTexts["Happy Cloud"]
        film("a-link-opens", seconds: 40) { self.app.state == .runningForeground && title.exists }
        require(title.exists, "the link didn't open Happy Cloud's welcome in the app")
        capture("i3-opened-signed-out")
        signInWithTestAccount(login: login, password: password, openingCloud: false)

        let join = element("cloud-invite-join")
        film("b-invite-loads", seconds: 30) { join.exists && join.isEnabled }
        require(join.isEnabled, "the invite never loaded")
        Thread.sleep(forTimeInterval: 1)
        capture("i4-invite")
        tree("i4-invite", app)
        let ready = inviteFrames()
        report("ready", ready)
        join.tap()

        let name = element("cloud-profile-name")
        let switcher = element("account-switcher")
        film("c-joining", seconds: 90) { name.exists || switcher.exists }
        if name.exists {
            capture("i5-profile")
            name.tap()
            name.typeText("QA Peer")
            element("cloud-profile-continue").tap()
        }
        film("d-lands", seconds: 90) { switcher.exists }
        require(switcher.exists, "Join didn't land on the server's home")
        Thread.sleep(forTimeInterval: 4)
        capture("i6-server-home")

        for pair in (env["INVITE_STATES"] ?? "").split(separator: ",") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, let url = URL(string: parts[1]) else { continue }
            let state = parts[0]
            XCUIDevice.shared.system.open(url)
            let status = element("cloud-invite-status")
            film("e-\(state)", seconds: 30) { status.exists && !status.label.isEmpty }
            require(status.exists, "\(state) didn't open the invite")
            if state == "mismatch" {
                film("e-\(state)-ready", seconds: 20) { join.isEnabled }
                join.tap()
                film("e-\(state)-joined", seconds: 20) { status.label.contains("Sign in with that email") }
            }
            Thread.sleep(forTimeInterval: 1)
            capture("i7-\(state)")
            let frames = inviteFrames()
            report(state, frames)
            XCTAssertEqual(frames, ready, "\(state) moved the title, the status line or the button")
            if state == "expired" {
                // Show My Servers: the servers list, Bootstrap a new one a button under it.
                join.tap()
                film("f-servers", seconds: 20) { self.element("cloud-servers").exists }
                Thread.sleep(forTimeInterval: 2)
                capture("i8-servers")
            }
            let close = app.buttons["cloud-close"]
            if close.exists { close.tap() }
            Thread.sleep(forTimeInterval: 1.5)
        }
    }

    /// An account with no server bootstraps its first, which connects and
    /// lands on its home; then Happy Cloud, from the switcher, and an
    /// invite link both open still signed in: the servers list and Join,
    /// not the welcome. Runs with `TEST_RUNNER_FIRST_LOGIN`/`_PASSWORD`
    /// (an account with no server), `CLOUD_*` and `INVITE_URL`.
    func testAFirstBootstrapKeepsTheAccountSignedIn() throws {
        guard let login = env["FIRST_LOGIN"], let password = env["FIRST_PASSWORD"], let link = env["INVITE_URL"].flatMap(URL.init(string:)),
              let accounts = env["CLOUD_ACCOUNTS"], let base = env["CLOUD_BASE"], let web = env["CLOUD_WEB"], let invite = env["CLOUD_INVITE"]
        else { throw XCTSkip("no first-bootstrap run") }
        app.launchArguments = ["-HappyCloudAccounts", accounts, "-HappyCloudBase", base, "-HappyCloudWeb", web, "-HappyCloudInvite", invite]
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let name = element("cloud-create-name")
        film("a-first-bootstrap", seconds: 30) { name.exists }
        require(name.exists, "no first Bootstrap for an account with no server")
        capture("b1-first-bootstrap")
        name.tap()
        let server = "ios-first-\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        name.typeText(server)
        let save = element("cloud-create-save")
        film("b-name", seconds: 15) { save.isEnabled }
        // The keyboard has carried the button up: tapped where it rests.
        Thread.sleep(forTimeInterval: 1.5)
        save.tap()
        let profile = element("cloud-profile-name")
        let switcher = element("account-switcher")
        if !element("cloud-connecting").waitForExistence(timeout: 5), name.exists, save.isEnabled { save.tap() }
        film("c-connecting", seconds: 90) { profile.exists || switcher.exists }
        if profile.exists {
            profile.tap()
            profile.typeText("QA First")
            element("cloud-profile-continue").tap()
        }
        film("d-lands", seconds: 90) { switcher.exists }
        require(switcher.exists, "Bootstrap didn't land on @\(server)'s home")
        Thread.sleep(forTimeInterval: 3)
        capture("b2-server-home")

        switcher.tap()
        let cloud = element("account-cloud")
        require(cloud.waitForExistence(timeout: 5), "no Connect to Happy Cloud in the switcher")
        cloud.tap()
        let servers = element("cloud-servers")
        let welcome = element("cloud-welcome")
        film("e-cloud-again", seconds: 20) { servers.exists || welcome.exists }
        Thread.sleep(forTimeInterval: 1.5)
        capture("b3-cloud-again")
        XCTAssertTrue(servers.exists, "Happy Cloud again opened the welcome: the first Bootstrap signed the account out")
        let close = app.buttons["cloud-close"]
        if close.exists { close.tap() }
        Thread.sleep(forTimeInterval: 1.5)

        XCUIDevice.shared.system.open(link)
        let join = element("cloud-invite-join")
        film("f-invite", seconds: 30) { join.exists || welcome.exists }
        Thread.sleep(forTimeInterval: 1.5)
        capture("b4-invite-link")
        XCTAssertTrue(join.exists, "an invite link opened the welcome: the first Bootstrap signed the account out")
    }

    /// The invite screen's title, status line and button, where they are.
    private func inviteFrames() -> [CGRect] {
        [element("cloud-invite-title").frame, element("cloud-invite-status").frame, element("cloud-invite-join").frame]
    }

    private func report(_ state: String, _ frames: [CGRect]) {
        let attachment = XCTAttachment(string: "\(state): title \(frames[0]) status \(frames[1]) button \(frames[2])")
        attachment.name = "frames-\(state)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Screenshots back to back, named `film-<scene>-<n>`, until `done` or
    /// `seconds` pass: the frames of a recording.
    private func film(_ scene: String, seconds: TimeInterval = 20, until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(seconds)
        var frame = 0
        repeat {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = String(format: "film-%@-%03d", scene, frame)
            attachment.lifetime = .keepAlways
            add(attachment)
            frame += 1
            if !done() { Thread.sleep(forTimeInterval: 0.25) }
        } while !done() && Date() < deadline
    }

    /// Writes `link` in a new note and taps it there, as a person would
    /// open a link they were sent. A simulator has no Notes:
    /// `OPEN_WITH=system` opens it as the system opens a tapped link.
    private func openFromNotes(_ link: URL) {
        if env["OPEN_WITH"] == "system" {
            // A fresh install's association is fetched in the background:
            // until it is in, the link opens Safari.
            for _ in 0..<6 {
                XCUIDevice.shared.system.open(link)
                if app.wait(for: .runningForeground, timeout: 8) { return }
                capture("i2-opened-elsewhere")
                Thread.sleep(forTimeInterval: 10)
            }
            return
        }
        let notes = XCUIApplication(bundleIdentifier: "com.apple.mobilenotes")
        notes.launch()
        Thread.sleep(forTimeInterval: 2)
        let compose = notes.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'new note' OR identifier CONTAINS[c] 'compose'")).firstMatch
        if compose.waitForExistence(timeout: 10) { compose.tap() } else { capture("i1-notes-no-compose"); tree("i1-notes", notes) }
        Thread.sleep(forTimeInterval: 1.5)
        notes.typeText(link.absoluteString + "\n")
        let done = notes.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() }
        Thread.sleep(forTimeInterval: 2)
        capture("i1-note")
        tree("i1-note", notes)
        let tappable = notes.links.firstMatch
        require(tappable.waitForExistence(timeout: 10), "the note's link isn't a link")
        tappable.tap()
    }

    func testConnectSignUpAndTalkToAnAgent() throws {
        try XCTSkipUnless(env["HAPPY_CLOUD_E2E"] == "1")
        app.launch()

        let switcher = element("account-switcher")
        openCloud(capturing: "1-home")

        // The welcome's own sign-in, under its slides.
        let apple = element("cloud-apple")
        require(apple.waitForExistence(timeout: 10), "no welcome")
        capture("3-welcome")
        apple.tap()
        // Apple's sheet needs the person: Face ID or the passcode.
        // Join a server's Bootstrap a new one, or Bootstrap itself for an account with none.
        let create = element("cloud-create")
        let name = element("cloud-create-name")
        require(create.waitForExistence(timeout: 180) || name.exists, "no picker after the account's sign-in")
        capture("7-picker")
        if !name.exists { create.tap() }
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

    /// A fresh server's onboarding on a real deployment, gate by gate, as
    /// the server plans it: `TEST_RUNNER_LIVE_SERVER` is created (or, made
    /// before, joined) by the test account. The profile is named, the
    /// admin bot keeps its name, the provider chooser is shown and closed,
    /// a plugin's page opened, nobody is invited, notifications are turned
    /// on through the system's prompt, and the finish opens the admin bot.
    /// Pictures of every step. The server is deleted only with
    /// `TEST_RUNNER_LIVE_DELETE=1`.
    func testHAFreshServersOnboardingOnARealDeployment() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LIVE_SERVER"] else { throw XCTSkip("no live onboarding run") }
        if env["LIVE_DELETE"] == "1" {
            addTeardownBlock { await Self.deleteServers(named: [server], login: login, password: password) }
        }
        app.launch()
        signInWithTestAccount(login: login, password: password)
        let create = element("cloud-create")
        let name = element("cloud-create-name")
        let join = element("cloud-server-\(server)")
        require(first([create, name, join], timeout: 30) != nil, "no servers after the test account's sign-in")
        Thread.sleep(forTimeInterval: 2)
        capture("05-servers")
        if join.exists {
            open(server: server, login: login)
        } else {
            if !name.exists { create.tap() }
            require(name.waitForExistence(timeout: 10), "no name field")
            name.tap()
            name.typeText(server)
            // Bootstrap waits for the name's check.
            let save = element("cloud-create-save")
            let available = NSPredicate(format: "isEnabled == true")
            require(XCTWaiter.wait(for: [expectation(for: available, evaluatedWith: save)], timeout: 20) == .completed, "@\(server) was never available")
            capture("06-name")
            save.tap()
        }

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let switcher = element("account-switcher")
        let primary = element("onboarding-primary")
        let secondary = element("onboarding-secondary")
        var seen: [String] = []
        var finished = false
        for step in 0..<30 where !finished {
            Thread.sleep(forTimeInterval: 3)
            let screens = ["cloud-profile", "onboarding-photo", "onboarding-admin-bot", "onboarding-inference", "onboarding-plugins",
                           "onboarding-teammates", "onboarding-notifications", "onboarding-notice"]
            guard let screen = screens.first(where: { element($0).exists }) else {
                if switcher.exists, !seen.isEmpty { finished = true; break }
                capture(String(format: "1%02d-waiting", step))
                continue
            }
            seen.append(screen)
            let shot = String(format: "1%02d-%@", step, screen)
            capture(shot)
            tree(shot, app)
            switch screen {
            case "cloud-profile":
                let field = element("cloud-profile-name")
                if let value = field.value as? String, value.isEmpty || value == field.placeholderValue {
                    field.tap()
                    field.typeText("QA iOS")
                }
                element("cloud-profile-continue").tap()
            case "onboarding-photo", "onboarding-teammates":
                // No picture, and nobody is mailed an invite.
                require(secondary.exists, "\(screen) has no Skip")
                secondary.tap()
            case "onboarding-admin-bot":
                primary.tap()
            case "onboarding-inference":
                primary.tap()
                let chatGPT = app.buttons["settings:provider-family-chatgpt"]
                require(chatGPT.waitForExistence(timeout: 15), "no provider chooser")
                Thread.sleep(forTimeInterval: 1)
                capture(shot + "-chooser")
                chatGPT.tap()
                Thread.sleep(forTimeInterval: 1.5)
                capture(shot + "-chatgpt")
                // The sheet's own bars: the flow's Not Now is under them.
                app.navigationBars["ChatGPT"].buttons.firstMatch.tap()
                Thread.sleep(forTimeInterval: 1)
                app.navigationBars["Add a provider"].buttons.firstMatch.tap()
                Thread.sleep(forTimeInterval: 1.5)
                require(secondary.exists, "the inference step is required here: no provider was connected")
                secondary.tap()
            case "onboarding-plugins":
                let github = element("onboarding-plugin-github")
                if github.exists, seen.filter({ $0 == screen }).count == 1 {
                    github.tap()
                    Thread.sleep(forTimeInterval: 3)
                    capture(shot + "-github")
                    app.navigationBars.buttons.element(boundBy: 0).tap()
                    continue
                }
                if secondary.exists { secondary.tap() } else { primary.tap() }
            case "onboarding-notifications":
                primary.tap()
                let allow = springboard.alerts.buttons["Allow"]
                if allow.waitForExistence(timeout: 10) {
                    capture(shot + "-prompt")
                    allow.tap()
                }
                Thread.sleep(forTimeInterval: 4)
                capture(shot + "-after")
                if element("onboarding-notifications").exists, secondary.exists { secondary.tap() }
            default:
                // The finish, or a notice: its one action.
                primary.tap()
                Thread.sleep(forTimeInterval: 5)
                capture(shot + "-after")
                tree(shot + "-after", app)
                if !app.staticTexts["Finish on your computer"].exists { finished = seen.filter({ $0 == screen }).count > 0 }
            }
        }
        capture("199-end")
        tree("199-end", app)
        print("LIVE_ONBOARDING screens: \(seen.joined(separator: ","))")
        require(finished, "onboarding didn't end: \(seen)")
    }

    /// T03's Gen UI secret form on a real deployment: on
    /// `TEST_RUNNER_LIVE_SERVER`, already onboarded, the Chief of Staff is
    /// asked to request a Stripe key; its card's button opens the cluster's
    /// form, a made-up value is saved, the form says so, and the button
    /// opens on the secret it made. Pictures of every step.
    func testHBGenUISecretFormOnARealDeployment() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LIVE_SERVER"] else { throw XCTSkip("no live Gen UI run") }
        app.launch()
        let switcher = element("account-switcher")
        if !switcher.waitForExistence(timeout: 20) {
            signInWithTestAccount(login: login, password: password)
            open(server: server, login: login)
        }
        require(switcher.waitForExistence(timeout: 60), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 3)
        capture("20-home")
        let chief = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Chief of Staff'")).firstMatch
        require(chief.waitForExistence(timeout: 20), "no Chief of Staff on home")
        chief.tap()
        let composer = app.textViews["composer"]
        require(composer.waitForExistence(timeout: 20), "no composer")
        // The card's button, once the Chief of Staff has asked: asked once per server.
        let card = app.buttons.matching(NSPredicate(format: "label == 'Add secret' OR label == 'Change secret'")).firstMatch
        Thread.sleep(forTimeInterval: 4)
        if !card.exists {
            composer.tap()
            composer.typeText("Use request_secret to ask me for a Stripe API key: an endpoint secret for api.stripe.com, sent as Authorization: Bearer <key>.")
            capture("21-asked")
            app.buttons["Send"].tap()
            Thread.sleep(forTimeInterval: 5)
            capture("21b-after-send")
            // Seen on the simulator: the first tap after typing can leave
            // the text in the composer.
            let left = (composer.value as? String).map { !$0.isEmpty && $0 != composer.placeholderValue } ?? false
            print("LIVE_SEND text left after the first tap: \(left)")
            if left {
                app.buttons["Send"].tap()
                Thread.sleep(forTimeInterval: 5)
                capture("21c-after-second-send")
            }
            var waited = 0
            while !card.exists, waited < 240 {
                Thread.sleep(forTimeInterval: 10)
                waited += 10
                if waited % 60 == 0 { capture("22-waiting-\(waited)") }
            }
        }
        capture("23-card")
        tree("23-card", app)
        require(card.exists, "no Add secret button in the Chief of Staff's answer")
        for _ in 0..<6 where !card.isHittable { app.swipeUp() }
        let label = card.label
        card.tap()
        require(app.navigationBars["New Secret"].waitForExistence(timeout: 15), "the button opened no New Secret form")
        Thread.sleep(forTimeInterval: 1)
        capture("24-form")
        tree("24-form", app)
        let value = app.secureTextFields.matching(NSPredicate(format: "identifier BEGINSWITH 'genui-secret-header-' AND identifier ENDSWITH '-value'")).firstMatch
        require(value.waitForExistence(timeout: 5), "no header value field")
        value.tap()
        value.typeText("sk_test_t13_not_a_real_key")
        element("genui-secret-save").tap()
        require(app.navigationBars["Secret Added"].waitForExistence(timeout: 20), "not saved")
        Thread.sleep(forTimeInterval: 1)
        capture("25-added")
        tree("25-added", app)
        app.buttons["Done"].tap()
        Thread.sleep(forTimeInterval: 3)
        capture("26-after")
        let reopen = card
        require(reopen.waitForExistence(timeout: 10), "the button went")
        print("LIVE_GENUI after save: \(reopen.label)")
        reopen.tap()
        require(app.navigationBars["Change Secret"].waitForExistence(timeout: 15), "not opened on the saved secret")
        Thread.sleep(forTimeInterval: 1)
        capture("27-change")
        tree("27-change", app)
        element("genui-secret-cancel").tap()
        Thread.sleep(forTimeInterval: 8)
        capture("28-conversation")
        tree("28-conversation", app)
        print("LIVE_GENUI button: \(label)")
    }

    /// Notifications on a real deployment whose tenant asks for the
    /// mobile app (`onboarding.gates.mobileApp` optional), on an install
    /// already signed in and past the rest: the step shows, Allow answers
    /// iOS's prompt, and the registration completes the step.
    func testHDNotificationsStepOnARealDeployment() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LIVE_SERVER"] else { throw XCTSkip("no live run") }
        app.launch()
        let switcher = element("account-switcher")
        let step = element("onboarding-notifications")
        if first([switcher, step], timeout: 20) == nil {
            signInWithTestAccount(login: login, password: password)
            open(server: server, login: login)
        }
        Thread.sleep(forTimeInterval: 5)
        capture("40-launch")
        tree("40-launch", app)
        require(step.waitForExistence(timeout: 30), "no notifications step")
        capture("41-step")
        tree("41-step", app)
        element("onboarding-primary").tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        let prompted = allow.waitForExistence(timeout: 10)
        if prompted {
            capture("42-prompt")
            allow.tap()
        }
        Thread.sleep(forTimeInterval: 8)
        capture("43-after")
        tree("43-after", app)
        let texts = step.exists ? step.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " | ") : "-"
        print("LIVE_PUSH prompted=\(prompted) step-still-shown=\(step.exists) home=\(switcher.exists) texts=\(texts)")
    }

    /// The request_secret artifact as a full page on a real deployment,
    /// after `testHBGenUISecretFormOnARealDeployment`: from its row in the
    /// Chief of Staff's chat, then from the server's Artifacts list.
    func testHCGenUIArtifactFullPageOnARealDeployment() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LIVE_SERVER"] else { throw XCTSkip("no live Gen UI run") }
        app.launch()
        let switcher = element("account-switcher")
        if !switcher.waitForExistence(timeout: 20) {
            signInWithTestAccount(login: login, password: password)
            open(server: server, login: login)
        }
        require(switcher.waitForExistence(timeout: 60), "no home of @\(server)")
        Thread.sleep(forTimeInterval: 3)
        let chief = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Chief of Staff'")).firstMatch
        require(chief.waitForExistence(timeout: 20), "no Chief of Staff on home")
        chief.tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Open Add your Stripe API key'")).firstMatch
        require(row.waitForExistence(timeout: 20), "no artifact row in the chat")
        for _ in 0..<6 where !row.isHittable { app.swipeDown() }
        row.tap()
        // The page's own button: the saved secret, opened again.
        func pressSecret(on from: String) {
            let button = element("artifact-gen-ui").buttons.matching(NSPredicate(format: "label CONTAINS 'secret'")).firstMatch
            require(button.waitForExistence(timeout: 10), "no secret button on the page from the \(from)")
            print("LIVE_ARTIFACT \(from) button: \(button.label)")
            button.tap()
            let form = first([app.navigationBars["Change Secret"], app.navigationBars["New Secret"]], timeout: 15)
            require(form != nil, "the page's button opened no form from the \(from)")
            print("LIVE_ARTIFACT \(from) form: \(form?.identifier ?? "-")")
            Thread.sleep(forTimeInterval: 1)
            capture("3x-\(from)-form")
            element("genui-secret-cancel").tap()
            Thread.sleep(forTimeInterval: 2)
        }
        let page = element("artifact")
        require(page.waitForExistence(timeout: 15), "the row opened no artifact page")
        Thread.sleep(forTimeInterval: 6)
        capture("30-from-chat")
        tree("30-from-chat", app)
        print("LIVE_ARTIFACT from chat: genui=\(element("artifact-gen-ui").exists) message=\(element("artifact-message").exists ? element("artifact-message").label : "-")")
        pressSecret(on: "chat")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        Thread.sleep(forTimeInterval: 2)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        Thread.sleep(forTimeInterval: 2)

        let artifacts = element("row:space:Artifacts")
        require(artifacts.waitForExistence(timeout: 15), "no Artifacts on home")
        artifacts.tap()
        require(element("artifacts-list").waitForExistence(timeout: 15), "no artifacts list")
        Thread.sleep(forTimeInterval: 3)
        capture("31-list")
        tree("31-list", app)
        let item = element("artifacts-list").descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Stripe'")).firstMatch
        require(item.waitForExistence(timeout: 15), "the artifact isn't listed")
        item.tap()
        require(page.waitForExistence(timeout: 15), "the list opened no artifact page")
        Thread.sleep(forTimeInterval: 6)
        capture("32-from-list")
        tree("32-from-list", app)
        print("LIVE_ARTIFACT from list: genui=\(element("artifact-gen-ui").exists) message=\(element("artifact-message").exists ? element("artifact-message").label : "-")")
        pressSecret(on: "list")
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
        let name = element("cloud-create-name")
        require(create.waitForExistence(timeout: 30) || name.exists, "no servers after the test account's sign-in")
        Thread.sleep(forTimeInterval: 2)
        capture("05-servers")
        if !name.exists { create.tap() }
        require(name.waitForExistence(timeout: 10), "no name field")
        name.tap()
        let server = "qa-ios-\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        // Whatever happens, the servers this run made go (owner DELETE).
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
        require(element("cloud-servers").waitForExistence(timeout: 15), "the pass didn't open Join a server")
        Thread.sleep(forTimeInterval: 2)
        capture("10-servers-again")
        let cards = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cloud-server-' AND identifier != %@", "cloud-server-\(server)"))
        let second: String
        if cards.count > 0 {
            let card = cards.element(boundBy: 0)
            second = String(card.identifier.dropFirst("cloud-server-".count))
            open(server: second, login: login)
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

    // MARK: The link in the headers

    /// Settings › Developer › Network Link Conditioner: `profile` on, or
    /// off for nil, then the app in front again. The runner talks to the
    /// phone over its cable, so it is never cut off itself.
    private func condition(_ profile: String?) {
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.terminate()
        settings.launch()
        let enable = settings.switches["Enable"].firstMatch
        if !enable.waitForExistence(timeout: 2) {
            let developer = settings.staticTexts["Developer"].firstMatch
            for _ in 0..<14 where !developer.isHittable { settings.swipeUp() }
            require(developer.isHittable, "no Developer in Settings")
            developer.tap()
            let conditioner = settings.staticTexts["Network Link Conditioner"].firstMatch
            for _ in 0..<6 where !conditioner.isHittable { settings.swipeUp() }
            require(conditioner.waitForExistence(timeout: 5), "no Network Link Conditioner")
            conditioner.tap()
            require(enable.waitForExistence(timeout: 5), "no Enable on the conditioner")
        }
        if let profile {
            let row = settings.staticTexts[profile].firstMatch
            for _ in 0..<6 where !row.isHittable { settings.swipeUp() }
            require(row.waitForExistence(timeout: 5), "no \(profile) profile")
            row.tap()
            for _ in 0..<6 where !enable.isHittable { settings.swipeDown() }
        }
        if (enable.value as? String == "1") != (profile != nil) { enable.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
        Thread.sleep(forTimeInterval: 0.5)
        let shot = XCTAttachment(screenshot: settings.screenshot())
        shot.name = "conditioner-\(profile ?? "off")"
        shot.lifetime = .keepAlways
        add(shot)
        app.activate()
        _ = app.wait(for: .runningForeground, timeout: 5)
    }

    /// Pictures every 0.6 s for `seconds`, each named for what `of` says
    /// then, and whether `words` was seen.
    private func watch(_ name: String, _ of: XCUIElement, for seconds: TimeInterval, until words: String? = nil, read: (XCUIElement) -> String) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        var index = 0, seen = false
        while Date() < deadline {
            let said = of.exists ? read(of) : ""
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "\(name)-\(String(format: "%02d", index))-\(said)"
            attachment.lifetime = .keepAlways
            add(attachment)
            index += 1
            if let words, said.contains(words) { seen = true; break }
            Thread.sleep(forTimeInterval: 0.6)
        }
        return seen
    }

    /// A real Happy Cloud server (`TEST_RUNNER_LINK_SERVER`, holding the
    /// task `TEST_RUNNER_LINK_TASK`) on a phone, its link cut and slowed with
    /// the Network Link Conditioner: home's title and the chat's subtitle
    /// say "Connecting…" while the server doesn't answer, for as long as it
    /// doesn't (never offline with a notice, as a computer that didn't
    /// answer is), and "Updating…" while it catches up after.
    func testFLinkSaysConnectingAndUpdatingOnARealServer() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LINK_SERVER"] else { throw XCTSkip("no link run") }
        let taskName = env["LINK_TASK"] ?? "Link check"
        condition(nil)
        app.launch()
        signInWithTestAccount(login: login, password: password)
        open(server: server, login: login)
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        let title = { (element: XCUIElement) in element.value as? String ?? "" }
        let task = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", taskName)).firstMatch
        require(task.waitForExistence(timeout: 60), "no \(taskName) on home")
        Thread.sleep(forTimeInterval: 5)
        capture("30-real-home-online")
        tree("30-real-home-online", app)

        // Cut off while the phone keeps its network: connecting, and still
        // connecting once every try meanwhile has failed.
        condition("100% Loss")
        let connecting = watch("31-real-home", switcher, for: 20, until: "Connecting", read: title)
        require(connecting, "home never said Connecting…")
        Thread.sleep(forTimeInterval: 75)
        XCTAssertTrue(title(switcher).contains("Connecting"), "home's title after 75 s: \(title(switcher))")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'didn’t answer' OR label CONTAINS[c] \"didn't answer\"")).firstMatch.exists, "a notice says the server didn't answer")
        capture("32-real-home-connecting-75s")
        task.tap()
        let status = element("chat-status")
        let chatConnecting = watch("33-real-chat", status, for: 10, until: "connecting", read: { $0.label })
        require(chatConnecting, "the chat never said connecting…")
        capture("34-real-chat-connecting")

        // Back, slowly: the chat catches up, "updating…".
        condition("Very Bad Network")
        let chatUpdating = watch("35-real-chat", status, for: 40, until: "updating", read: { $0.label })
        capture("36-real-chat-after")
        XCTAssertTrue(chatUpdating, "the chat never said updating…")
        goBack(switcher)
        // Again from home: Settings and back starts the link over.
        condition("Very Bad Network")
        let homeUpdating = watch("37-real-home", switcher, for: 40, until: "Updating", read: title)
        capture("38-real-home-after")
        XCTAssertTrue(homeUpdating, "home never said Updating…")
        condition(nil)
        _ = watch("39-real-home-back", switcher, for: 6, read: title)
    }

    /// Waits for the host script's `phase` file under `TEST_RUNNER_LINK_PHASES`
    /// (a simulator shares the Mac's files), then says `done` there.
    private func phase(_ name: String, timeout: TimeInterval = 120) {
        guard let folder = env["LINK_PHASES"] else { return }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !FileManager.default.fileExists(atPath: folder + "/" + name) { Thread.sleep(forTimeInterval: 0.3) }
        require(FileManager.default.fileExists(atPath: folder + "/" + name), "the host never reached \(name)")
    }

    private func said(_ name: String) {
        guard let folder = env["LINK_PHASES"] else { return }
        FileManager.default.createFile(atPath: folder + "/" + name, contents: Data())
    }

    /// The same real server in the simulator, the Mac's pf cutting it off
    /// and then slowing it, step by step with the host script
    /// (`TEST_RUNNER_LINK_PHASES`): "Connecting…" while it doesn't answer,
    /// "Updating…" while a cold start catches up slowly.
    func testGLinkOnARealServerInTheSimulator() throws {
        guard let login = env["QA_LOGIN"], let password = env["QA_PASSWORD"], let server = env["LINK_SERVER"], env["LINK_PHASES"] != nil else { throw XCTSkip("no simulator link run") }
        let taskName = env["LINK_TASK"] ?? "Link check"
        app.launch()
        signInWithTestAccount(login: login, password: password)
        open(server: server, login: login)
        let switcher = element("account-switcher")
        require(switcher.waitForExistence(timeout: 90), "no home of @\(server)")
        let title = { (element: XCUIElement) in element.value as? String ?? "" }
        let task = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", taskName)).firstMatch
        require(task.waitForExistence(timeout: 60), "no \(taskName) on home")
        Thread.sleep(forTimeInterval: 5)
        capture("40-sim-home-online")
        said("ready")

        // The host blocks the server; the Mac keeps its network.
        phase("blocked")
        let connecting = watch("41-sim-home", switcher, for: 75, until: "Connecting", read: title)
        require(connecting, "home never said Connecting…")
        Thread.sleep(forTimeInterval: 30)
        XCTAssertTrue(title(switcher).contains("Connecting"), "home's title after 30 s more: \(title(switcher))")
        capture("42-sim-home-connecting-30s")
        tree("42-sim-home-connecting-30s", app)
        task.tap()
        let status = element("chat-status")
        let chatConnecting = watch("43-sim-chat", status, for: 15, until: "connecting", read: { $0.label })
        capture("44-sim-chat-connecting")
        XCTAssertTrue(chatConnecting, "the chat never said connecting…")
        said("cut-done")

        // The host lets it through, slowly: the open chat comes back and
        // catches up, then a cold start catches up from home.
        phase("slow")
        let chatUpdating = watch("45-sim-chat", status, for: 75, until: "updating", read: { $0.label })
        capture("46-sim-chat-after")
        XCTAssertTrue(chatUpdating, "the chat never said updating…")
        app.terminate()
        app.launch()
        require(switcher.waitForExistence(timeout: 30), "no home after the relaunch")
        let homeUpdating = watch("47-sim-home", switcher, for: 60, until: "Updating", read: title)
        capture("48-sim-home-after")
        XCTAssertTrue(homeUpdating, "home never said Updating…")
        said("slow-done")
        phase("clear")
        _ = watch("49-sim-home-back", switcher, for: 15, read: title)
    }
}
