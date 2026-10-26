import ObjectiveC
import XCTest

/// Stem Cells settings and adding a computer, against a real throwaway
/// Happy Agent. Settings is a push from home's picture, left by its back
/// button or the edge swipe; every row opens what it says; "+" is the link
/// sheet, whose relay button pushes the old way in and comes back, which a
/// swipe down ends, and whose pasted link pairs a computer. The driver
/// pairs the simulator first (STEM_PAIR_READY) and writes the link to paste
/// (STEM_STEP pair-link).
@MainActor
final class SettingsUITests: XCTestCase {
    private let app = XCUIApplication()
    /// Where the driver writes the link to paste (`.context/steps/pair-link.sh`).
    private static let pairLink = "/Users/kirilldubovitskiy/Happy/Workspaces/happy/ios-settings-rework/.context/pair-link.txt"

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
        print("SettingsUITests skips quiescence: \(Self.skipsQuiescence)")
        // Direct connection is an experiment, off on a fresh install; only
        // the test of that leaves it off.
        app.launchEnvironment["STEM_DIRECT"] = name.contains("Experiment") ? "0" : "1"
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

    /// The emoji check, from the phone's side, once the pairing screen is up.
    private func matchEmoji() {
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
    }

    /// Pairs if this simulator has no computer yet (from the first screen,
    /// which is the link screen), then waits for Stem Cells.
    private func computerHome() {
        if anyRow.waitForExistence(timeout: 8) { return }
        XCTAssertTrue(element("stem-link").waitForExistence(timeout: 5), "the first screen isn't the link screen")
        XCTAssertFalse(element("stem-glass-close").exists, "the first screen has a close button")
        capture("settings-first-run")
        print("STEM_PAIR_READY")
        matchEmoji()
        XCTAssertTrue(anyRow.waitForExistence(timeout: 90))
    }

    private func openSettings() {
        let mark = element("stem-settings-mark")
        XCTAssertTrue(mark.waitForExistence(timeout: 5), "no picture to open settings")
        mark.tap()
        XCTAssertTrue(element("stem-settings").waitForExistence(timeout: 5), "settings didn't open")
        pause(1)
    }

    private var back: XCUIElement { app.buttons["stem-glass-back"].firstMatch }

    private func goBack(_ message: String) {
        XCTAssertTrue(back.waitForExistence(timeout: 5), "no back button: \(message)")
        back.tap()
        pause(0.8)
    }

