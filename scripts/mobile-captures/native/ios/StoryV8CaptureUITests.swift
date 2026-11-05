import XCTest

/// The v8 story stills and hero recording for iPhone, iPad and iPhone Duo.
/// STORY_ORIENT=landscape turns an iPad sideways. Each state is announced with
/// "V8_CAPTURE <name>" and held for STORY_HOLD seconds, so a host-side
/// `simctl io --display=N screenshot` can take the Duo's inner display, which
/// XCUIScreen.main does not see.
@MainActor
final class StoryV8CaptureUITests: XCTestCase {
    private let app = XCUIApplication()
    private let env = ProcessInfo.processInfo.environment
    private var orientation: UIDeviceOrientation { env["STORY_ORIENT"] == "landscape" ? .landscapeLeft : .portrait }
    private var hold: TimeInterval { TimeInterval(env["STORY_HOLD"] ?? "") ?? 2.5 }

    private func launch(_ extra: [String] = [], settle: TimeInterval = 6) {
        XCUIDevice.shared.orientation = orientation
        app.launchArguments = ["-screen", "story"] + extra
        app.launch()
        XCUIDevice.shared.orientation = orientation
        Thread.sleep(forTimeInterval: settle)
    }
    private func capture(_ name: String) {
        print("V8_CAPTURE \(name)")
        Thread.sleep(forTimeInterval: hold)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
        print("STORY_CAPTURE \(name)")
    }

    func testStills() {
        _ = skipsQuiescence
        continueAfterFailure = true
        launch()
        XCTAssertTrue(app.buttons["account-switcher"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        capture("01-home")
        app.buttons["account-switcher"].tap()
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        capture("04-servers")

        launch(["-openFeed"])
        Thread.sleep(forTimeInterval: 2)
        capture("02-feed")

        launch(["-openChat"])
        Thread.sleep(forTimeInterval: 2)
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model: '")).firstMatch
        if model.waitForExistence(timeout: 5) {
            model.tap(); Thread.sleep(forTimeInterval: 2)
            capture("03-new-picker")
            let heading = app.buttons["picker-heading:codex"]
            if heading.waitForExistence(timeout: 3) { heading.tap(); Thread.sleep(forTimeInterval: 1.5) }
            capture("03-model-accounts")
        }
        launch(["-openChat", "-question", "-callFirst"])
        Thread.sleep(forTimeInterval: 5)
        capture("05-voice-callfirst")
        // Short screens open the call scrolled to the end, cutting the chart. Pull the
        // transcript back in slow element-relative drags (no momentum), keeping each step.
        let lists = [app.collectionViews.firstMatch, app.tables.firstMatch, app.scrollViews.firstMatch]
        let list = lists.first { $0.exists } ?? app.windows.firstMatch
        for step in 1...3 {
            let from = list.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.35))
            let to = list.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: step == 3 ? 0.75 : 0.55))
            from.press(forDuration: 0.1, thenDragTo: to, withVelocity: 300, thenHoldForDuration: 0.6)
            Thread.sleep(forTimeInterval: 1)
            capture("05-voice-up\(step)")
        }
    }

    func testHeroVideo() {
        _ = skipsQuiescence
        continueAfterFailure = true
        launch(["-video"], settle: 7)
        print("STORY_VIDEO_BEGIN 01-hero")
        Thread.sleep(forTimeInterval: 18)
        print("STORY_VIDEO_END 01-hero")
        capture("01-hero-end")
    }
}
