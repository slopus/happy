import XCTest

/// The isolated Mac daemon controller opens its private pairing link after
/// DIRECT_SYNC_READY. These assertions drive the real app on the iPhone too.
@MainActor
final class DirectSyncUITests: XCTestCase {
    func testCanonicalHomeSettingsAndConversation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
        print("DIRECT_SYNC_READY")
        let artifacts = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Artifacts")).firstMatch
        if !artifacts.waitForExistence(timeout: 8) {
            let match = app.buttons["Emoji match"]
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline && !match.exists {
                for alert in [app.alerts.firstMatch, XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch] where alert.buttons["Open"].exists { alert.buttons["Open"].tap() }
                _ = match.waitForExistence(timeout: 1)
            }
            XCTAssertTrue(match.exists)
            capture("direct-pairing")
            match.tap()
        }
        XCTAssertTrue(artifacts.waitForExistence(timeout: 90))
        let labels = ["Artifacts", "Bots", "Chief of Staff", "Release helper", "Tasks", "Review sidebar parity", "Verify offline cache", "Projects", "Sample Project"]
        var lastY = -Double.infinity
        for label in labels {
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "stem-row:", label)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), label)
            XCTAssertGreaterThan(Double(row.frame.midY), lastY, label)
            lastY = Double(row.frame.midY)
        }
        capture("direct-canonical-home")
        let settings = app.descendants(matching: .any)["stem-settings-mark"]
        settings.tap()
        let hidden = app.switches["stem-settings-toggle:hide-projects"]
        XCTAssertTrue(hidden.waitForExistence(timeout: 10))
        capture("direct-synced-settings")
        XCTAssertFalse(app.descendants(matching: .any)["stem-settings:prioritizing"].exists)
        hidden.tap()
        print("DIRECT_SYNC_LOCAL_HIDE")
        app.buttons["stem-glass-back"].tap()
        let project = app.descendants(matching: .any)["stem-row:space:Sample Project"]
        XCTAssertTrue(waitForAbsence(project))
        capture("direct-projects-hidden")
        print("DIRECT_SYNC_REMOTE_SHOW")
        XCTAssertTrue(project.waitForExistence(timeout: 30))
        print("DIRECT_SYNC_OFFLINE")
        Thread.sleep(forTimeInterval: 2)
        app.terminate(); app.launch()
        XCTAssertTrue(artifacts.waitForExistence(timeout: 15))
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        capture("direct-offline-home")
        settings.tap()
        XCTAssertTrue(hidden.waitForExistence(timeout: 10))
        hidden.tap()
        app.buttons["stem-glass-back"].tap()
        XCTAssertTrue(waitForAbsence(project))
        app.terminate(); app.launch()
        XCTAssertTrue(artifacts.waitForExistence(timeout: 15))
        XCTAssertTrue(waitForAbsence(project))
        capture("direct-offline-pending-setting")
        print("DIRECT_SYNC_RECONNECT")
        XCTAssertTrue(project.waitForExistence(timeout: 120))
        capture("direct-reconnected-home")
        let happy = app.descendants(matching: .any)["stem-row:space:Chief of Staff"]
        XCTAssertTrue(happy.waitForExistence(timeout: 10))
        happy.tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 15))
        capture("direct-conversation")
    }

    private func waitForAbsence(_ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}