import ObjectiveC
import XCTest

/// Home follows the computer's Stem Cells setting
/// (`happy-desktop.experiments.stemCells`): off, the classic sidebar
/// (`SidebarRows`: Bots, Tasks, Projects); on, the dynamic one. Against a
/// throwaway Happy Agent; a driver outside the test pairs the simulator
/// and flips the setting through the daemon's API when the test prints
/// `CLASSIC_STEP <step>`, and records the screen. `CLASSIC_BUNDLE` names
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

    /// The demo the video records: the classic list, a reorder within
    /// Bots, a refused drag into Tasks, Stem Cells on (the dynamic
    /// sidebar, live) and off again, and a relaunch that paints the classic
    /// list at once.
    func testDemo() {
        app.launch()
        // Artifacts heads the classic list alone: the dynamic one has Bots and Tasks too.
        let classic = row("space", "Artifacts")
        XCTAssertTrue(classic.waitForExistence(timeout: 30), "no classic home")
        pause(2)
        print("CLASSIC_STEP classic")

        // Within Bots: the lower of the two bots carried above the other.
        let release = row("space", "Release Bot")
        let research = row("space", "Research Assistant")
        let (lower, upper) = research.frame.minY < release.frame.minY ? (release, research) : (research, release)
        carry(lower, to: upper, dy: 0.15)
        pause(2.5)
        XCTAssertLessThan(lower.frame.minY, upper.frame.minY, "the bot didn't land above the other")
        print("CLASSIC_STEP reordered")

        // Into Tasks: refused. The row stops at the end of Bots and lands there.
        let task = row("space", "Landing page copy")
        let tasks = row("section", "Tasks")
        // Tasks open, as a fold left over from an earlier run may not have it.
        if !task.exists { tasks.tap(); pause(1) }
        carry(lower, to: task, dy: 0.8)
        pause(2.5)
        XCTAssertLessThan(lower.frame.maxY, tasks.frame.minY, "the bot left Bots")
        print("CLASSIC_STEP refused")

        // Stem Cells on, from the computer: the dynamic sidebar, live.
        print("CLASSIC_STEP stem-on")
        XCTAssertTrue(until(20) { !classic.exists }, "home stayed classic with Stem Cells on")
        pause(4)
        print("CLASSIC_STEP dynamic")

        // Off again: back to the classic list.
        print("CLASSIC_STEP stem-off")
        XCTAssertTrue(classic.waitForExistence(timeout: 20), "home didn't go back to classic")
        pause(3)

        // Relaunched with it off: the classic list from the first frame.
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

    /// A hold, then the finger carried to `target` (`dy` down its height), slowly.
    private func carry(_ row: XCUIElement, to target: XCUIElement, dy: CGFloat) {
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 1.2, thenDragTo: target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: dy)), withVelocity: .slow, thenHoldForDuration: 0.8)
    }

    private func pause(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func until(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            pause(0.2)
        }
        return condition()
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
