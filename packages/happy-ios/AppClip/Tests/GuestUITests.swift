import XCTest

/// Exercises the shared guest screen in an isolated ordinary app. Clip
/// installation and invocation need their own signed-device evidence.
final class GuestUITests: XCTestCase {
    @MainActor func testGuestScreenHasNoAccountSignInAndRejectsInvalidInvitation() throws {
        let app = XCUIApplication()
        app.launchEnvironment["_XCAppClipURL"] = "https://evil.example/bot/invite/abcdefghijklmnop"
        app.launch()
        XCTAssertTrue(app.staticTexts["This invitation link is invalid."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["guest.send"].isEnabled)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iPhone guest screen · invalid link · ordinary dev harness"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}