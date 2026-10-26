import ObjectiveC
import XCTest

/// Home's stories in the header, over the harness's own computer (`-screen
/// stories`), as Telegram's chat list has them: opened by pulling the list
/// down or tapping the avatars, put away by a short flick up and kept away
/// when new stories come, and closed on their own once everything is seen.
/// The harness starts them put away long ago, closed at launch, but for the
/// test of how home starts. `stories-probe` reports `header=open|closed`.
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

    /// A quick, short flick up, as a thumb puts something away.
    private func flick(from y0: CGFloat, to y1: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y0))
        start.press(forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y1)), withVelocity: .fast, thenHoldForDuration: 0)
    }

    func testHeaderOpensAndCloses() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8))
        // As Telegram's chat list starts: closed into the title, unseen
        // stories or not, the avatars by the title saying who.
        wait("header", "closed", "the row opened on its own at launch")
        pause(1)
        XCTAssertEqual(field("header"), "closed", "the row opened on its own at launch")
        let collapsed = element("stories-collapsed")
        XCTAssertTrue(collapsed.isHittable)
        XCTAssertTrue(collapsed.label.contains("Steve"), collapsed.label)
        capture("header-launch")
        let titleClosed = field("title")

        // Pulling the list down past 65 opens it, with a tap of feedback.
        drag(from: 0.3, to: 0.6, hold: 0.6)
        wait("header", "open", "pulling down didn't open the row")
        XCTAssertTrue(probe.contains("headerOpen"), probe)
        XCTAssertNotEqual(field("title"), titleClosed, "the title stayed beside the avatars")
        pause(0.6)
        capture("header-open")

        // A short flick up puts it away, unseen stories and all.
        flick(from: 0.6, to: 0.54)
        wait("header", "closed", "a short flick up left the row open")
        XCTAssertTrue(probe.contains("headerClose"), "closing under the finger plays no haptic: \(probe)")
        pause(1)
        capture("header-flicked")

        // And it stays away: a new story arriving doesn't open it, nor does
        // the list gliding back to its top, nor a pull from further down.
        element("harness-new-story").tap()
        wait("stories", "5", "the new story never arrived")
        pause(1.5)
        XCTAssertEqual(field("header"), "closed", "a new story opened the row")
        drag(from: 0.7, to: 0.4)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).press(forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)), withVelocity: .fast, thenHoldForDuration: 0)
        pause(3)
        XCTAssertEqual(field("header"), "closed", "the list coming back to its top opened the row")
        capture("header-stays-closed")

        // A deliberate pull, begun with the list at rest at its top, opens
        // it again (as in Telegram, one begun mid-glide doesn't).
        drag(from: 0.3, to: 0.6, hold: 0.6)
        wait("header", "open", "pulling down didn't open the row again")
        pause(0.6)
        capture("header-reopened")

        // Scrolled away, the avatars by the title open it.
        drag(from: 0.7, to: 0.4)
        wait("header", "closed")
        pause(0.5)
        XCTAssertTrue(collapsed.isHittable)
        collapsed.tap()
        wait("header", "open", "tapping the avatars didn't open the row")
        pause(0.6)
        capture("header-tapped-open")
    }

    /// Never put away, home starts with the row open; put away, it stays
    /// away across a launch, and a launch with a story posted since opens it.
    func testStartsOpenUntilPutAway() {
        let epoch = String(Int64(Date().timeIntervalSince1970 * 1000))
        let base = ["-screen", "stories", "-storiesShowScale", "1", "-storiesBlur", "-storiesEpoch", epoch]
        func relaunch(_ flags: [String]) {
            app.terminate()
            app.launchArguments = base + flags
            app.launch()
            XCTAssertTrue(element("story-circle:Steve").waitForExistence(timeout: 8))
        }

        relaunch(["-storiesFresh"])
        wait("header", "open", "unseen stories, never put away, and the row started closed")
        XCTAssertTrue(element("story-circle:Steve").isHittable)
        XCTAssertFalse(probe.contains("headerOpen"), "opening at launch played a haptic: \(probe)")
        pause(0.8)
        capture("launch-open")

        flick(from: 0.6, to: 0.54)
        wait("header", "closed", "a short flick up left the row open")
        pause(0.6)

        relaunch(["-storiesKept"])
        pause(2)
        XCTAssertEqual(field("header"), "closed", "put away, the row opened again at launch")
        capture("launch-kept-closed")

        relaunch(["-storiesKept", "-storiesNewer"])
        wait("header", "open", "a story posted since didn't open the row at launch")
        pause(0.8)
        capture("launch-newer-open")

        // Opened by the person, it is no longer put away.
        flick(from: 0.6, to: 0.54)
        wait("header", "closed")
        element("stories-collapsed").tap()
        wait("header", "open")
        relaunch(["-storiesKept"])
        wait("header", "open", "opened again by the person, the row started closed")
    }

    /// Seeing everyone's stories closes the row once the viewer is gone.
    func testSeeingEverythingCloses() {
        let steve = element("story-circle:Steve")
        XCTAssertTrue(steve.waitForExistence(timeout: 8))
        wait("header", "closed")
        element("stories-collapsed").tap()
        wait("header", "open")
        pause(0.6)
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

    /// Over a slow link, a tapped circle's ring turns to dashes while the
    /// story it opens on loads, and the viewer opens once it's here.
    func testLoadingRing() {
        app.terminate()
        app.launchArguments.append("-storiesSlowFrames")
        app.launch()
        let ana = element("story-circle:Ana")
        XCTAssertTrue(ana.waitForExistence(timeout: 8))
        element("stories-collapsed").tap()
        wait("header", "open")
        pause(0.6)
        ana.tap()
        let deadline = Date().addingTimeInterval(1.2)
        while Date() < deadline, (ana.value as? String) != "loading" { pause(0.05) }
        XCTAssertEqual(ana.value as? String, "loading", "no loading ring while the story loads")
        XCTAssertEqual(field("viewer"), "0", "the viewer opened before its picture")
        capture("loading-ring")
        wait("viewer", "1", timeout: 6, "the viewer never opened after loading")
    }

    /// Telegram's one-time tip under the closed avatars: a second after the
    /// stories come, naming who has them; the first touch puts it away and
    /// goes on through, and it never comes back.
    func testTooltip() {
        app.terminate()
        app.launchArguments.append("-storiesTooltip")
        app.launch()
        let tooltip = element("stories-tooltip")
        XCTAssertTrue(tooltip.waitForExistence(timeout: 6), "no tooltip under the avatars")
        XCTAssertEqual(tooltip.label, "Tap above to view stories from Steve and Ana")
        let collapsed = element("stories-collapsed")
        XCTAssertEqual(field("header"), "closed")
        XCTAssertGreaterThan(tooltip.frame.minY, collapsed.frame.maxY, "the tooltip isn't under the avatars")
        pause(0.6)
        capture("tooltip")

        // Any touch puts it away, one on the header's buttons too.
        app.buttons["Search"].firstMatch.tap()
        pause(0.5)
        XCTAssertFalse(tooltip.exists, "the tooltip stayed after a touch on the header")
        XCTAssertEqual(field("header"), "closed")
        collapsed.tap()
        wait("header", "open", "the tap on the avatars didn't reach them")
        pause(0.5)

        // Closed again, with a new story come: no tooltip a second time.
        flick(from: 0.6, to: 0.54)
        wait("header", "closed")
        element("harness-new-story").tap()
        wait("stories", "5", "the new story never arrived")
        pause(2)
        XCTAssertFalse(tooltip.exists, "the tooltip came back")
    }

    /// Put away while its story loads, the row opens no viewer after all.
    func testClosingStopsLoading() {
        app.terminate()
        app.launchArguments.append("-storiesSlowFrames")
        app.launch()
        let ana = element("story-circle:Ana")
        XCTAssertTrue(ana.waitForExistence(timeout: 8))
        element("stories-collapsed").tap()
        wait("header", "open")
        pause(0.6)
        ana.tap()
        flick(from: 0.6, to: 0.54)
        wait("header", "closed", "a short flick up left the row open")
        pause(2.5)
        XCTAssertEqual(field("viewer"), "0", "the viewer opened over the closed row")
        XCTAssertNotEqual(ana.value as? String, "loading", "the ring kept turning on the closed row")
        element("stories-collapsed").tap()
        wait("header", "open")
        pause(0.6)
        ana.tap()
        wait("viewer", "1", timeout: 6, "the row wouldn't open a story after a stopped one")
    }
}
