#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The accounts service's email routes as the screens call them: each
/// request kept, each answer given by path, with its headers.
private actor EmailHTTP: HTTPTransport {
    var requests: [HTTPRequest] = []
    var answers: [String: (Int, String, [String: String])] = [:]

    func answer(_ path: String, _ status: Int, _ body: String, headers: [String: String] = [:]) { answers[path] = (status, body, headers) }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body, headers) = answers["\(request.method) \(request.url.path)"] ?? (404, #"{"code":"not_found","error":"Not found."}"#, [:])
        return HTTPResponse(status: status, body: Data(body.utf8), headers: headers)
    }

    func bodies(_ path: String) -> [[String: String]] {
        requests.filter { "\($0.method) \($0.url.path)" == path }
            .compactMap { try? JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }
    }
}

/// A clock the tests move.
private final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_000_000)
}

/// Signing in to Happy Cloud by email: Continue with email on the welcome,
/// the address, then the code; what each refusal says, and the waits a
/// `429` and Resend code count down.
@MainActor
final class CloudEmailScreensTests: XCTestCase {
    private func context() -> AppContext {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        return AppContext(account: account, variant: .preview, version: "test")
    }

    private var window: UIWindow?
    private func show(_ screen: UIViewController) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = screen
        window.makeKeyAndVisible()
        self.window = window
        screen.view.layoutIfNeeded()
    }

    override func tearDown() {
        window?.isHidden = true
        window = nil
        CloudScreens.account = nil
        super.tearDown()
    }

    private func settle(until done: () async -> Bool) async {
        for _ in 0..<300 {
            if await done() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private static func jwt(audience: String) -> String {
        func encode(_ object: [String: Any]) -> String {
            try! JSONSerialization.data(withJSONObject: object).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        return encode(["alg": "RS256", "typ": "JWT"]) + "." + encode(["aud": audience, "sub": "steve"]) + ".c2ln"
    }

    private func type(_ text: String, into field: CloudField) {
        field.text.text = text
        (field.text.delegate as? CloudEmailStepViewController)?.edited()
    }

    /// Continue with email sits 12 under GitHub's, as wide, and opens the
    /// address step.
    func testTheWelcomeOffersEmailUnderGitHub() async {
        let welcome = CloudWelcomeViewController(context: context())
        let navigation = UINavigationController(rootViewController: welcome)
        show(navigation)
        XCTAssertEqual(welcome.email.title, "Continue with email")
        XCTAssertEqual(welcome.email.display, .filled)
        XCTAssertEqual(welcome.email.frame.width, welcome.github.frame.width)
        XCTAssertEqual(welcome.email.frame.minX, welcome.github.frame.minX)
        XCTAssertEqual(welcome.github.frame.maxY + 12, welcome.email.frame.minY)
        XCTAssertEqual(welcome.google.frame.maxY + 12, welcome.github.frame.minY)
        welcome.email.tapped()
        await settle { navigation.topViewController is CloudEmailViewController }
        XCTAssertTrue(navigation.topViewController is CloudEmailViewController)
    }

    /// Send code asks for a code for the trimmed address and opens the
    /// code step; email sign-in not set up says so in the app's words, and
    /// a `429` counts Send code down.
    func testSendCodeOpensTheCodeStepAndSaysWhyNot() async throws {
        let http = EmailHTTP(), clock = Clock()
        let welcome = CloudWelcomeViewController(context: context())
        let screen = CloudEmailViewController(context: context(), http: http)
        screen.now = { clock.now }
        let navigation = UINavigationController(rootViewController: welcome)
        navigation.pushViewController(screen, animated: false)
        show(navigation)
        screen.loadViewIfNeeded()
        XCTAssertEqual(screen.field.text.textContentType, .emailAddress)
        XCTAssertEqual(screen.field.text.keyboardType, .emailAddress)
        XCTAssertFalse(screen.primary.isEnabled, "nothing typed")

        await http.answer("POST /v2/auth/email/start", 400, #"{"code":"unsupported_provider","error":"Email sign-in is not configured."}"#)
        type(" steve@example.com ", into: screen.field)
        XCTAssertTrue(screen.primary.isEnabled)
        screen.primary.tapped()
        await settle { !screen.primary.isLoading && !screen.status.string.isEmpty }
        XCTAssertEqual(screen.status.string, "Email sign-in isn’t available yet. Sign in with Apple or GitHub.")
        let first = await http.bodies("POST /v2/auth/email/start")
        XCTAssertEqual(first, [["email": "steve@example.com"]])

        await http.answer("POST /v2/auth/email/start", 429, #"{"code":"rate_limited","error":"Too many codes requested.","retryAfter":45}"#, headers: ["Retry-After": "45"])
        screen.primary.tapped()
        await settle { screen.status.string == "Too many codes requested." && !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "Too many codes requested.")
        XCTAssertEqual(screen.primary.title, "Send code in 0:45")
        XCTAssertFalse(screen.primary.isEnabled)
        clock.now += 45
        screen.update()
        XCTAssertEqual(screen.primary.title, "Send code")
        XCTAssertTrue(screen.primary.isEnabled)

        await http.answer("POST /v2/auth/email/start", 202, "{}")
        screen.primary.tapped()
        await settle { navigation.topViewController is CloudEmailCodeViewController }
        let code = try XCTUnwrap(navigation.topViewController as? CloudEmailCodeViewController)
        XCTAssertEqual(code.email, "steve@example.com")
        XCTAssertEqual(code.bodyLabel.string, "Enter the 6-digit code we sent to steve@example.com.")
        XCTAssertEqual(screen.status.string, "")
    }

    /// The code step: a one-time-code field taking six digits and checking
    /// them at once, Resend code a minute after each code, a wrong code
    /// said and cleared, a `429` counting Verify down, Change email back to
    /// the address, and the right code signed in to the servers with Back
    /// to the welcome.
    func testTheCodeSignsInAndSaysWhyNot() async throws {
        let http = EmailHTTP(), clock = Clock()
        let welcome = CloudWelcomeViewController(context: context())
        let address = CloudEmailViewController(context: context(), http: http)
        let screen = CloudEmailCodeViewController(context: context(), email: "steve@example.com", http: http, sentAt: clock.now)
        screen.now = { clock.now }
        let navigation = UINavigationController(rootViewController: welcome)
        navigation.setViewControllers([welcome, address, screen], animated: false)
        show(navigation)
        screen.loadViewIfNeeded()
        XCTAssertEqual(screen.field.text.textContentType, .oneTimeCode)
        XCTAssertEqual(screen.field.text.keyboardType, .numberPad)
        XCTAssertEqual(screen.secondary?.title, "Resend code in 1:00")
        XCTAssertEqual(screen.secondary?.isEnabled, false)
        XCTAssertFalse(screen.primary.isEnabled)

        await http.answer("POST /v2/auth/email/verify", 400, #"{"code":"invalid_code","error":"That code didn't work."}"#)
        type("12 34", into: screen.field)
        XCTAssertEqual(screen.field.text.text, "1234")
        XCTAssertFalse(screen.primary.isEnabled)
        type("12 34 56 7", into: screen.field)
        XCTAssertEqual(screen.field.text.text, "123456", "six digits at most")
        await settle { screen.status.string == "That code didn't work." && !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "That code didn't work.")
        XCTAssertEqual(screen.field.text.text, "", "a wrong code is cleared for the next")
        let tried = await http.bodies("POST /v2/auth/email/verify")
        XCTAssertEqual(tried, [["email": "steve@example.com", "code": "123456"]])

        await http.answer("POST /v2/auth/email/verify", 429, #"{"code":"rate_limited","error":"Too many wrong codes.","retryAfter":30}"#)
        type("222222", into: screen.field)
        await settle { screen.status.string == "Too many wrong codes." && !screen.primary.isLoading }
        XCTAssertEqual(screen.primary.title, "Verify in 0:30")
        XCTAssertFalse(screen.primary.isEnabled)

        clock.now += 60
        screen.update()
        XCTAssertEqual(screen.primary.title, "Verify")
        XCTAssertTrue(screen.primary.isEnabled)
        XCTAssertEqual(screen.secondary?.title, "Resend code")
        XCTAssertEqual(screen.secondary?.isEnabled, true)

        await http.answer("POST /v2/auth/email/start", 202, "{}")
        screen.secondary?.tapped()
        await settle { screen.status.string == "We sent a new code." && screen.secondary?.isLoading == false }
        XCTAssertEqual(screen.secondary?.title, "Resend code in 1:00")
        XCTAssertEqual(screen.secondary?.isEnabled, false)
        let resent = await http.bodies("POST /v2/auth/email/start")
        XCTAssertEqual(resent, [["email": "steve@example.com"]])

        let pass = Self.jwt(audience: HappyCloud.api + "/")
        await http.answer("POST /v2/auth/email/verify", 200, #"{"id_token":"\#(Self.jwt(audience: "happy"))","expires_in":300}"#)
        await http.answer("POST /v1/session", 200, #"{"access_token":"\#(pass)","refresh_token":"ar1","expires_in":3600}"#)
        await http.answer("GET /v1/servers", 200, #"{"servers":[{"id":"s1","name":"acme","url":"","role":"owner"}]}"#)
        type("123456", into: screen.field)
        // The stack holds the step going out until the push is over.
        await settle { navigation.topViewController is CloudServersViewController && navigation.transitionCoordinator == nil }
        XCTAssertTrue(navigation.topViewController is CloudServersViewController, "signed in, as after Apple")
        XCTAssertEqual(navigation.viewControllers.count, 1, "the servers in the place of every sign-in step: Back never returns to one")
        await settle { await http.requests.contains { $0.url.path == "/v1/servers" } }
        let listed = await http.requests.last { $0.url.path == "/v1/servers" }
        XCTAssertEqual(listed?.headers["Authorization"], "Bearer \(pass)")
    }

    func testChangeEmailGoesBackToTheAddress() async {
        let address = CloudEmailViewController(context: context(), http: EmailHTTP())
        let screen = CloudEmailCodeViewController(context: context(), email: "steve@example.com", http: EmailHTTP(), sentAt: Date())
        let navigation = UINavigationController(rootViewController: address)
        navigation.pushViewController(screen, animated: false)
        show(navigation)
        screen.loadViewIfNeeded()
        XCTAssertEqual(screen.change.title, "Change email")
        screen.change.tapped()
        await settle { navigation.topViewController === address }
        XCTAssertTrue(navigation.topViewController === address)
    }

    // MARK: A code read in another mail app

    /// The code step on screen over `http`, with the mail apps `installed`.
    private func codeStep(_ http: EmailHTTP, installed: Set<String> = []) -> (CloudEmailCodeViewController, UINavigationController, opened: () -> [URL]) {
        final class Opened { var urls: [URL] = [] }
        let opened = Opened()
        let address = CloudEmailViewController(context: context(), http: http)
        let screen = CloudEmailCodeViewController(context: context(), email: "steve@example.com", http: http, sentAt: Date())
        screen.canOpen = { installed.contains($0.scheme ?? "") }
        screen.open = { opened.urls.append($0) }
        let navigation = UINavigationController(rootViewController: address)
        navigation.pushViewController(screen, animated: false)
        show(navigation)
        screen.view.layoutIfNeeded()
        return (screen, navigation, { opened.urls })
    }

    /// Where the step's parts sit, in the screen, once Paste has the size
    /// iOS gives it a moment after it is made (it draws nothing before).
    private func restingFrames(_ screen: CloudEmailCodeViewController) async -> [CGRect] {
        for _ in 0..<100 where screen.paste.intrinsicContentSize.width <= 0 {
            try? await Task.sleep(for: .milliseconds(10))
        }
        screen.view.layoutIfNeeded()
        return frames(screen)
    }

    private func frames(_ screen: CloudEmailCodeViewController) -> [CGRect] {
        ([screen.titleLabel, screen.bodyLabel, screen.field, screen.field.text, screen.paste, screen.status, screen.change, screen.primary, screen.secondary] as [UIView?])
            .compactMap { $0 }.map { $0.convert($0.bounds, to: screen.view) }
    }

    /// Paste is iOS's own control, in the field at its right end, and is
    /// there from the start: no pasteboard is read to decide it, and the
    /// text keeps clear of it.
    func testPasteIsInTheFieldFromTheStart() async {
        let (screen, _, _) = codeStep(EmailHTTP())
        XCTAssertIdentical(screen.paste.superview, screen.field)
        XCTAssertIdentical(screen.paste.target as AnyObject, screen.pasteTarget)
        XCTAssertFalse(screen.paste.isHidden)
        XCTAssertEqual(screen.paste.configuration.displayMode, .labelOnly)
        XCTAssertEqual(screen.pasteTarget.pasteConfiguration?.acceptableTypeIdentifiers.isEmpty, false)
        XCTAssertEqual(screen.field.text.clearButtonMode, .never, "nothing else sits where Paste is")
        let paste = screen.paste.frame, text = screen.field.text.frame, field = screen.field.bounds
        XCTAssertGreaterThan(paste.width, 0)
        XCTAssertGreaterThanOrEqual(paste.height, 28, "big enough to tap")
        XCTAssertEqual(paste.maxX, field.maxX - 10, accuracy: 0.5)
        XCTAssertEqual(paste.midY, field.midY, accuracy: 0.5)
        XCTAssertEqual(text.maxX, paste.minX - 8, accuracy: 0.5, "the code ends before Paste")
        XCTAssertGreaterThan(text.width, 150, "six digits have their room")
    }

    /// What Paste hands over: the code is taken out of whatever was copied
    /// and checked as a typed one is, with no tap on Verify.
    func testPastedTextWithACodeIsCheckedAtOnce() async throws {
        let http = EmailHTTP()
        await http.answer("POST /v2/auth/email/verify", 400, #"{"code":"invalid_code","error":"That code didn't work."}"#)
        let (screen, _, _) = codeStep(http)
        let before = await restingFrames(screen)
        screen.pasteTarget.paste(itemProviders: [NSItemProvider(object: "Your Happy sign-in code is 428913. It expires in 10 minutes." as NSString)])
        await settle { await http.requests.count == 1 }
        let tried = await http.bodies("POST /v2/auth/email/verify")
        XCTAssertEqual(tried, [["email": "steve@example.com", "code": "428913"]], "the code alone, sent as typing it sends it")
        await settle { screen.status.string == "That code didn't work." && !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "That code didn't work.")
        XCTAssertEqual(screen.field.text.text, "", "a wrong code is cleared for the next, as a typed one is")
        screen.view.layoutIfNeeded()
        XCTAssertEqual(frames(screen), before, "nothing moved")

        // The right one signs in.
        let pass = Self.jwt(audience: HappyCloud.api + "/")
        await http.answer("POST /v2/auth/email/verify", 200, #"{"id_token":"\#(Self.jwt(audience: "happy"))","expires_in":300}"#)
        await http.answer("POST /v1/session", 200, #"{"access_token":"\#(pass)","refresh_token":"ar1","expires_in":3600}"#)
        screen.pasted("123 456")
        XCTAssertEqual(screen.field.text.text, "123456")
        await settle { CloudScreens.account != nil }
        XCTAssertNotNil(CloudScreens.account, "signed in from the pasted code")
        let sent = await http.bodies("POST /v2/auth/email/verify")
        XCTAssertEqual(sent.last, ["email": "steve@example.com", "code": "123456"])
    }

    /// Text without a code says so under the field and changes nothing
    /// else: no request, the field as it was.
    func testPastedTextWithoutACodeSaysSo() async throws {
        let http = EmailHTTP()
        let (screen, _, _) = codeStep(http)
        let before = await restingFrames(screen)
        type("12", into: screen.field)
        for text in ["", "hello", "https://example.com/1234567", "12345", "call 555 0100 2368"] {
            screen.pasted(text)
            XCTAssertEqual(screen.status.string, "No 6-digit code to paste. Copy it from the email first.", text)
            XCTAssertEqual(screen.field.text.text, "12", text)
        }
        screen.pasteTarget.paste(itemProviders: [])
        screen.pasteTarget.paste(itemProviders: [NSItemProvider(object: URL(string: "https://example.com")! as NSURL)])
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(screen.field.text.text, "12")
        screen.view.layoutIfNeeded()
        XCTAssertEqual(frames(screen), before, "the line has its room: nothing moved")
        let asked = await http.requests.count
        XCTAssertEqual(asked, 0)
        // Typing on clears it.
        type("123", into: screen.field)
        XCTAssertEqual(screen.status.string, "")
    }

    /// Open Mail, and Open Gmail when Gmail is installed, sit in one row
    /// with Change email; the row is the same line whatever it holds, so
    /// the step is laid out the same on every phone.
    func testTheMailAppsHereAreOfferedInOneRow() async throws {
        let (none, _, _) = codeStep(EmailHTTP())
        XCTAssertTrue(none.mailLinks.isEmpty, "no mail app that can be opened: none offered")

        let (mail, _, _) = codeStep(EmailHTTP(), installed: ["message"])
        XCTAssertEqual(mail.mailLinks.map(\.app), [.mail])
        XCTAssertEqual(mail.mailLinks.map(\.link.title), ["Open Mail"])

        let (both, _, opened) = codeStep(EmailHTTP(), installed: ["message", "googlegmail"])
        XCTAssertEqual(both.mailLinks.map(\.app), [.mail, .gmail])
        XCTAssertEqual(both.mailLinks.map(\.link.title), ["Open Mail", "Open Gmail"])
        let row = (both.mailLinks.map(\.link) + [both.change]).map { $0.convert($0.bounds, to: both.view) }
        XCTAssertEqual(Set(row.map(\.minY)).count, 1, "one row: \(row)")
        XCTAssertEqual(Set(row.map(\.height)).count, 1)
        for (left, right) in zip(row, row.dropFirst()) { XCTAssertEqual(right.minX, left.maxX + 4, accuracy: 0.5, "side by side, in order") }
        let column = both.field.convert(both.field.bounds, to: both.view)
        XCTAssertGreaterThanOrEqual(row[0].minX, column.minX - 0.5, "within the column")
        XCTAssertLessThanOrEqual(row[2].maxX, column.maxX + 0.5)
        XCTAssertEqual((row[0].minX + row[2].maxX) / 2, column.midX, accuracy: 0.5, "centred")
        for link in both.mailLinks.map(\.link) + [both.change] {
            let label = link.label.convert(link.label.bounds, to: link)
            XCTAssertGreaterThanOrEqual(label.minX, 0)
            XCTAssertLessThanOrEqual(label.maxX, link.bounds.maxX + 0.5, "\(link.title) isn't cut short")
        }
        // Everything but Change email's own place across the row is where it is with no mail app.
        var withBoth = await restingFrames(both), withMail = await restingFrames(mail), withNone = await restingFrames(none)
        let change = 6
        XCTAssertEqual(withBoth[change].minY, withNone[change].minY)
        XCTAssertEqual(withBoth[change].height, withNone[change].height)
        withBoth.remove(at: change); withMail.remove(at: change); withNone.remove(at: change)
        XCTAssertEqual(withBoth, withNone, "the mail apps move nothing")
        XCTAssertEqual(withMail, withNone)

        both.mailLinks[0].link.tapped()
        both.mailLinks[1].link.tapped()
        XCTAssertEqual(opened().map(\.absoluteString), ["message://", "googlegmail://"])
    }

    /// Back in Happy from the mail app, the step is as it was left: its
    /// code, its line, and the keyboard in its field again.
    func testComingBackLeavesTheStepWithItsFieldFocused() async throws {
        let (screen, navigation, _) = codeStep(EmailHTTP(), installed: ["googlegmail"])
        type("12", into: screen.field)
        screen.say("We sent a new code.", problem: false)
        screen.field.text.resignFirstResponder()
        XCTAssertFalse(screen.field.text.isFirstResponder)
        let before = frames(screen)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        await settle { screen.field.text.isFirstResponder }
        XCTAssertTrue(screen.field.text.isFirstResponder, "the field has the keyboard again")
        XCTAssertEqual(screen.field.text.text, "12")
        XCTAssertEqual(screen.status.string, "We sent a new code.")
        XCTAssertTrue(navigation.topViewController === screen)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertEqual(frames(screen).count, before.count)

        // Not its business once another step is on top.
        screen.field.text.resignFirstResponder()
        navigation.popViewController(animated: false)
        await settle { navigation.topViewController !== screen && navigation.transitionCoordinator == nil }
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertFalse(screen.field.text.isFirstResponder)
    }
}
#endif
