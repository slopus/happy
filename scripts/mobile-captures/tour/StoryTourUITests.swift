import XCTest

/// The store tour, recorded in one take between STORY_VIDEO_BEGIN and _END:
/// the team's Home at work, its server menu opened and dismissed, Activity
/// and back, Product Health's chat with the model picker and an account
/// switch, a question answered with a chart, then a call.
/// Each beat is announced as "TOUR_BEAT <name>" for the edit.
@MainActor
final class StoryTourUITests: XCTestCase {
    private let app = XCUIApplication()
    private let env = ProcessInfo.processInfo.environment
    /// iPad: landscape, and the sidebar stays beside whatever opens, so there is no Back.
    private var iPad: Bool { env["STORY_IPAD"] == "1" }

    private func beat(_ name: String) { print("TOUR_BEAT \(name)") }
    private func wait(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
    private func any(_ format: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: format)).firstMatch
    }
    private func tap(_ format: String, timeout: TimeInterval = 5) {
        let element = any(format)
        XCTAssertTrue(element.waitForExistence(timeout: timeout), format)
        element.tap()
    }
    private func back() {
        let button = app.buttons.matching(NSPredicate(format: "label == 'Back'")).firstMatch
        if button.waitForExistence(timeout: 2) { button.tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.07)).tap() }
    }

    func testTour() {
        _ = skipsQuiescence
        continueAfterFailure = true
        XCUIDevice.shared.orientation = iPad ? .landscapeLeft : .portrait
        app.launchArguments = ["-screen", "story", "-tour"]
        app.launch()
        XCUIDevice.shared.orientation = iPad ? .landscapeLeft : .portrait
        XCTAssertTrue(app.buttons["account-switcher"].waitForExistence(timeout: 20))
        wait(5)

        print("STORY_VIDEO_BEGIN tour")
        beat("home")
        wait(6)
        beat("servers")
        app.buttons["account-switcher"].tap()
        wait(4)
        // Dismiss the menu without switching.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.55)).tap()
        beat("dismissed")
        wait(1.5)

        beat("activity")
        tap("label BEGINSWITH 'Activity'")
        wait(5.5)
        if !iPad { back() }
        beat("team-again")
        wait(1.5)

        beat("open-chat")
        tap("label BEGINSWITH 'Product Health'")
        wait(2)

        beat("picker")
        tap("label BEGINSWITH 'Model: '")
        wait(1.8)
        beat("accounts")
        let heading = app.buttons["picker-heading:codex"]
        if heading.waitForExistence(timeout: 3) { heading.tap() }
        wait(1.6)
        beat("switch-account")
        let personal = any("identifier ENDSWITH 'codex-personal'")
        if personal.waitForExistence(timeout: 3) { personal.tap() }
        wait(1.2)
        beat("switch-model")
        let terra = any("identifier ENDSWITH 'codex/m0'")
        if terra.waitForExistence(timeout: 2), terra.isHittable { terra.tap() }
        wait(1.2)
        if app.otherElements["picker-overlay"].exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap(); wait(0.8)
        }

        beat("ask")
        let field = [app.textViews.firstMatch, app.textFields.firstMatch].first { $0.exists } ?? app.textViews.firstMatch
        field.tap()
        wait(0.7)
        field.typeText("How's retention since 2.0 shipped?")
        wait(0.5)
        let send = app.buttons.matching(NSPredicate(format: "label == 'Send'")).firstMatch
        if send.waitForExistence(timeout: 3) { send.tap() }

        beat("answer")
        wait(6)
        beat("call")
        wait(6)
        print("STORY_VIDEO_END tour")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "tour-end"; shot.lifetime = .keepAlways; add(shot)
    }
}
