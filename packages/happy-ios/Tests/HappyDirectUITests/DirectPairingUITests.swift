import XCTest

/// The Mac interop controller opens two private daemon-generated deep links
/// on this isolated simulator. No QR credential enters the test transcript.
@MainActor
final class DirectPairingUITests: XCTestCase {
    func testTwoDirectComputersAndSwitcher() {
        let app = XCUIApplication()
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
        // This simulator contains only accounts created by this isolated
        // interop job. Exercise removal before repeating the two-account run.
        for _ in 0..<8 {
            guard app.buttons["Manage accounts"].waitForExistence(timeout: 2) else { break }
            XCTAssertTrue(app.staticTexts["Tailcat Test Mac"].exists)
            app.buttons["Disconnect"].tap()
            let confirmation = app.alerts.buttons["Disconnect"]
            XCTAssertTrue(confirmation.waitForExistence(timeout: 5)); confirmation.tap()
        }
        print("DIRECT_UI_READY")
        let match = app.buttons["Emoji match"]
        XCTAssertTrue(waitForPairing(match, app: app))
        capture("pairing-emoji")
        match.tap()
        XCTAssertTrue(app.buttons["Manage accounts"].waitForExistence(timeout: 90))
        XCTAssertTrue(app.staticTexts["Tailcat Test Mac"].exists)
        capture("direct-connected")
        // The controller starts the next pairing after the first completes.
        XCTAssertTrue(waitForPairing(match, app: app))
        match.tap()
        XCTAssertTrue(app.buttons["Manage accounts"].waitForExistence(timeout: 90))
        let switcher = app.buttons["Switch account"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 10)); switcher.tap()
        XCTAssertTrue(app.navigationBars["Accounts"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pair a computer")).firstMatch.exists)
        capture("direct-account-switcher")
    }

    private func waitForPairing(_ button: XCUIElement, app: XCUIApplication) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            // simctl openurl presents this normal system confirmation on a
            // fresh simulator. This test authorizes only opening our link.
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] {
                if alert.buttons["Open"].exists { alert.buttons["Open"].tap() }
            }
            if button.waitForExistence(timeout: 1) { return true }
        }
        return false
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}