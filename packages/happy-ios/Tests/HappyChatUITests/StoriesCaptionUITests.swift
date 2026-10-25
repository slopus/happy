import XCTest

/// A long caption in the viewer, as Telegram's: folded to three lines with
/// "… Show more", opened in full over the darkened frame by a tap (the
/// story holds still meanwhile), scrolled, and folded by a tap outside.
@MainActor
final class StoriesCaptionUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments = ["-screen", "stories", "-storiesShowScale", "8"]
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

    func testALongCaptionOpensAndFolds() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8), "no ring for Steve")
        pause(1)
        if field("header") != "open" {
            element("stories-collapsed").tap()
            wait("header", "open")
            pause(0.6)
        }
        steve.tap()
        wait("viewer", "1", "the viewer never opened")
        // Steve's second story has the long caption.
        let more = element("story-caption-more")
        for _ in 0..<4 where !more.exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.4)).tap()
            pause(0.8)
        }
        XCTAssertTrue(more.waitForExistence(timeout: 4), "the long caption didn't fold")
        pause(1)
        capture("caption-folded")
        let position = field("position")
        more.tap()
        let open = element("story-caption-open")
        XCTAssertTrue(open.waitForExistence(timeout: 2))
        pause(1)
        capture("caption-open")
        // The story holds still while it's open.
        pause(3)
        XCTAssertEqual(field("position"), position, "the story went on under the open caption")
        element("story-caption-panel").swipeUp()
        pause(1)
        capture("caption-scrolled")
        // A tap folds it; the story stays where it was.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        pause(1)
        XCTAssertTrue(more.waitForExistence(timeout: 2), "the caption didn't fold again")
        XCTAssertEqual(field("position"), position, "folding the caption turned the story")
        capture("caption-folded-again")

        // Open again, a drag down from above the text folds it and closes the viewer.
        more.tap()
        XCTAssertTrue(element("story-caption-open").waitForExistence(timeout: 2))
        pause(0.6)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)), withVelocity: .fast, thenHoldForDuration: 0)
        wait("viewer", "0", "a drag down on the open caption didn't close the viewer")
    }
}
