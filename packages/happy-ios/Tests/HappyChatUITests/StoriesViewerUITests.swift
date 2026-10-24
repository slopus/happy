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

    private func tap(_ x: CGFloat, _ y: CGFloat) {
        app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
    }

    /// Another person's stories: opened from their ring, a tap on the right
    /// goes on and on the left back, a hold pauses with the chrome hidden,
    /// the reaction bubble and the heart react, holding the heart offers
    /// other emoji, a swipe turns the cube to the next author and a drag
    /// down closes.
    func testSomeoneElsesStories() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8), "no ring for Steve")
        pause(1)
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
        pause(1)
        capture("reacted-fire")
        // Tapped again, the reaction goes.
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)).tap()
        wait("reaction", "nil", "the second tap didn't remove it")

        // The heart reacts with ❤️; held, it offers the others.
        element("story-heart").tap()
        wait("reaction", "❤️")
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
        app.buttons["Done"].tap()
        wait("paused", "0", "closing the list didn't resume")

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
