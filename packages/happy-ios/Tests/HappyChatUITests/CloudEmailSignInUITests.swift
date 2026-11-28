import UIKit
import XCTest

/// Signing in to Happy Cloud by email, end to end against
/// scripts/cloud-email-mock: Continue with email, an address email sign-in
/// isn't set up for, the address, the code step, Change email, a wrong
/// code, wrong codes until Verify waits, and the right code to Join a
/// server; and an invite link from its invite to its server, the code
/// pasted. Runs only with `TEST_RUNNER_HAPPY_CLOUD_EMAIL_MOCK` set to the
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

    /// `text` on the pasteboard, as copied in another app: set from the
    /// runner in front, then the app again, as coming back from Gmail is.
    private func copyElsewhere(_ text: String) {
        if let id = Bundle.main.bundleIdentifier {
            let runner = XCUIApplication(bundleIdentifier: id)
            runner.activate()
            _ = runner.wait(for: .runningForeground, timeout: 5)
        }
        UIPasteboard.general.string = text
        app.activate()
        _ = app.wait(for: .runningForeground, timeout: 5)
    }

    private func until(_ timeout: TimeInterval = 15, _ done: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            allowLocalNetwork()
            if done() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return done()
    }

    /// An invite link, end to end against scripts/cloud-email-mock: the
    /// invite is shown before any sign-in; Sign in to join opens the
    /// sign-in; the code, copied in another app, goes in with iOS's Paste
    /// (a real tap on `UIPasteControl`, which nothing in the app's own
    /// process can stand in for) and signs in; and the invite is then taken
    /// with no second tap, on to Connecting. Coming back from the other app
    /// finds the code step as it was, its field holding the keyboard.
    func testAnInviteIsShownThenJoinedWithAPastedCode() throws {
        guard let mock = ProcessInfo.processInfo.environment["HAPPY_CLOUD_EMAIL_MOCK"] else { throw XCTSkip("no cloud email mock") }
        app.launchArguments = ["-screen", "cloud", "-cloudScreen", "invite", "-cloudName", "happy://cloud/join#q7Xk2_bN-9vLmR4tY8wE1zA6sD3fG5hJ0kP2oI9uYtR",
                               "-cloudAccounts", mock]
        app.launch()

        let join = app.buttons["cloud-invite-join"]
        XCTAssertTrue(join.waitForExistence(timeout: 20), "no invite")
        XCTAssertTrue(until { self.element("cloud-invite-status").label.hasPrefix("You’ll join as Member. This invite expires ") },
                      "the invite isn't shown before signing in: \(element("cloud-invite-status").label)")
        XCTAssertEqual(join.label, "Sign in to join")
        XCTAssertTrue(app.staticTexts["Acme"].exists)
        XCTAssertTrue(app.staticTexts["Steve Korshakov invited you"].exists)
        sleep(1)
        keep("10-invite-offered-signed-out")
        join.tap()

        let email = app.buttons["cloud-email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10), "Sign in to join didn't open the sign-in")
        email.tap()
        let address = element("cloud-email-address")
        XCTAssertTrue(address.waitForExistence(timeout: 10), "no address step")
        replace(address, with: "steve@example.com")
        app.buttons["cloud-email-send"].tap()
        let code = element("cloud-email-code")
        if !code.waitForExistence(timeout: 8) {
            allowLocalNetwork()
            app.buttons["cloud-email-send"].tap()
        }
        XCTAssertTrue(code.waitForExistence(timeout: 15), "no code step")
        let paste = first([element("cloud-email-paste"), app.buttons["Paste"]])
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "no Paste on the code step")
        sleep(1)
        keep("11-code-step")

        // Something copied that holds no code: Paste says so.
        code.typeText("12")
        copyElsewhere("See you at 9")
        XCTAssertTrue(until(5) { (code.value(forKey: "hasKeyboardFocus") as? Bool) == true }, "back in the app, the code field lost the keyboard")
        XCTAssertEqual(code.value as? String, "12", "back in the app, the step isn't as it was left")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        paste.tap()
        XCTAssertTrue(label("cloud-email-code-status", becomes: "No 6-digit code to paste. Copy it from the email first."), "text without a code isn't said")
        XCTAssertEqual(code.value as? String, "12")
        keep("12-nothing-to-paste")

        // The code as an email says it.
        copyElsewhere("Your Happy sign-in code is 123456. It expires in 10 minutes.")
        XCTAssertTrue(until(5) { (code.value(forKey: "hasKeyboardFocus") as? Bool) == true })
        sleep(1)
        keep("13-back-with-the-code-copied")
        paste.tap()

        // Signed in: the invite is taken at once, and goes on to its server.
        XCTAssertTrue(element("cloud-connecting").waitForExistence(timeout: 20), "the pasted code didn't sign in and join")
        XCTAssertFalse(app.buttons["cloud-invite-join"].exists, "no second tap is asked for")
        sleep(1)
        keep("14-joined-connecting")
    }

    private func first(_ candidates: [XCUIElement]) -> XCUIElement {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let hit = candidates.first(where: \.exists) { return hit }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return candidates[0]
    }
}
