import XCTest

/// A dev server on the computer, previewed from a chat against a throwaway
/// Happy Agent (a driver plays the computer's side of pairing when the
/// test prints `HAPPY_PAIR_READY`). The agent's reply links the server
/// as `localhost` and as `127.0.0.1`; each opens in the in-app browser and
/// the page's own checks (redirect, cookies, HMR WebSocket, absolute-URL
/// assets) are printed as `PREVIEW_TEXT` lines. Runs only when
/// `PREVIEW_CHAT` names the chat.
@MainActor
final class BrowserPreviewUITests: XCTestCase {
    private let app = XCUIApplication()
    private var environment: [String: String] { ProcessInfo.processInfo.environment }

    override func setUp() {
        continueAfterFailure = true
        app.launchArguments += ["-v2.direct", "YES"]
    }

    func testPreviewOpensFromAChat() throws {
        guard let chat = environment["PREVIEW_CHAT"] else { throw XCTSkip("no preview run") }
        launch()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "row:", ":\(chat)")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row \(chat)")
        row.tap()
        pause(3)
        keep("10-chat")
        for (index, target) in (environment["PREVIEW_LINKS"] ?? "localhost:5173/go,127.0.0.1:5173/app").split(separator: ",").enumerated() {
            let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", String(target), String(target)))
            if matches.firstMatch.waitForExistence(timeout: 10), let link = matches.allElementsBoundByIndex.last {
                // The newest message naming it, one element; tap the line its link is on.
                let lines = link.label.components(separatedBy: "\n")
                let line = lines.firstIndex { $0.contains(target) } ?? 0
                link.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: (Double(line) + 0.5) / Double(lines.count))).tap()
            }
            if !app.webViews.firstMatch.waitForExistence(timeout: 5) {
                // The message may be scrolled away: the chat's details list its links, from the same agent.
                let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'detail-link:' AND value CONTAINS %@", String(target))).firstMatch
                if !row.exists { app.staticTexts[chat].firstMatch.tap() }
                if row.waitForExistence(timeout: 5) { row.tap() }
                guard app.webViews.firstMatch.waitForExistence(timeout: 10) else {
                    XCTFail("no link \(target)")
                    print("PREVIEW_TREE \(app.debugDescription)")
                    continue
                }
            }
            var waited = 0
            // PREVIEW_HOLD keeps the page open that many seconds, read every 2 s and kept every 10 s, for a window on the computer.
            let hold = Int(environment["PREVIEW_HOLD"] ?? "") ?? 0
            for second in hold > 0 ? Array(stride(from: 2, through: hold, by: 2)) : [3, 8, 15, 30] {
                pause(Double(second - waited))
                waited = second
                report(String(target), at: second)
                if hold == 0 || second % 10 == 0 { keep("\(20 + index)-\(target.replacingOccurrences(of: "/", with: "_"))-\(second)s") }
            }
            app.navigationBars.buttons.element(boundBy: 0).tap()
            pause(2)
        }
    }

    /// What the page and the browser's error page say, one line each, read
    /// from one snapshot so a page still changing cannot fail the read.
    private func report(_ target: String, at second: Int) {
        func texts(_ snapshot: (any XCUIElementSnapshot)?) -> [String] {
            guard let snapshot else { return [] }
            let own = snapshot.elementType == .staticText && !snapshot.label.isEmpty ? [snapshot.label] : []
            return own + snapshot.children.flatMap { texts($0) }
        }
        let web = app.webViews.firstMatch
        let now = Date().formatted(.iso8601.time(includingFractionalSeconds: false))
        print("PREVIEW_TEXT \(target) @\(second)s \(now)Z web=\(web.exists) \(texts(try? web.snapshot()).joined(separator: " | "))")
        print("PREVIEW_SCREEN \(target) @\(second)s \(texts(try? app.snapshot()).prefix(12).joined(separator: " | "))")
    }

    private func launch() {
        if let code = environment["PREVIEW_SCAN"] { app.launchEnvironment["HAPPY_SIMULATED_SCAN"] = code }
        app.launch()
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:")).firstMatch
        if any.waitForExistence(timeout: 10) { return }
        if environment["PREVIEW_SCAN"] != nil { return signIn(until: any) }
        print("HAPPY_PAIR_READY")
        let match = app.buttons["Emoji match"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "pairing never showed its emoji")
        pause(1.5)
        match.tap()
        XCTAssertTrue(any.waitForExistence(timeout: 90))
    }

    /// A server's code (`PREVIEW_SCAN`) read by Start's scanner, then its
    /// sign-in page filled with `PREVIEW_USER` and `PREVIEW_PASSWORD`.
    private func signIn(until home: XCUIElement) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        let start = app.buttons["start-button"]
        XCTAssertTrue(start.waitForExistence(timeout: 30), "no Start")
        start.tap()
        let scan = app.buttons["install-desktop-scan"]
        if scan.waitForExistence(timeout: 10) { scan.tap() }
        pause(1)
        for button in ["Allow", "OK"] where springboard.alerts.buttons[button].exists { springboard.alerts.buttons[button].tap() }
        let proceed = app.descendants(matching: .any)["server-sign-in-continue"]
        XCTAssertTrue(proceed.waitForExistence(timeout: 20), "the sign-in screen didn't open")
        keep("01-server-sign-in")
        proceed.tap()
        let consent = springboard.alerts.buttons["Continue"]
        if consent.waitForExistence(timeout: 20) { consent.tap() }
        let user = browser.textFields.firstMatch
        XCTAssertTrue(user.waitForExistence(timeout: 30), "the sign-in page never showed")
        keep("02-sign-in-page")
        user.tap()
        user.typeText(environment["PREVIEW_USER"] ?? "")
        let password = browser.secureTextFields.firstMatch
        password.tap()
        password.typeText(environment["PREVIEW_PASSWORD"] ?? "")
        browser.buttons["Sign in"].tap()
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !home.exists {
            // A profile gate asks for a name the first time.
            let name = app.textFields.firstMatch
            if name.exists, app.buttons["Continue"].exists, (name.value as? String ?? "").isEmpty {
                name.tap(); name.typeText("Alice"); app.buttons["Continue"].tap()
            }
            _ = home.waitForExistence(timeout: 2)
        }
        keep("03-signed-in")
        if !home.exists { print("PREVIEW_TREE \(app.debugDescription)") }
        XCTAssertTrue(home.exists, "never reached the server's home")
    }

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}
