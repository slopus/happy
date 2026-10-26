import ObjectiveC
import XCTest

/// The profile chosen decides home, against a real throwaway Happy Agent and
/// a local throwaway Happy server: a paired computer is Stem Cells, the
/// Happy account its sessions (here, Link Your Computer, with no input box).
/// Tapping a profile's circle in settings switches and goes home; a launch
/// opens the profile chosen last. The driver pairs the simulator; the test
/// signs a fresh Happy account up on the local server and out again.
@MainActor
final class InstanceSwitchUITests: XCTestCase {
    private let app = XCUIApplication()
    /// The local happy-server the driver runs (`.context/hs-data`).
    private static let server = "http://127.0.0.1:3077"

    private static let skipsQuiescence: Bool = {
        guard let process = NSClassFromString("XCUIApplicationProcess") else { return false }
        var replaced = false
        let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
        let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        for (name, block) in [
            ("waitForQuiescenceIncludingAnimationsIdle:", one as Any),
            ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", two as Any),
        ] {
            guard let method = class_getInstanceMethod(process, NSSelectorFromString(name)) else { continue }
            method_setImplementation(method, imp_implementationWithBlock(block))
            replaced = true
        }
        return replaced
    }()

    override func setUp() {
        continueAfterFailure = false
        print("InstanceSwitchUITests skips quiescence: \(Self.skipsQuiescence)")
        // Direct connection is an experiment, off on a fresh install.
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private var anyRow: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
    }

    /// Pairs if this simulator has no computer yet, then waits for Stem Cells.
    private func computerHome() {
        if anyRow.waitForExistence(timeout: 8) { return }
        print("STEM_PAIR_READY")
        let match = app.buttons["Emoji match"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "pairing never showed its emoji")
        pause(1.5)
        match.tap()
        XCTAssertTrue(anyRow.waitForExistence(timeout: 90))
    }

    /// A computer's home: its Stem Cells, search alone in the pill.
    private func assertComputerHome(_ message: String) {
        XCTAssertTrue(anyRow.waitForExistence(timeout: 15), message)
        XCTAssertTrue(element("stem-search").exists, "no search on the computer's home")
        XCTAssertFalse(app.buttons["Filter"].exists, "the computer's home still has a filter")
        XCTAssertFalse(app.buttons["Scan QR code"].exists)
    }

    /// The Happy account's home with no computer linked: Link Your
    /// Computer, the picture to settings, and no input box.
    private func assertAccountHome(_ message: String) {
        XCTAssertTrue(app.buttons["Scan QR code"].waitForExistence(timeout: 15), message)
        XCTAssertFalse(anyRow.exists, "the computer's rows on the account's home")
        XCTAssertTrue(element("stem-settings-mark").exists, "no way to settings from the account's home")
        XCTAssertFalse(element("home-dock-entry").exists && element("home-dock-entry").isHittable, "an input box on the link screen")
        XCTAssertFalse(element("stem-new-work").exists && element("stem-new-work").isHittable, "an input box on the link screen")
    }

    /// Scrolls until `element` is clear of the home indicator.
    private func reveal(_ element: XCUIElement) {
        for _ in 0..<4 where !element.isHittable || element.frame.maxY > app.frame.maxY - 60 { app.swipeUp(); pause(1.2) }
        // Still gliding, a tap would only stop the page.
        pause(1.5)
    }

    private func openSettings() {
        let mark = element("stem-settings-mark")
        XCTAssertTrue(mark.waitForExistence(timeout: 5), "no picture to open settings")
        mark.tap()
        XCTAssertTrue(element("stem-settings").waitForExistence(timeout: 5), "settings didn't open")
        pause(1.2)
    }

    private func profiles() -> [XCUIElement] {
        let all = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-profile:"))
        return (0..<all.count).map { element("stem-profile:\($0)") }
    }

    private func relaunch() {
        app.terminate()
        app.launch()
        pause(2)
    }

