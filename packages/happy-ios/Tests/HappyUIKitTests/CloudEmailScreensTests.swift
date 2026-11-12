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

        await http.answer("POST /v1/auth/email/start", 400, #"{"code":"unsupported_provider","error":"Email sign-in is not configured."}"#)
        type(" steve@example.com ", into: screen.field)
        XCTAssertTrue(screen.primary.isEnabled)
        screen.primary.tapped()
        await settle { !screen.primary.isLoading && !screen.status.string.isEmpty }
        XCTAssertEqual(screen.status.string, "Email sign-in isn’t available yet. Sign in with Apple or GitHub.")
        let first = await http.bodies("POST /v1/auth/email/start")
        XCTAssertEqual(first, [["email": "steve@example.com"]])

        await http.answer("POST /v1/auth/email/start", 429, #"{"code":"rate_limited","error":"Too many codes requested.","retryAfter":45}"#, headers: ["Retry-After": "45"])
        screen.primary.tapped()
        await settle { screen.status.string == "Too many codes requested." && !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "Too many codes requested.")
        XCTAssertEqual(screen.primary.title, "Send code in 0:45")
        XCTAssertFalse(screen.primary.isEnabled)
        clock.now += 45
        screen.update()
        XCTAssertEqual(screen.primary.title, "Send code")
        XCTAssertTrue(screen.primary.isEnabled)

        await http.answer("POST /v1/auth/email/start", 202, "{}")
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

        await http.answer("POST /v1/auth/email/verify", 400, #"{"code":"invalid_code","error":"That code didn't work."}"#)
        type("12 34", into: screen.field)
        XCTAssertEqual(screen.field.text.text, "1234")
        XCTAssertFalse(screen.primary.isEnabled)
        type("12 34 56 7", into: screen.field)
        XCTAssertEqual(screen.field.text.text, "123456", "six digits at most")
        await settle { screen.status.string == "That code didn't work." && !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "That code didn't work.")
        XCTAssertEqual(screen.field.text.text, "", "a wrong code is cleared for the next")
        let tried = await http.bodies("POST /v1/auth/email/verify")
        XCTAssertEqual(tried, [["email": "steve@example.com", "code": "123456"]])

        await http.answer("POST /v1/auth/email/verify", 429, #"{"code":"rate_limited","error":"Too many wrong codes.","retryAfter":30}"#)
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

        await http.answer("POST /v1/auth/email/start", 202, "{}")
        screen.secondary?.tapped()
        await settle { screen.status.string == "We sent a new code." && screen.secondary?.isLoading == false }
        XCTAssertEqual(screen.secondary?.title, "Resend code in 1:00")
        XCTAssertEqual(screen.secondary?.isEnabled, false)
        let resent = await http.bodies("POST /v1/auth/email/start")
        XCTAssertEqual(resent, [["email": "steve@example.com"]])

        let pass = Self.jwt(audience: HappyCloud.accounts + "/")
        await http.answer("POST /v1/auth/email/verify", 200, #"{"access_token":"\#(pass)","refresh_token":"r1","token_type":"Bearer","expires_in":3600}"#)
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
}
#endif
