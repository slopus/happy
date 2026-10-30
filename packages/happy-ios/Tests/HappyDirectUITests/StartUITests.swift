import ObjectiveC
import UIKit
import XCTest

/// The first screen on a simulator with no account and no agent connection
/// (a fresh install on a simulator of its own, never a phone with accounts):
/// Start, its ⋯ with the other ways in, Restore pushed under a bar, and the
/// scanner Start opens with the same ways under its own ⋯. Each step is
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

    func testStartItsMenuRestoreAndTheScanner() {
        let start = app.buttons["start-button"]
        XCTAssertTrue(start.waitForExistence(timeout: 15), "no Start: the simulator has an account or a connection")
        XCTAssertFalse(app.navigationBars.firstMatch.exists, "the first screen has no bar")
        pause(1)
        capture("1-start")

        // ⋯: entering a link, restoring, the server, help.
        app.buttons["start-more"].tap()
        let restore = app.buttons["Restore existing account"]
        XCTAssertTrue(restore.waitForExistence(timeout: 5))
        for title in ["Enter link manually", "Get help"] {
            XCTAssertTrue(app.buttons[title].exists, "\(title) is missing from ⋯")
        }
        // The server's row reads its subtitle too: "Server, Default".
        XCTAssertTrue(app.buttons["Server, Default"].exists, "Server is missing from ⋯")
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

        // Start opens the scanner; the simulator has no camera, so it says
        // so, and its ⋯ has the same ways in.
        start.tap()
        let more = app.buttons["scanner-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 8), "the scanner has no ⋯")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for button in ["Allow", "OK"] where springboard.alerts.buttons[button].exists {
            springboard.alerts.buttons[button].tap()
        }
        pause(1)
        capture("4-scanner")
        more.tap()
        XCTAssertTrue(app.buttons["Restore existing account"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Enter link manually"].exists)
        XCTAssertTrue(app.buttons["Server"].exists)
        pause(0.6)
        capture("5-scanner-menu")
    }
}
