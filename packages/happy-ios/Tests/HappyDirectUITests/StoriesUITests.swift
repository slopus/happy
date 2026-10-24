import ObjectiveC
import XCTest

/// Stories against a real throwaway Happy Agent on this Mac, as
/// `StemCellsUITests` drives Stem Cells: a driver outside the test pairs the
/// simulator, plays the computer's side when the test prints a
/// `STORIES_STEP` line, and records the screen. Nothing here holds a
/// credential.
@MainActor
final class StoriesUITests: XCTestCase {
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
        print("StoriesUITests skips quiescence: \(Self.skipsQuiescence)")
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    /// Pairs if this simulator has no computer yet, then waits for the sidebar.
    private func home() {
        let anyRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
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

    /// Asks the driver to do `name` on the computer's side, and waits for it.
    private func step(_ name: String, wait: TimeInterval = 3) {
        print("STORIES_STEP \(name)")
        pause(wait)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// "Post it", with real inference: new work makes and presents a chart,
    /// the person says "post it", the agent drafts a story that appears
    /// inline with Post and Edit, Post turns it "Posted", and tapping it
    /// opens the viewer. Back home, My Story has it.
    func testPostIt() {
        home()
        pause(1.5)
        element("stem-new-work").tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(1)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        composer.typeText(
            "In a temporary folder, make a 1080x1350 PNG bar chart of four made-up fruit sales with python (matplotlib or Pillow, whatever you have). "
                + "Then present it to me inline with present_files. One short sentence of text is enough."
        )
        pause(0.5)
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let pictures = app.descendants(matching: .any).matching(identifier: "stem-media")
        let working = element("stem-working")
        var deadline = Date().addingTimeInterval(300)
        while Date() < deadline, pictures.count == 0 || working.exists { pause(2) }
        XCTAssertGreaterThan(pictures.count, 0, "no chart was presented")
        pause(2)
        capture("post-it-chart")

        composer.tap()
        composer.typeText("Post it")
        pause(0.5)
        app.buttons["Send"].tap()
        let inline = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "story-inline:")).firstMatch
        deadline = Date().addingTimeInterval(240)
        while Date() < deadline, !inline.exists || working.exists { pause(2) }
        XCTAssertTrue(inline.exists, "no story was drafted inline")
        pause(1)
        let post = element("story-inline-post")
        XCTAssertTrue(post.waitForExistence(timeout: 20), "the draft has no Post")
        XCTAssertTrue(element("story-inline-edit").exists, "the draft has no Edit")
        // The newest content is at the foot, just over the composer.
        for _ in 0..<6 where !post.isHittable { app.swipeUp(velocity: .slow); pause(0.6) }
        XCTAssertTrue(post.isHittable, "Post never came into view")
        pause(2)
        capture("post-it-draft")

        post.tap()
        let status = element("story-inline-status")
        expectation(for: NSPredicate(format: "label == %@", "Posted"), evaluatedWith: status)
        waitForExpectations(timeout: 20)
        XCTAssertFalse(post.isHittable, "Post stayed after posting")
        pause(1.5)
        capture("post-it-posted")

        // A posted story opens the viewer.
        // Near the canvas's foot (it ends at 0.91 of the card): its top may be under the bar.
        inline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).tap()
        XCTAssertTrue(element("story-views").waitForExistence(timeout: 6), "the posted story didn't open the viewer")
        pause(2)
        capture("post-it-viewer")
        element("story-close").tap()
        pause(1.5)

        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(element("story-circle:self").waitForExistence(timeout: 8))
        pause(2)
        capture("post-it-home")
    }

    /// My Story from the row, against the computer: a story posted there
    /// opens in the viewer grown from the circle, shows its frame with its
    /// overlays, its views, and deleting it from "more" takes it away.
    func testViewer() {
        home()
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no stories row")
        step("post-sample", wait: 5)
        mine.tap()
        let canvas = element("story-canvas")
        XCTAssertTrue(canvas.waitForExistence(timeout: 6), "the viewer never opened")
        XCTAssertTrue(element("story-views").waitForExistence(timeout: 3), "no views on my own story")
        pause(2)
        capture("viewer-my-story")

        element("story-views").tap()
        XCTAssertTrue(element("story-viewers-list").waitForExistence(timeout: 5), "no viewers list")
        pause(1.5)
        capture("viewer-views")
        app.buttons["Done"].tap()
        pause(1)

        // Delete the story shown; the viewer moves on or closes.
        let page = element("story-viewer-page")
        let before = (page.value as? String) ?? ""
        element("story-more").tap()
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 3), "no Delete in more")
        pause(0.8)
        capture("viewer-more")
        app.buttons["Delete"].firstMatch.tap()
        let confirm = app.alerts.buttons["Delete"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), "no confirmation")
        pause(0.8)
        capture("viewer-delete-confirm")
        confirm.tap()
        pause(3)
        capture("viewer-after-delete")
        let shown = (page.exists ? page.value as? String : nil) ?? "closed"
        XCTAssertNotEqual(shown, before, "the deleted story is still shown")

        // Down closes it.
        if canvas.exists {
            canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)), withVelocity: .fast, thenHoldForDuration: 0)
        }
        XCTAssertTrue(mine.waitForExistence(timeout: 5))
        pause(1.5)
        capture("viewer-closed")
    }

    /// The row above the sidebar: My Story first with its "+", a story
    /// posted on the computer gives it a ring live, and Settings' switch
    /// takes the row away and brings it back without the list jumping.
    func testRow() {
        home()
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no stories row")
        pause(1.5)
        capture("row-my-story")
        let firstRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        let rowTop = firstRow.frame.minY
        XCTAssertGreaterThan(rowTop, mine.frame.maxY, "the sidebar runs under the row")

        step("post-sample", wait: 5)
        capture("row-my-story-ring")

        // The list scrolls the row away with it, and back.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)), withVelocity: .slow, thenHoldForDuration: 0.4)
        pause(1)
        capture("row-scrolled")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)), withVelocity: .slow, thenHoldForDuration: 0.4)
        pause(1.5)

        // Off in Settings: home is as it was. On: the row returns.
        element("stem-settings-mark").tap()
        let toggle = app.switches["stem-settings-toggle:stories"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "no Stories switch")
        pause(1)
        capture("settings-stories-on")
        toggle.tap()
        pause(1.5)
        capture("settings-stories-off")
        app.swipeDown(velocity: .fast)
        pause(2)
        XCTAssertFalse(element("story-circle:self").exists, "the row stayed with Stories off")
        capture("home-stories-off")
        element("stem-settings-mark").tap()
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
        pause(1.5)
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(element("story-circle:self").waitForExistence(timeout: 8), "the row never came back")
        pause(2)
        capture("home-stories-back")
    }
}
