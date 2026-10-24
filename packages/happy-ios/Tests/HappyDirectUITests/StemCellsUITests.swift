import ObjectiveC
import XCTest

/// XCUITest waits up to a minute for the app to idle around every action,
/// and home never idles for it at launch. As the chat UI tests do, the
/// private wait is replaced where it is found (ChatScrollUITests.swift).
private let skipsQuiescence: Bool = {
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

/// Stem Cells against a real throwaway Happy Agent on this Mac. A driver
/// outside the test opens the daemon's pairing link on this simulator,
/// confirms the pairing on the daemon's side and records the screen; the
/// test is the person's finger. Nothing here holds a credential.
@MainActor
final class StemCellsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        print("StemCellsUITests skips quiescence: \(skipsQuiescence)")
        app.launch()
    }

    /// Pairs if this simulator has no computer yet, then waits for its sidebar.
    private func home() {
        let happy = row("space", "Happy")
        if happy.waitForExistence(timeout: 8) { return }
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
        XCTAssertTrue(happy.waitForExistence(timeout: 90))
    }

    private func row(_ kind: String, _ label: String) -> XCUIElement {
        app.descendants(matching: .any)["stem-row:\(kind):\(label)"]
    }

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Pairing, the sidebar in desktop's order, and folding a section.
    func testSidebar() {
        home()
        XCTAssertTrue(row("search", "Search").exists)
        XCTAssertTrue(row("create", "Create").exists)
        pause(2)
        capture("sidebar")
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
        if sections.count > 0 {
            let section = sections.element(boundBy: 0)
            section.tap()
            pause(1.5)
            capture("folded")
            section.tap()
            pause(1.5)
        }
    }

    /// New work from the dock's field: the intro at once, the composer up,
    /// a message, the agent's answer, and the row named back in the sidebar.
    func testNewWork() {
        home()
        pause(1.5)
        app.descendants(matching: .any)["stem-new-work"].tap()
        let intro = app.staticTexts["Say what it is — it’ll find its place."]
        XCTAssertTrue(intro.waitForExistence(timeout: 3))
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        pause(1.5)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        capture("new-work-intro")
        composer.typeText("Write a four-line poem about a pineapple that wants to be a cactus. No tools, just answer.")
        pause(1)
        app.buttons["Send"].tap()
        // The simulator's first keyboard explains swipe typing once.
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        let working = app.descendants(matching: .any)["stem-working"]
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        XCTAssertGreaterThanOrEqual(messages.count, 2, "the agent never answered")
        pause(2)
        capture("new-work-answered")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(4)
        capture("sidebar-after-new-work")
    }

    /// Happy's own conversation opens from its row and stays selected.
    func testOpenHappy() {
        home()
        pause(1)
        row("space", "Happy").tap()
        pause(4)
        capture("happy-chat")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(2)
        capture("happy-selected")
    }

    /// Renaming a task from its row's menu: the new name shows at once and stays.
    func testRename() {
        home()
        let tasks = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:Reply with"))
        XCTAssertGreaterThan(tasks.count, 0)
        let task = tasks.element(boundBy: 0)
        pause(1)
        task.press(forDuration: 1.0)
        let rename = app.buttons["Rename task"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3))
        pause(1)
        capture("row-menu")
        rename.tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.buttons["Clear text"].firstMatch.tap()
        field.typeText("Renamed on the phone")
        pause(0.5)
        app.alerts.buttons["Save"].tap()
        let renamed = row("space", "Renamed on the phone")
        XCTAssertTrue(renamed.waitForExistence(timeout: 2))
        pause(4)
        XCTAssertTrue(renamed.exists, "the name went back")
        capture("renamed")
    }

    /// Search over every row.
    func testSearch() {
        home()
        row("search", "Search").tap()
        pause(1)
        app.typeText("happy")
        pause(2)
        capture("search")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)
    }
}
