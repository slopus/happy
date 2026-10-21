import XCTest

/// Opt-in integration against the separately running real invitation bridge.
/// Install and invoke the Clip before running this scheme. No capability is
/// compiled into this test or product.
final class GuestLiveUITests: XCTestCase {
    @MainActor func testLiveClipRoundTripKeyboardAndSessionRestore() throws {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        XCTAssertTrue(clip.staticTexts["App Clip live demo"].waitForExistence(timeout: 30))
        let field = clip.textFields["guest.message"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let replyText = "Hello from the live Happy bot. \(UUID().uuidString.prefix(8))"
        field.typeText("Reply with exactly: \(replyText)")
        let keyboard = clip.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let send = clip.buttons["guest.send"]
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1)
        let keyboardProof = XCTAttachment(screenshot: clip.screenshot())
        keyboardProof.name = "Actual App Clip · simulator · send above keyboard"
        keyboardProof.lifetime = .keepAlways
        add(keyboardProof)
        send.tap()
        let transcript = clip.textViews.firstMatch
        let reply = NSPredicate(format: "value CONTAINS %@", "App Clip live demo\n" + replyText)
        expectation(for: reply, evaluatedWith: transcript)
        waitForExpectations(timeout: 120)
        let first = XCTAttachment(screenshot: clip.screenshot())
        first.name = "Actual App Clip · simulator · real bot reply"
        first.lifetime = .keepAlways
        add(first)

        clip.terminate()
        clip.launchEnvironment = ["HAPPY_GUEST_API_ORIGIN": "http://127.0.0.1:17891"]
        clip.launch()
        XCTAssertTrue(clip.staticTexts["App Clip live demo"].waitForExistence(timeout: 15))
        expectation(for: reply, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 35)
        let restored = XCTAttachment(screenshot: clip.screenshot())
        restored.name = "Actual App Clip · simulator · restored secure session"
        restored.lifetime = .keepAlways
        add(restored)
    }
}