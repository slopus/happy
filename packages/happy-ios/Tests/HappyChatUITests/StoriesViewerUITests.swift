import XCTest

/// The story viewer driven with a finger over the harness's own computer
/// (`-screen stories`): three authors, so the cube, reactions and the
/// heart's other emoji can be reached. `stories-probe` reports the viewer.
@MainActor
final class StoriesViewerUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        // Frames show longer than their own length, so none times out mid-gesture.
        app.launchArguments = ["-screen", "stories", "-storiesShowScale", name.contains("SomeoneElses") ? "8" : "3"]
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private var probe: String { (element("stories-probe").value as? String) ?? "" }
    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func field(_ name: String) -> String? {
        probe.split(separator: " ").first { $0.hasPrefix("\(name)=") }.map { String($0.dropFirst(name.count + 1)) }
    }

    private func wait(_ name: String, _ value: String, timeout: TimeInterval = 6, _ message: String = "") {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, field(name) != value { pause(0.1) }
        XCTAssertEqual(field(name), value, "\(message) — probe: \(probe)")
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The row starts closed into the title, as Telegram's does: its
    /// avatars there open it.
    private func openRow() {
        guard field("header") != "open" else { return }
        let collapsed = element("stories-collapsed")
        XCTAssertTrue(collapsed.waitForExistence(timeout: 6))
        collapsed.tap()
        wait("header", "open", "tapping the avatars didn't open the row")
        pause(0.6)
    }

    private func tap(_ x: CGFloat, _ y: CGFloat) {
        app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
    }

    /// Another person's stories: opened from their ring, a tap on the right
    /// goes on and on the left back, a hold pauses with the chrome hidden,
    /// the reaction bubble and the heart react, holding the heart offers
    /// other emoji, a swipe turns the cube to the next author and a drag
    /// down closes.
    /// Filmed ten times slower: the story opens out of Ana's circle and
    /// closes back into it, as Telegram's does.
    func testOpeningFromTheCircle() {
        app.terminate()
        app.launchArguments += ["-storiesSlowMotion", "10"]
        app.launch()
        let ana = element("story-circle:Ana")
        XCTAssertTrue(ana.waitForExistence(timeout: 8))
        openRow()
        pause(4)
        ana.tap()
        wait("viewer", "1", timeout: 10, "the viewer never opened")
        pause(5)
        capture("opened")
        element("story-close").tap()
        wait("viewer", "0", timeout: 10, "the viewer never closed")
        pause(5)
        capture("closed")
    }

    /// A recording's sound button, as Telegram's: on at first, off and on
    /// again by a tap; a recording without sound dims it, and a tap says so
    /// and holds the story until the next touch.
    func testVideoSound() {
        app.terminate()
        app.launchArguments += ["-storiesVideo"]
        app.launch()
        let ana = element("story-circle:Ana")
        XCTAssertTrue(ana.waitForExistence(timeout: 8))
        openRow()
        ana.tap()
        wait("viewer", "1", "the viewer never opened")
        wait("sound", "on", timeout: 8, "no sound button on a recording with sound")
        XCTAssertEqual(field("muted"), "0")
        let sound = element("story-sound")
        pause(0.5)
        capture("sound-on")
        sound.tap()
        wait("sound", "off", "a tap didn't turn the sound off")
        XCTAssertEqual(field("muted"), "1", "the player still plays its sound")
        capture("sound-off")
        sound.tap()
        wait("sound", "on", "a second tap didn't turn it on")
        XCTAssertEqual(field("muted"), "0")

        // The silent one.
        tap(0.85, 0.5)
        wait("position", "1")
        wait("sound", "silent", timeout: 8, "a recording without sound isn't marked so")
        sound.tap()
        let tooltip = element("stories-tooltip")
        XCTAssertTrue(tooltip.waitForExistence(timeout: 3), "no word that it has no sound")
        XCTAssertEqual(tooltip.label, "This video has no sound")
        wait("paused", "1", "the story ran on under the tooltip")
        pause(0.5)
        capture("no-sound")
        // The touch that puts it away goes no further: still the same frame.
        tap(0.85, 0.5)
        pause(0.5)
        XCTAssertFalse(tooltip.exists)
        XCTAssertEqual(field("position"), "1", "the touch on the tooltip turned the frame")
        wait("paused", "0")
    }

    /// A conversation's story card through its states: a draft with Post
    /// and Edit, Post spinning then "Posted" after a ring, opening the
    /// viewer, and deleted, a mark and the words where it was.
    func testCardStates() {
        app.terminate()
        app.launchArguments += ["-storiesCard", "-storiesSlowMotion", "4"]
        app.launch()
        wait("card", "draft", timeout: 10, "the card never drew the draft")
        let post = element("story-inline-post")
        XCTAssertTrue(post.waitForExistence(timeout: 4))
        pause(2)
        capture("card-draft")
        post.tap()
        wait("card", "posted", timeout: 10, "Post didn't post")
        let status = element("story-inline-status")
        XCTAssertEqual(status.label, "Posted")
        XCTAssertFalse(post.exists && post.isHittable, "Post stayed after posting")
        pause(2)
        capture("card-posted")
        element("story-inline:d1").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        wait("viewer", "1", timeout: 8, "the posted card didn't open the viewer")
        pause(3)
        element("story-close").tap()
        wait("viewer", "0", timeout: 8)
        pause(2)
        element("harness-delete-card").tap()
        wait("card", "deleted", timeout: 10, "the card didn't show the story deleted")
        XCTAssertTrue(app.staticTexts["This story was deleted"].exists)
        pause(2)
        capture("card-deleted")
    }

    func testSomeoneElsesStories() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8), "no ring for Steve")
        pause(1)
        openRow()
        capture("row")
        steve.tap()
        wait("viewer", "1", "the viewer never opened")
        wait("author", "1")
        wait("position", "0")
        pause(1.5)
        capture("steve-first")

        // The 🔥 bubble at (0.7, 0.6) of the canvas.
        let canvas = element("story-canvas")
        XCTAssertTrue(canvas.waitForExistence(timeout: 3))
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)).tap()
        wait("reaction", "🔥", "the bubble didn't react")
        // Thrown out around the bubble, as Telegram's reaction effect is.
        XCTAssertTrue(field("trail")?.contains("burst") == true, probe)
        pause(0.15)
        capture("reacted-fire-burst")
        pause(1)
        capture("reacted-fire")
        // Tapped again, the reaction goes.
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)).tap()
        wait("reaction", "nil", "the second tap didn't remove it")

        // The heart reacts with ❤️; held, it offers the others.
        element("story-heart").tap()
        wait("reaction", "❤️")
        pause(0.15)
        capture("reacted-heart-burst")
        pause(0.6)
        element("story-heart").press(forDuration: 0.6)
        XCTAssertTrue(element("story-reaction-picker").waitForExistence(timeout: 3))
        wait("paused", "1", "the picker didn't pause the story")
        pause(0.6)
        capture("reaction-picker")
        element("story-reaction:😂").tap()
        wait("reaction", "😂")
        pause(0.8)

        // Holding pauses and hides the chrome.
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(forDuration: 1.5)
        pause(0.2)
        wait("paused", "0", "the hold never let go")

        // Right goes on to Steve's second story, left back.
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45)).tap()
        wait("position", "1", "a right tap didn't go on")
        pause(1)
        capture("steve-second")
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.45)).tap()
        wait("position", "0", "a left tap didn't go back")
        pause(0.8)

        // A swipe turns the cube to Ana.
        let start = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)), withVelocity: .default, thenHoldForDuration: 0)
        wait("author", "2", "the cube didn't turn to Ana")
        pause(1.2)
        capture("ana")
        // And back.
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)), withVelocity: .default, thenHoldForDuration: 0)
        wait("author", "1", "the cube didn't turn back")
        pause(1)

        // Down closes it.
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)), withVelocity: .fast, thenHoldForDuration: 0)
        wait("viewer", "0", "a drag down didn't close it")
        pause(1)
        capture("closed")
        // Everything of Steve's seen: his ring has gone grey.
        XCTAssertFalse(steve.label.contains("new"), "Steve's ring still says new: \(steve.label)")
        let haptics = field("haptics") ?? ""
        for moment in ["open", "react", "advance"] { XCTAssertTrue(haptics.contains(moment), "no \(moment) haptic in \(haptics)") }
    }

    /// One's own story: the views count, who saw it, the link's sheet, a
    /// frame left to time out on its own, and the viewer closing after the
    /// last author.
    func testMyStory() {
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 8))
        pause(1)
        openRow()
        mine.tap()
        wait("viewer", "1")
        wait("author", "0")
        XCTAssertTrue(element("story-views").waitForExistence(timeout: 3))
        XCTAssertFalse(element("story-heart").isHittable, "my own story offers the heart")
        pause(1.2)
        capture("mine")

        element("story-views").tap()
        XCTAssertTrue(element("story-viewer:Steve Korshakov").waitForExistence(timeout: 4), "no viewers list")
        wait("paused", "1")
        pause(1)
        capture("viewers")
        // Telegram's sheet: edge to edge, down to the foot, half open, no Done.
        let sheet = element("story-viewers")
        let screen = app.windows.firstMatch.frame
        XCTAssertEqual(sheet.frame.minX, 0)
        XCTAssertEqual(sheet.frame.width, screen.width)
        XCTAssertGreaterThanOrEqual(sheet.frame.maxY, screen.maxY)
        XCTAssertEqual(sheet.frame.minY, screen.height - max(100, screen.height - 337) + 12, accuracy: 1)
        XCTAssertFalse(app.buttons["Done"].exists, "the sheet still has a Done")
        // Dragged up by its list it opens full, not scrolling the list, and
        // by its header down again to half.
        let title = element("story-viewers-title")
        element("story-viewer:Maya Okafor").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)), withVelocity: .slow, thenHoldForDuration: 0.1)
        pause(0.8)
        XCTAssertEqual(sheet.frame.minY, 72, accuracy: 1, "a drag up didn't open the sheet full")
        capture("viewers-full")
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)), withVelocity: .slow, thenHoldForDuration: 0.1)
        pause(0.8)
        XCTAssertEqual(sheet.frame.minY, screen.height - max(100, screen.height - 337) + 12, accuracy: 1, "a drag down didn't bring the sheet back to half")
        // A tap above it closes it.
        tap(0.5, 0.2)
        wait("paused", "0", "closing the list didn't resume")
        // Swiped up, as Telegram's, the story opens who has seen it too.
        let story = element("story-canvas")
        story.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)).press(forDuration: 0.05, thenDragTo: story.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(element("story-viewer:Steve Korshakov").waitForExistence(timeout: 4), "a swipe up didn't open the viewers — probe: \(probe)")
        pause(0.8)
        // A drag down closes it.
        element("story-viewers-title").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), withVelocity: .fast, thenHoldForDuration: 0)
        wait("paused", "0", "dragging the list down didn't close it")

        // The link pill at (0.5, 0.82): its sheet first, never the browser.
        let canvas = element("story-canvas")
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.82)).tap()
        XCTAssertTrue(app.buttons["Open"].waitForExistence(timeout: 3), "no link sheet — probe: \(probe)")
        wait("paused", "1")
        pause(0.8)
        capture("link-sheet")
        // iOS 26 shows no Cancel on a sheet: a tap outside it cancels.
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() } else { tap(0.5, 0.08) }
        wait("paused", "0", "cancelling the sheet didn't resume")

        // Left alone, the first frame times out into the second.
        wait("position", "1", timeout: 20, "the frame never advanced on its own")
        pause(1)
        capture("mine-second")
        // Then on to Steve, through the cube.
        wait("author", "1", timeout: 20, "the last frame didn't turn to the next author")
        pause(1)
    }
}
