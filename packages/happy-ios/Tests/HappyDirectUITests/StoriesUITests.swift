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
        // Direct connection is an experiment, off on a fresh install.
        app.launchEnvironment["STEM_DIRECT"] = "1"
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

    private func drag(from y0: CGFloat, to y1: CGFloat, hold: TimeInterval = 0.4) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y0)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y1)), withVelocity: .slow, thenHoldForDuration: hold)
    }

    /// Opens the stories under the header, as a pull on the list at its
    /// top does, unless they are open already.
    private func openStories(_ circle: XCUIElement) {
        for _ in 0..<3 where !circle.isHittable {
            drag(from: 0.3, to: 0.62)
            pause(1)
        }
        XCTAssertTrue(circle.isHittable, "pulling the list down didn't open the stories")
    }

    /// New work makes and presents a chart, and "Post it" has the agent
    /// draft a story of it inline, with Post and Edit under it.
    private func draftInConversation() -> (inline: XCUIElement, working: XCUIElement) {
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
        return (inline, working)
    }

    /// "Post it", with real inference: new work makes and presents a chart,
    /// the person says "post it", the agent drafts a story that appears
    /// inline with Post and Edit, Post turns it "Posted", and tapping it
    /// opens the viewer. Back home, My Story has it.
    func testPostIt() {
        home()
        pause(1.5)
        let (inline, working) = draftInConversation()
        let post = element("story-inline-post")
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

        app.tapBack()
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 8))
        pause(1)
        openStories(mine)
        pause(1.5)
        capture("post-it-home")
    }

    /// A story made where stories start, in a conversation, against the
    /// computer with real inference: the agent makes and presents a chart,
    /// "post it" drafts a story inline, its Edit opens the editor, the frames
    /// panel's "+" opens the library sheet (access asked for as a person
    /// sees it) and two photos picked in order become frames 2 and 3; a
    /// sticker from the test pack and text go on; Post uploads, posts and
    /// closes, and My Story in home's header opens it.
    func testEditor() {
        home()
        let (inline, _) = draftInConversation()
        let edit = element("story-inline-edit")
        for _ in 0..<6 where !edit.isHittable { app.swipeUp(velocity: .slow); pause(0.6) }
        XCTAssertTrue(edit.isHittable, "Edit never came into view")
        _ = inline
        edit.tap()
        let canvas = element("story-editor-canvas")
        XCTAssertTrue(canvas.waitForExistence(timeout: 10), "Edit didn't open the editor")
        pause(2)
        capture("editor-open")

        // Two photos from the library sheet, from the frames panel's "+".
        element("story-editor-frames").tap()
        let add = element("story-editor-add")
        XCTAssertTrue(add.waitForExistence(timeout: 3))
        pause(0.6)
        add.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let full = springboard.buttons["Allow Full Access"]
        if full.waitForExistence(timeout: 4) {
            capture("editor-library-access")
            full.tap()
        }
        let first = element("library-cell:0")
        let second = element("library-cell:1")
        XCTAssertTrue(first.waitForExistence(timeout: 8), "the library sheet never showed photos")
        pause(1)
        capture("editor-library")
        second.tap()
        first.tap()
        XCTAssertEqual(second.value as? String, "1")
        XCTAssertEqual(first.value as? String, "2")
        pause(0.8)
        capture("editor-library-picked")
        // The count shows just the picks, in the order picked, until Back.
        element("library-selected").tap()
        XCTAssertTrue(app.staticTexts["2 Selected"].waitForExistence(timeout: 3), "the count didn't show the picks")
        XCTAssertEqual(first.value as? String, "1")
        XCTAssertFalse(element("library-cell:2").exists)
        pause(0.6)
        capture("editor-library-selected")
        element("library-cancel").tap()
        XCTAssertTrue(element("library-cell:2").waitForExistence(timeout: 3), "Back didn't show everything")
        element("library-add").tap()
        XCTAssertTrue(element("story-editor-frame:2").waitForExistence(timeout: 20), "the photos didn't become frames")
        pause(2)
        capture("editor-three-frames")
        element("story-editor-frames").tap()
        pause(0.5)

        // A sticker from the test pack, by search, and text.
        element("story-tool-sticker").tap()
        let search = element("sticker-search")
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Shapes")
        let star = element("sticker:happy-test-shapes/star")
        XCTAssertTrue(star.waitForExistence(timeout: 10), "search didn't find the test pack")
        star.tap()
        pause(1.5)
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.25)), withVelocity: 500, thenHoldForDuration: 0.3)
        pause(0.5)
        element("story-tool-text").tap()
        XCTAssertTrue(element("story-text-entry").waitForExistence(timeout: 3))
        app.typeText("From the library")
        element("story-text-done").tap()
        pause(1)
        capture("editor-composed")

        element("story-editor-post").tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: canvas)
        waitForExpectations(timeout: 120)
        pause(2)
        capture("editor-posted")

        app.tapBack()
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 8), "no My Story at home")
        pause(1)
        openStories(mine)
        mine.tap()
        XCTAssertTrue(element("story-views").waitForExistence(timeout: 8), "My Story didn't open")
        pause(2)
        capture("editor-posted-viewer")
    }

    /// My Story from the row, against the computer: a story posted there
    /// opens in the viewer grown from the circle, shows its frame with its
    /// overlays, its views, and deleting it from "more" takes it away.
    func testViewer() {
        home()
        step("post-sample", wait: 5)
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no stories")
        openStories(mine)
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
        // A tap above the sheet closes it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
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
        pause(1.5)
        capture("viewer-closed")
    }

    /// The stories in home's header: nothing on home starts a story; a
    /// story posted on the computer is My Story, which opens under the
    /// header when the list is pulled down and closes into it as the list
    /// scrolls up, the sidebar keeping clear of it; Settings' switch takes
    /// the stories away, home as it was, and brings them back.
    func testRow() {
        home()
        XCTAssertFalse(app.buttons["Add story"].exists, "home still offers to start a story")
        step("post-sample", wait: 5)
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no stories")
        pause(1)
        capture("row-closed")
        openStories(mine)
        pause(1.5)
        capture("row-open")
        let firstRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        XCTAssertGreaterThan(firstRow.frame.minY, mine.frame.maxY, "the sidebar runs under the stories")

        // Scrolling the list up closes them into the header.
        drag(from: 0.65, to: 0.4)
        pause(1)
        XCTAssertFalse(mine.isHittable, "scrolling up left the stories open")
        capture("row-scrolled")
        drag(from: 0.35, to: 0.8)
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
        app.tapBack()
        pause(2)
        XCTAssertFalse(element("story-circle:self").exists, "the row stayed with Stories off")
        capture("home-stories-off")
        element("stem-settings-mark").tap()
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
        pause(1.5)
        app.tapBack()
        XCTAssertTrue(element("story-circle:self").waitForExistence(timeout: 8), "the stories never came back")
        pause(1)
        openStories(element("story-circle:self"))
        pause(1.5)
        capture("home-stories-back")
    }

    /// Put away and kept away: home starts with the stories open until the
    /// person puts them away with a short flick up; then they stay away,
    /// across launches and a story posted meanwhile, until a launch after a
    /// story posted since. Standalone, the row is the person's own stories
    /// alone, which as in Telegram leave no avatars by the title.
    func testSwipeAway() {
        home()
        step("post-sample", wait: 5)
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no stories")

        // Never put away: open at launch.
        app.terminate()
        step("forget-put-away", wait: 2)
        relaunch()
        XCTAssertTrue(mine.isHittable, "never put away, the stories started closed")
        capture("swipe-launch-open")

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.54)), withVelocity: .fast, thenHoldForDuration: 0)
        pause(1.2)
        XCTAssertFalse(mine.isHittable, "a short flick up left the stories open")
        capture("swipe-flicked")

        // Put away: still away at the next launch.
        relaunch()
        XCTAssertFalse(mine.isHittable, "put away, the stories opened again at launch")
        capture("swipe-relaunch-closed")

        // Another story is posted on the computer: still put away now…
        step("post-sample", wait: 8)
        XCTAssertFalse(mine.isHittable, "a new story opened the stories")
        capture("swipe-new-story")

        // …and open at the next launch, as it was posted since.
        relaunch()
        XCTAssertTrue(mine.isHittable, "a story posted since didn't open the stories at launch")
        capture("swipe-relaunch-open")
    }

    /// The app again from cold, waiting for home and its stories to settle.
    private func relaunch() {
        app.terminate()
        app.launch()
        home()
        XCTAssertTrue(element("story-circle:self").waitForExistence(timeout: 10), "no stories after launch")
        pause(3)
    }
}
