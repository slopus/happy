import ObjectiveC
import XCTest

/// Home's sidebar (`SidebarRows`: Bots, Tasks, Projects), against a
/// throwaway Happy Agent; a driver outside the test pairs the simulator
/// when the test prints `CLASSIC_STEP <step>`, and records the screen. `CLASSIC_BUNDLE` names
/// the installed app to drive (the preview build by default).
@MainActor
final class ClassicSidebarUITests: XCTestCase {
    private lazy var app = XCUIApplication(bundleIdentifier: ProcessInfo.processInfo.environment["CLASSIC_BUNDLE"] ?? "com.slopus.happy.preview")

    override func setUp() {
        continueAfterFailure = false
        _ = Self.skipsQuiescence
    }

    /// Pairs the simulator, the driver playing the computer's side.
    func testPair() {
        app.launch()
        print("CLASSIC_STEP pair")
        let match = app.buttons["Emoji match"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "no pairing came")
        match.tap()
        XCTAssertTrue(row("space", "Artifacts").waitForExistence(timeout: 60), "no classic home after pairing")
    }

    /// The demo the video records: the list, with no section titles, and
    /// a relaunch that paints it at once.
    func testDemo() {
        app.launch()
        let classic = row("space", "Artifacts")
        XCTAssertTrue(classic.waitForExistence(timeout: 30), "no classic home")
        pause(2)
        print("CLASSIC_STEP classic")

        XCTAssertFalse(row("section", "Bots").exists, "a section has a title")
        XCTAssertTrue(row("space", "Research Assistant").exists)

        // Relaunched: the list from the first frame.
        app.terminate()
        pause(1)
        print("CLASSIC_STEP relaunch")
        app.launch()
        let launched = Date()
        XCTAssertTrue(classic.waitForExistence(timeout: 3), "the classic list didn't paint at launch")
        print("CLASSIC_LAUNCH classic after \(Int(Date().timeIntervalSince(launched) * 1000)) ms")
        pause(3)
        print("CLASSIC_STEP done")
    }

    // MARK: Helpers

    private func row(_ kind: String, _ label: String) -> XCUIElement {
        app.descendants(matching: .any)["row:\(kind):\(label)"]
    }

    private func pause(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    /// Home never idles for XCUITest's wait around every action; as the
    /// other direct UI tests do, the private wait goes.
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
}
