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
            let link = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", String(target), String(target))).firstMatch
            guard link.waitForExistence(timeout: 20) else {
                XCTFail("no link \(target)")
                print("PREVIEW_TREE \(app.debugDescription)")
                continue
            }
            // A message is one element; tap the line its link is on.
            let lines = link.label.components(separatedBy: "\n")
            let line = lines.firstIndex { $0.contains(target) } ?? 0
            link.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: (Double(line) + 0.5) / Double(lines.count))).tap()
            var waited = 0
            for second in [3, 8, 15, 30] {
                pause(Double(second - waited))
                waited = second
                report(String(target), at: second)
                keep("\(20 + index)-\(target.replacingOccurrences(of: "/", with: "_"))-\(second)s")
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
        print("PREVIEW_TEXT \(target) @\(second)s web=\(web.exists) \(texts(try? web.snapshot()).joined(separator: " | "))")
        print("PREVIEW_SCREEN \(target) @\(second)s \(texts(try? app.snapshot()).prefix(12).joined(separator: " | "))")
    }

    private func launch() {
        app.launch()
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:")).firstMatch
        if any.waitForExistence(timeout: 10) { return }
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

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}