    private func swipeBack() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)),
            withVelocity: .fast, thenHoldForDuration: 0)
        pause(1)
    }

    private func swipeDown() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)),
            withVelocity: .fast, thenHoldForDuration: 0)
        pause(1.2)
    }

    private func row(_ id: String) -> XCUIElement {
        let row = element("stem-settings:\(id)")
        _ = row.waitForExistence(timeout: 3)
        // Clear of the home indicator, where a tap is the system's.
        for _ in 0..<4 where !row.isHittable || row.frame.maxY > app.frame.maxY - 40 {
            app.swipeUp()
            // A tap while it still glides only stops it.
            pause(1.2)
        }
        return row
    }

    private func scrollToTop() {
        for _ in 0..<3 { app.swipeDown() }
    }

    /// A row that opens a page of its own, which back leaves.
    private func assertPushes(_ id: String, _ name: String) {
        row(id).tap()
        XCTAssertTrue(waitGone(element("stem-settings"), 5), "\(id) didn't open \(name)")
        pause(0.6)
        capture("settings-row-\(id)")
        goBack("from \(name)")
        XCTAssertTrue(element("stem-settings").waitForExistence(timeout: 5), "back from \(name) didn't return to settings")
    }

    /// A row that opens a link: Safari comes up, and the app comes back.
    private func assertOpensLink(_ id: String) {
        row(id).tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 10), "\(id) opened nothing")
        app.activate()
        XCTAssertTrue(element("stem-settings").waitForExistence(timeout: 5))
        pause(0.5)
    }

    /// The link screen's switch: Relay or Direct.
    private func method(_ name: String) -> XCUIElement {
        app.segmentedControls["stem-link-method"].buttons[name]
    }

    /// Direct connection is an experiment, off on a fresh install (the
    /// driver installs afresh, `FRESH=1`): the first screen's switch is on
    /// Relay, showing Welcome with no way to pair a computer directly; its
    /// gear holds the experiment's switch, off. Direct shows the computer's
    /// code and link, and Relay Welcome again. A computer's link from
    /// outside says it is an experiment and offers to turn it on, which
    /// pairs it and opens its home; turning it off in Settings hides the
    /// computer again: the first screen, on Relay.
    func testDirectConnectionIsAnExperiment() {
        XCTAssertTrue(element("stem-link").waitForExistence(timeout: 15), "a fresh install doesn't open on the link screen")
        XCTAssertTrue(method("Relay").isSelected, "the switch isn't on Relay at first")
        XCTAssertTrue(app.buttons["Create account"].exists, "Relay doesn't show Welcome")
        XCTAssertFalse(app.buttons["Pair computer"].exists, "Welcome offers direct pairing with the experiment off")
        XCTAssertFalse(element("stem-link-paste").exists, "Direct's way shows on Relay")
        pause(1)
        capture("experiment-off-welcome")

        // The gear: the server, and the experiment's switch, off.
        app.buttons["stem-link-settings"].tap()
        let gearToggle = app.switches["stem-settings-toggle:direct-connection"]
        XCTAssertTrue(gearToggle.waitForExistence(timeout: 5), "the gear has no Direct connection switch")
        XCTAssertEqual(gearToggle.value as? String, "0")
        pause(1)
        capture("experiment-gear")
        goBack("the gear's settings")

        // Direct: the code and the link, in place; Relay: Welcome again.
        method("Direct").tap()
        XCTAssertTrue(element("stem-link-paste").waitForExistence(timeout: 3), "Direct shows no paste link")
        XCTAssertTrue(app.buttons["Scan QR code"].exists, "Direct shows no scan")
        pause(1)
        capture("experiment-direct")
        method("Relay").tap()
        XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 3), "back on Relay, no Welcome")
        pause(1)

        // A computer's link, from outside: it says it is an experiment.
        print("STEM_STEP direct-link")
        let turnOn = app.alerts.buttons["Turn on"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !turnOn.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = turnOn.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(turnOn.exists, "a direct link didn't offer to turn the experiment on")
        pause(1)
        capture("experiment-off-link")
        turnOn.tap()
        matchEmoji()
        XCTAssertTrue(anyRow.waitForExistence(timeout: 90), "turning it on and pairing didn't open the computer")
        pause(2)
        capture("experiment-on-home")

        // On, in the computer's settings; off hides it, and Welcome opens.
        element("stem-settings-mark").tap()
        let toggle = app.switches["stem-settings-toggle:direct-connection"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "no Direct connection switch")
        if !toggle.isHittable { app.swipeUp(); pause(1.2) }
        XCTAssertEqual(toggle.value as? String, "1")
        capture("experiment-on-settings")
        toggle.tap()
        XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 10), "turning it off didn't hide the computer")
        XCTAssertTrue(method("Relay").isSelected, "the switch isn't back on Relay")
        XCTAssertFalse(app.buttons["Pair computer"].exists)
        pause(1)
        capture("experiment-off-again")
    }

    func testSettings() {
        computerHome()
        pause(1)
        capture("settings-home")

        // A push, left by its back button: no sheet.
        openSettings()
        XCTAssertTrue(back.exists, "settings has no back button")
        XCTAssertTrue(app.buttons["stem-settings-search"].exists, "no search in the bar")
        XCTAssertTrue(app.buttons["stem-settings-qr"].exists, "no QR button in the bar")
        XCTAssertFalse(app.buttons["stem-settings-edit"].exists, "Edit is still in the bar")
        XCTAssertGreaterThan(app.buttons["stem-settings-qr"].frame.minX, app.buttons["stem-settings-search"].frame.minX, "QR isn't right of search")
        XCTAssertFalse(element("stem-settings:more").exists, "settings still has More")
        capture("settings-computer")
        goBack("settings")
        XCTAssertTrue(anyRow.waitForExistence(timeout: 5), "back didn't go home")
        XCTAssertFalse(element("stem-settings").exists)

        // And by the edge swipe.
        openSettings()
        swipeBack()
        XCTAssertTrue(anyRow.waitForExistence(timeout: 5), "the edge swipe didn't go home")
        XCTAssertFalse(element("stem-settings").exists, "the edge swipe left settings up")

        // Every row of the computer's page.
        openSettings()
        let name = element("stem-settings-name")
        let before = name.label
        row("edit-name").tap()
        let field = app.textFields["stem-settings-rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3), "Edit name didn't open the field")
        let renamed = before == "Settings Mac" ? "Settings Studio" : "Settings Mac"
        field.typeText(renamed + "\n")
        XCTAssertTrue(element("stem-settings-name").waitForExistence(timeout: 3))
        XCTAssertEqual(element("stem-settings-name").label, renamed, "the name didn't change")
        // The name itself starts it too.
        element("stem-settings-name").tap()
        XCTAssertTrue(field.waitForExistence(timeout: 3), "tapping the name didn't open the field")
        capture("settings-rename")
        field.typeText("\n")
        pause(0.5)
        XCTAssertTrue(element("stem-settings:status").exists, "no status row")

        let prioritizing = app.switches["stem-settings-toggle:prioritizing"]
        XCTAssertTrue(prioritizing.waitForExistence(timeout: 10), "no Prioritizing switch")
        let was = prioritizing.value as? String
        prioritizing.tap()
        pause(1)
        XCTAssertNotEqual(prioritizing.value as? String, was, "Prioritizing didn't switch")
        prioritizing.tap()
        pause(1)

        // Theme goes round (the keyboard has shown: its window must not
        // cover the screen once the style changes): Adaptive, Light, Dark.
        let theme = row("theme")
        for _ in 0..<3 where !theme.label.contains("Dark") {
            theme.tap()
            pause(0.8)
        }
        XCTAssertTrue(theme.label.contains("Dark"), "the theme never reached Dark")
        capture("settings-dark")
        theme.tap()
        pause(0.8)
        XCTAssertTrue(theme.label.contains("Adaptive"), "the theme didn't go round to Adaptive")

        row("add-account").tap()
        XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5), "Add Happy account didn't open Welcome")
        XCTAssertFalse(app.buttons["Pair computer"].exists, "Welcome offers pairing over settings")
        capture("settings-row-add-account")
        goBack("Welcome")

        assertPushes("whats-new", "What's new")
        for link in ["github-repo", "report-issue", "privacy", "terms", "eula"] { assertOpensLink(link) }
        XCTAssertTrue(row("version").exists, "no version row")
        XCTAssertTrue(row("disconnect").exists, "no Disconnect")
        scrollToTop()

        // Search finds a row.
        app.buttons["stem-settings-search"].tap()
        XCTAssertTrue(element("stem-settings-search-field").waitForExistence(timeout: 3), "search opened no field")
        app.typeText("Theme")
        XCTAssertTrue(element("stem-settings:theme").waitForExistence(timeout: 3), "search didn't find Theme")
        capture("settings-search")
        app.buttons["Cancel"].tap()
        pause(0.8)
        XCTAssertTrue(back.waitForExistence(timeout: 3), "the bar didn't come back after search")

        // The QR button: scan or paste a code.
        app.buttons["stem-settings-qr"].tap()
        XCTAssertTrue(element("stem-qr").waitForExistence(timeout: 3), "QR didn't open")
        capture("settings-qr")
        element("stem-qr-close").tap()
        pause(0.8)

        // "+": the link sheet, with nothing of a profile on it.
        element("stem-profile-add").tap()
        let link = element("stem-link")
        XCTAssertTrue(link.waitForExistence(timeout: 5), "+ didn't open the link sheet")
        pause(0.8)
        XCTAssertTrue(method("Direct").isSelected, "the experiment on, the switch isn't on Direct")
        XCTAssertTrue(app.buttons["Scan QR code"].exists)
        XCTAssertTrue(element("stem-link-paste").exists, "no paste link")
        XCTAssertFalse(element("stem-settings-mark").isHittable, "a profile picture on the link sheet")
        XCTAssertFalse(app.buttons["Server"].exists, "a server button on the link sheet")
        capture("settings-link-sheet")

        // Relay shows the old way in, in place; Direct comes back. With a
        // computer paired, Relay leaves the experiment on.
        method("Relay").tap()
        XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5), "Relay didn't show Welcome")
        XCTAssertFalse(app.buttons["stem-link-settings"].exists, "a settings gear in the link sheet")
        XCTAssertFalse(app.buttons["Pair computer"].exists, "the relay offers pairing again")
        pause(0.8)
        capture("settings-link-relay")
        method("Direct").tap()
        XCTAssertTrue(element("stem-link-paste").waitForExistence(timeout: 3), "back on Direct, no paste link")
        // Swiped down, it ends; settings is under it.
        swipeDown()
        XCTAssertFalse(link.exists, "swiping down left the link sheet up")
        XCTAssertTrue(element("stem-settings").exists, "settings went with the sheet")

        // A pasted link pairs a second profile and opens its home.
        let profiles = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-profile:")).count
        element("stem-profile-add").tap()
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        try? FileManager.default.removeItem(atPath: Self.pairLink)
        print("STEM_STEP pair-link")
        var text: String?
        for _ in 0..<60 where text == nil {
            text = (try? String(contentsOfFile: Self.pairLink, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
            if text?.isEmpty == true { text = nil }
            pause(0.5)
        }
        XCTAssertNotNil(text, "the driver wrote no link")
        element("stem-link-paste").tap()
        let paste = app.alerts.textFields.firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 3), "paste opened no field")
        paste.typeText(text ?? "")
        capture("settings-link-paste")
        app.alerts.buttons["Link"].tap()
        matchEmoji()
        XCTAssertTrue(anyRow.waitForExistence(timeout: 90), "pairing didn't land on the new computer's home")
        XCTAssertFalse(link.exists, "the link sheet stayed up after pairing")
        pause(1)
        capture("settings-paired")
        openSettings()
        let now = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-profile:")).count
        XCTAssertEqual(now, profiles + 1, "the new computer isn't a profile")
        capture("settings-two-computers")

        // A circle tapped switches and goes home.
        element("stem-profile:0").tap()
        XCTAssertTrue(anyRow.waitForExistence(timeout: 8))
        XCTAssertTrue(waitGone(element("stem-settings"), 6), "tapping a circle left settings up")
        capture("settings-switched")
    }

    private func waitGone(_ element: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, element.exists { pause(0.2) }
        return !element.exists
    }
}
