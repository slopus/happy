import ObjectiveC
import XCTest

/// Home's stories in the header, over the harness's own computer (`-screen
/// stories`), as Telegram's chat list has them: open under the header while
/// something is unseen, closed into the title by scrolling the list, opened
/// again by pulling it down or tapping the avatars, and closed on their own
/// once everything is seen. `stories-probe` reports `header=open|closed`.
@MainActor
final class StoriesHeaderUITests: XCTestCase {
    private let app = XCUIApplication()

    /// The header's blurs are paused animations: waiting for the app to
    /// idle would wait forever, so the test doesn't.
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
        XCTAssertTrue(Self.skipsQuiescence)
        app.launchArguments = ["-screen", "stories", "-storiesShowScale", "1", "-storiesBlur"]
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

    private func drag(from y0: CGFloat, to y1: CGFloat, hold: TimeInterval = 0.3) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y0))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y1)), withVelocity: .slow, thenHoldForDuration: hold)
    }

    func testHeaderOpensAndCloses() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8))
        // Something unseen: open under the header.
        wait("header", "open", "unseen stories didn't open the row")
        XCTAssertFalse(element("stories-collapsed").isHittable)
        pause(0.5)
        capture("header-open")

        // Scrolling the list up closes the row into the title.
        drag(from: 0.7, to: 0.4)
        wait("header", "closed", "scrolling up didn't close the row")
        XCTAssertTrue(probe.contains("headerClose"), "closing under the finger plays no haptic: \(probe)")
        pause(0.6)
        capture("header-closed")
        let titleClosed = field("title")

        // Back at the top, pulling the list down past 65 opens it again,
        // with a tap of feedback; a pull from further down doesn't.
        drag(from: 0.3, to: 0.7)
        wait("header", "closed", "a pull that began down the list opened the row")
        drag(from: 0.3, to: 0.6, hold: 0.6)
        wait("header", "open", "pulling down didn't open the row")
        XCTAssertTrue(probe.contains("headerOpen"), probe)
        pause(0.6)
        capture("header-reopened")
        XCTAssertNotEqual(field("title"), titleClosed, "the title stayed beside the avatars")

        // Closed again, the avatars by the title open it.
        drag(from: 0.7, to: 0.4)
        wait("header", "closed")
        pause(0.5)
        let collapsed = element("stories-collapsed")
        XCTAssertTrue(collapsed.isHittable)
        XCTAssertTrue((collapsed.label).contains("Steve"), collapsed.label)
        collapsed.tap()
        wait("header", "open", "tapping the avatars didn't open the row")
        pause(0.6)
        capture("header-tapped-open")
    }

    /// Seeing everyone's stories closes the row once the viewer is gone.
    func testSeeingEverythingCloses() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8))
        wait("header", "open")
        // Steve's, then Ana's, to the end, where the viewer closes.
        steve.tap()
        wait("viewer", "1")
        for _ in 0..<12 where field("viewer") == "1" {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45)).tap()
            pause(0.5)
        }
        wait("viewer", "0", "the viewer stayed after the last story")
        wait("header", "closed", timeout: 8, "seeing everything didn't close the row")
        pause(0.6)
        capture("header-all-seen")
    }
}
