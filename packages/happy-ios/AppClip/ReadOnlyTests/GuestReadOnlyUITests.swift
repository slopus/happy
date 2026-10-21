import XCTest

/// Invoke a real read-only invitation before running this opt-in scheme.
final class GuestReadOnlyUITests: XCTestCase {
    @MainActor func testReadOnlyClipKeepsTranscriptAndHidesComposer() {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        XCTAssertTrue(clip.staticTexts["App Clip live demo"].waitForExistence(timeout: 15))
        XCTAssertTrue(clip.staticTexts["Read only · You can view this conversation."].waitForExistence(timeout: 15))
        XCTAssertTrue(clip.textViews.firstMatch.exists)
        XCTAssertFalse(clip.textFields["guest.message"].exists)
        XCTAssertFalse(clip.buttons["guest.send"].exists)
        let screenshot = XCTAttachment(screenshot: clip.screenshot())
        screenshot.name = "Actual App Clip · simulator · read-only invitation"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}