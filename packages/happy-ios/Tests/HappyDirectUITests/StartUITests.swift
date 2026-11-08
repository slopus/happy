import ObjectiveC
import UIKit
import XCTest

/// The first screen on a simulator with no account and no agent connection
/// (a fresh install on a simulator of its own, never a phone with accounts):
/// Start with its slides, its ⋯ with the other ways in, Restore pushed under
/// a bar, the screen Start opens (get Happy for the computer) with the same
/// ⋯, and the scanner its Scan QR code opens with the same ways under its
/// own ⋯. Each step is
/// checked and pictured; the pictures go to the repository's
/// `.context/evidence/start` when that folder's parent exists, and are
/// attached to the result either way.
@MainActor
final class StartUITests: XCTestCase {
    private let app = XCUIApplication()

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
        print("StartUITests skips quiescence: \(Self.skipsQuiescence)")
        app.launch()
    }

    /// `.context/evidence/start` in the repository this file is in.
    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/start")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ name: String) {
        let style = UIScreen.main.traitCollection.userInterfaceStyle == .dark ? "dark" : "light"
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "\(name)-\(style)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence {
            try? shot.pngRepresentation.write(to: folder.appendingPathComponent("\(name)-\(style).png"))
        }
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    func testPreviewStartsCloudWithoutOpeningTheComputerFlow() {
        let cloud = app.buttons["start-cloud"]
        let start = app.buttons["start-button"]
        XCTAssertTrue(cloud.waitForExistence(timeout: 20), "Run on a fresh preview install with no accounts")
        XCTAssertTrue(cloud.isHittable)
        XCTAssertTrue(start.isHittable)
        XCTAssertEqual(cloud.frame.width, start.frame.width, accuracy: 1)
        capture("preview-start")

        for _ in 0..<2 {
            cloud.tap()
            let welcome = app.descendants(matching: .any)["cloud-logo"]
            XCTAssertTrue(welcome.waitForExistence(timeout: 10))
            XCTAssertFalse(app.buttons["install-desktop-scan"].exists)
            capture("preview-cloud-welcome")
            let back = app.navigationBars.buttons.element(boundBy: 0)
            XCTAssertTrue(back.waitForExistence(timeout: 5))
            back.tap()
            XCTAssertTrue(cloud.waitForExistence(timeout: 5))
            XCTAssertTrue(cloud.isHittable)
            XCTAssertFalse(app.navigationBars.firstMatch.exists)
        }

        start.tap()
        XCTAssertTrue(app.buttons["install-desktop-scan"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Open Happy on your computer"].exists)
        capture("preview-computer-path")
    }

    func testStartItsMenuRestoreAndTheScanner() {
        let start = app.buttons["start-button"]
        XCTAssertTrue(start.waitForExistence(timeout: 15), "no Start: the simulator has an account or a connection")
        XCTAssertFalse(app.navigationBars.firstMatch.exists, "the first screen has no bar")
        // Happy Cloud is as plain a way in as Start, not under ⋯.
        let cloud = app.buttons["start-cloud"]
        XCTAssertTrue(cloud.exists && cloud.isHittable, "no Happy Cloud beside Start")
        XCTAssertEqual(cloud.frame.width, start.frame.width, accuracy: 1)
        pause(1)
        capture("1-start")

        // The slides page by a swipe; the dots follow.
        let dots = app.pageIndicators["start-dots"]
        XCTAssertTrue(dots.exists, "the slides have no dots")
        XCTAssertEqual(dots.value as? String, "page 1 of 4")
        app.staticTexts["Any\u{00A0}model. Your\u{00A0}team. One\u{00A0}app."].swipeLeft()
        // Its animation has played (about 3 s) and holds its last frame.
        pause(3.5)
        XCTAssertEqual(dots.value as? String, "page 2 of 4")
        XCTAssertTrue(app.staticTexts["Natively multiplayer"].exists)
        capture("1b-start-slide-2")
        app.staticTexts["Natively multiplayer"].swipeLeft()
        pause(3.5)
        capture("1c-start-slide-3")

        // ⋯: entering a link, restoring, the server, help.
        app.buttons["start-more"].tap()
        let restore = app.buttons["Restore Happy CLI account"]
        XCTAssertTrue(restore.waitForExistence(timeout: 5))
        for title in ["Enter link manually", "Get help"] {
            XCTAssertTrue(app.buttons[title].exists, "\(title) is missing from ⋯")
        }
        // The server's row reads its subtitle too: "Happy CLI server, Default".
        XCTAssertTrue(app.buttons["Happy CLI server, Default"].exists, "Happy CLI server is missing from ⋯")
        XCTAssertFalse(app.buttons["Create account"].exists)
        pause(0.6)
        capture("2-start-menu")

        // Restore is pushed under a bar with a way back to Start.
        restore.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 5), "Restore has a bar")
        pause(1.5)
        capture("3-restore")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        pause(1)
        XCTAssertFalse(app.navigationBars.firstMatch.exists, "the bar hides again on Start")

        // Start opens the step before the scanner, under a bar, with the
        // same ⋯.
        start.tap()
        let scan = app.buttons["install-desktop-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "Start opens Open Happy on your computer")
        XCTAssertTrue(app.navigationBars.firstMatch.exists, "it has a bar")
        XCTAssertTrue(app.staticTexts["Open Happy on your computer"].exists)
        let site = app.links["install-desktop-site"]
        XCTAssertTrue(site.exists, "happy.engineering is missing")
        XCTAssertEqual(site.label, "Download from happy.engineering")
        pause(3.5)
        capture("4-install-desktop")
        app.buttons["install-desktop-more"].tap()
        XCTAssertTrue(app.buttons["Restore Happy CLI account"].waitForExistence(timeout: 5))
        for title in ["Enter link manually", "Get help"] {
            XCTAssertTrue(app.buttons[title].exists, "\(title) is missing from its ⋯")
        }
        pause(0.6)
        capture("5-install-desktop-menu")
        // Out of the menu without choosing.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
        pause(0.6)

        // Scan QR code opens the scanner; the simulator has no camera, so
        // it says so, and its ⋯ has the same ways in.
        scan.tap()
        let more = app.buttons["scanner-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 8), "the scanner has no ⋯")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for button in ["Allow", "OK"] where springboard.alerts.buttons[button].exists {
            springboard.alerts.buttons[button].tap()
        }
        pause(1)
        capture("6-scanner")
        more.tap()
        XCTAssertTrue(app.buttons["Restore Happy CLI account"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Enter link manually"].exists)
        XCTAssertTrue(app.buttons["Happy CLI server"].exists)
        pause(0.6)
        capture("7-scanner-menu")
    }
}
