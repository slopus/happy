import XCTest

/// Signing in to Happy Cloud by email, end to end against
/// scripts/cloud-email-mock: Continue with email, an address email sign-in
/// isn't set up for, the address, the code step, Change email, a wrong
/// code, wrong codes until Verify waits, and the right code to Join a
/// server. Runs only with `TEST_RUNNER_HAPPY_CLOUD_EMAIL_MOCK` set to the
/// mock's origin as the phone reaches it (`http://<this Mac>:8790`).
@MainActor
final class CloudEmailSignInUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    /// The local network prompt the first request to the mock may raise.
    private func allowLocalNetwork() {
        for button in ["Allow", "OK"] where springboard.alerts.buttons[button].exists { springboard.alerts.buttons[button].tap() }
    }

    private func label(_ id: String, becomes text: String, timeout: TimeInterval = 15) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            allowLocalNetwork()
            if element(id).exists, element(id).label == text { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return false
    }

    /// The field's text replaced: its clear button where it has one, else
    /// deleting from the end (a short code, the caret after it).
    private func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        let old = field.value as? String ?? ""
        if !old.isEmpty, old != field.placeholderValue {
            let clear = field.buttons["Clear text"]
            if clear.exists { clear.tap() } else { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count)) }
        }
        field.typeText(text)
    }

    func testSigningInByEmail() throws {
        guard let mock = ProcessInfo.processInfo.environment["HAPPY_CLOUD_EMAIL_MOCK"] else { throw XCTSkip("no cloud email mock") }
        app.launchArguments = ["-screen", "cloud", "-cloudScreen", "welcome", "-cloudAccounts", mock]
        app.launch()

        let email = app.buttons["cloud-email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20), "no Continue with email")
        sleep(1)
        keep("00-welcome")
        email.tap()

        let address = element("cloud-email-address")
        XCTAssertTrue(address.waitForExistence(timeout: 10), "no address step")
        replace(address, with: "steve@unsupported.test")
        app.buttons["cloud-email-send"].tap()
        // The first request may wait on the local network prompt; ask again once allowed.
        if !label("cloud-email-status", becomes: "Email sign-in isn’t available yet. Sign in with Apple or GitHub.", timeout: 8) {
            allowLocalNetwork()
            app.buttons["cloud-email-send"].tap()
        }
        XCTAssertTrue(label("cloud-email-status", becomes: "Email sign-in isn’t available yet. Sign in with Apple or GitHub."), "email sign-in not set up isn't said")
        keep("01-unsupported")

        replace(address, with: "steve@example.com")
        keep("02-email")
        app.buttons["cloud-email-send"].tap()
        let code = element("cloud-email-code")
        XCTAssertTrue(code.waitForExistence(timeout: 15), "no code step")
        XCTAssertTrue(app.buttons["cloud-email-resend"].label.hasPrefix("Resend code in 0:") || app.buttons["cloud-email-resend"].label == "Resend code in 1:00")
        sleep(1)
        keep("03-code")

        // Change email goes back with the address kept, and sends again.
        app.buttons["cloud-email-change"].tap()
        XCTAssertTrue(app.buttons["cloud-email-send"].waitForExistence(timeout: 5))
        XCTAssertEqual(address.value as? String, "steve@example.com")
        app.buttons["cloud-email-send"].tap()
        XCTAssertTrue(code.waitForExistence(timeout: 15), "no code step again")

        code.tap()
        code.typeText("000000")
        XCTAssertTrue(label("cloud-email-code-status", becomes: "That code didn't work."), "a wrong code isn't said")
        keep("04-wrong-code")

        code.typeText("111111")
        XCTAssertTrue(label("cloud-email-code-status", becomes: "That code didn't work."))
        code.typeText("222222")
        XCTAssertTrue(label("cloud-email-code-status", becomes: "Too many wrong codes. Wait a moment and try again."), "the wait isn't said")
        XCTAssertTrue(app.buttons["cloud-email-verify"].label.hasPrefix("Verify in 0:"))
        keep("05-rate-limited")

        let verify = app.buttons["cloud-email-verify"]
        let deadline = Date().addingTimeInterval(40)
        while verify.label != "Verify", Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.5)) }
        XCTAssertEqual(verify.label, "Verify", "Verify never came back")
        replace(code, with: "123456")

        XCTAssertTrue(element("cloud-server-acme").waitForExistence(timeout: 20), "not signed in to Join a server")
        XCTAssertTrue(element("cloud-server-globex-labs").exists)
        sleep(1)
        keep("06-signed-in")
    }
}