    func testSwitchingDecidesHome() {
        computerHome()
        assertComputerHome("not the computer's home at first")
        pause(1)
        capture("switch-computer-home")

        // A fresh Happy account on the local server, added from settings.
        openSettings()
        capture("switch-settings-computer")
        let add = element("stem-settings:add-account")
        if !add.isHittable { app.swipeUp(); pause(1.2) }
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        let server = app.buttons["Server"]
        XCTAssertTrue(server.waitForExistence(timeout: 5), "Welcome has no server button")
        server.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        // A run before may have left it set.
        if (field.value as? String)?.hasPrefix(Self.server) != true {
            field.tap()
            field.typeText(Self.server)
            app.buttons["Save"].firstMatch.tap()
            let confirm = app.alerts.buttons["Continue"]
            XCTAssertTrue(confirm.waitForExistence(timeout: 10), "the local server wasn't accepted")
            confirm.tap()
            pause(1.5)
        }
        if !app.buttons["Create account"].exists { app.tapBack() }
        let create = app.buttons["Create account"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()
        assertAccountHome("signing up didn't open the account's home")
        pause(1.5)
        capture("switch-account-link")

        // Its picture: every profile, the account chosen; the computer's
        // circle switches and goes home.
        openSettings()
        let circles = profiles()
        XCTAssertGreaterThanOrEqual(circles.count, 2, "settings doesn't list the computer and the account")
        XCTAssertTrue(circles.last?.isSelected == true, "the account isn't the chosen circle")
        capture("switch-settings-account")
        // The account's own pages wear the same glass bar: back, and the
        // title in a capsule, with the list scrolling under them.
        element("stem-settings:appearance").tap()
        let glassBack = app.buttons["stem-glass-back"].firstMatch
        XCTAssertTrue(glassBack.waitForExistence(timeout: 5), "Appearance has no glass back")
        XCTAssertFalse(app.navigationBars.firstMatch.exists && app.navigationBars.firstMatch.isHittable, "Appearance shows the system bar")
        pause(1)
        capture("switch-appearance")
        app.swipeUp()
        pause(1.2)
        capture("switch-appearance-scrolled")
        glassBack.tap()
        XCTAssertTrue(element("stem-settings").waitForExistence(timeout: 5), "back from Appearance didn't return to settings")
        pause(1)

        // Direct connection off: the computers leave the strip, and "+"
        // links through the relay alone; on again, they're back.
        let direct = app.switches["stem-settings-toggle:direct-connection"]
        reveal(direct)
        XCTAssertEqual(direct.value as? String, "1")
        direct.tap()
        pause(1.5)
        for _ in 0..<4 { app.swipeDown(); pause(0.4) }
        pause(1.2)
        let shownWithout = profiles().count
        XCTAssertLessThan(shownWithout, circles.count, "the computers stayed with Direct connection off")
        capture("switch-direct-off")
        element("stem-profile-add").tap()
        XCTAssertTrue(app.buttons["stem-glass-close"].waitForExistence(timeout: 5), "+ opened no sheet")
        XCTAssertTrue(app.segmentedControls["stem-link-method"].buttons["Relay"].isSelected, "+ didn't open on Relay with the experiment off")
        XCTAssertTrue(app.buttons["Scan QR code"].exists, "Relay didn't show Link Your Computer")
        pause(1)
        capture("switch-direct-off-add")
        app.buttons["stem-glass-close"].tap()
        pause(1)
        reveal(direct)
        direct.tap()
        pause(1.5)
        for _ in 0..<4 { app.swipeDown(); pause(0.4) }
        pause(1.2)
        XCTAssertEqual(profiles().count, circles.count, "the computers didn't come back")
        circles[0].tap()
        XCTAssertTrue(element("stem-settings").waitForNonExistence(timeout: 5), "tapping a circle left settings up")
        assertComputerHome("tapping the computer's circle didn't show its home")
        pause(1)
        capture("switch-to-computer")

        relaunch()
        assertComputerHome("a launch didn't keep the computer")
        capture("switch-relaunch-computer")

        openSettings()
        profiles().last?.tap()
        // A Happy account's session starts, and its home is built in its
        // language, before back goes to it.
        let tapped = Date()
        XCTAssertTrue(element("stem-settings").waitForNonExistence(timeout: 20), "tapping the account's circle left settings up")
        print("SWITCH_SECONDS \(Date().timeIntervalSince(tapped))")
        assertAccountHome("tapping the account's circle didn't show its home")
        pause(1)
        capture("switch-to-account")

        relaunch()
        assertAccountHome("a launch didn't keep the account")
        capture("switch-relaunch-account")

        // Signed out of the only Happy account: the computer, not Welcome.
        openSettings()
        let signOutRow = element("stem-settings:sign-out")
        // A tap while the page still glides only stops it.
        // Clear of the home indicator, where a tap is the system's.
        for _ in 0..<4 where !signOutRow.isHittable || signOutRow.frame.maxY > app.frame.maxY - 40 { app.swipeUp(); pause(1.2) }
        signOutRow.tap()
        let signOut = app.alerts.buttons["Sign out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 5))
        signOut.tap()
        pause(2)
        // Settings stays, on the computer now; back goes to its home.
        if element("stem-settings").exists { app.tapBack() }
        assertComputerHome("signing out didn't go back to the computer")
        capture("switch-signed-out")
    }
}

private extension XCUIElement {
    func waitForNonExistence(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, exists { Thread.sleep(forTimeInterval: 0.2) }
        return !exists
    }
}
