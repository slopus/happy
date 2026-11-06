#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The accounts service as Happy Cloud's screens call it: each request
/// kept, each answer given by path.
private actor CloudHTTP: HTTPTransport {
    var requests: [HTTPRequest] = []
    var answers: [String: (Int, String)] = [:]

    func answer(_ path: String, _ status: Int, _ body: String) { answers[path] = (status, body) }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = answers["\(request.method) \(request.url.path)"] ?? (404, #"{"code":"not_found","error":"Not found."}"#)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

/// Happy Cloud's Create and Join buttons do what they say, and say why
/// when they can't: a tap once returned at once, without a request or a
/// word, because the screen checked the loading state `RoundButton` had
/// just set for it. A tap here is the button's own `tapped`, as a touch
/// runs it.
@MainActor
final class CloudScreensTests: XCTestCase {
    private func context(_ variant: AppVariant = .preview) -> AppContext {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        return AppContext(account: account, variant: variant, version: "test")
    }

    /// On screen, as a tap needs it.
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
        super.tearDown()
    }

    private func settle(until done: () async -> Bool) async {
        for _ in 0..<200 {
            if await done() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testTappingCreateCreatesTheServerAndATakenNameSaysSo() async throws {
        let http = CloudHTTP()
        await http.answer("POST /v1/servers", 201, #"{"server":{"id":"s1","name":"happy","url":"https://happy.happy-clusters.com/","role":"owner","createdAt":"2026-11-06T10:00:00Z"}}"#)
        let screen = CloudCreateViewController(context: context(), account: CloudAccount.preview(token: "account", http: http))
        show(screen)
        screen.field.text.text = "happy"
        screen.primary.tapped()
        await settle { await http.requests.contains { $0.method == "POST" } }
        let created = await http.requests.first { $0.method == "POST" }
        XCTAssertEqual(created?.url.absoluteString, HappyCloud.accounts + "/v1/servers")
        XCTAssertEqual(created?.headers["Authorization"], "Bearer account")
        XCTAssertEqual(try created.flatMap { try JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }, ["name": "happy"])
        await settle { !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "", "a created server shows no problem")

        await http.answer("POST /v1/servers", 409, #"{"code":"taken","error":"That name is taken."}"#)
        screen.primary.tapped()
        await settle { screen.status.string != "" }
        XCTAssertEqual(screen.status.string, "That name is taken.")
        await settle { !screen.primary.isLoading }

        // The keyboard's return goes through the same button.
        await http.answer("POST /v1/servers", 500, #"{"code":"internal","error":"Something broke."}"#)
        _ = screen.textFieldShouldReturn(screen.field.text)
        await settle { screen.status.string == "Something broke." }
        XCTAssertEqual(screen.status.string, "Something broke.")
    }

    func testTappingJoinJoinsAndAMissingCodeSaysSo() async throws {
        let http = CloudHTTP()
        await http.answer("POST /v1/servers/join", 404, #"{"code":"not_found","error":"No such server."}"#)
        let screen = CloudJoinViewController(context: context(), account: CloudAccount.preview(token: "account", http: http))
        show(screen)
        screen.nameField.text.text = "@acme"
        screen.primary.tapped()
        await settle { !screen.status.string.isEmpty }
        XCTAssertEqual(screen.status.string, Strings.HappyCloud.joinMissing)
        await settle { !screen.primary.isLoading }
        let none = await http.requests.count
        XCTAssertEqual(none, 0)

        screen.codeField.text.text = "pcmurcvd"
        screen.primary.tapped()
        await settle { screen.status.string == "No server has that name and invite code." }
        XCTAssertEqual(screen.status.string, "No server has that name and invite code.")
        let joined = await http.requests.first
        XCTAssertEqual(try joined.flatMap { try JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }, ["name": "acme", "code": "pcmurcvd"])
    }

    // MARK: A test account

    private static func tap(_ screen: CloudWelcomeViewController, _ times: Int, every seconds: TimeInterval, from start: Date) {
        for index in 0..<times { screen.logoTapped(at: start.addingTimeInterval(Double(index) * seconds)) }
    }

    func testTenTapsOnTheLogoWithinFourSecondsOpenTheTestSignInAndNothingFewer() {
        let start = Date(timeIntervalSince1970: 1_000)
        let slow = CloudWelcomeViewController(context: context())
        show(slow)
        XCTAssertNotNil(slow.art?.onTap, "the logo hears taps")
        Self.tap(slow, 9, every: 0.3, from: start)
        XCTAssertNil(slow.testSignIn, "nine taps")
        XCTAssertNil(Self.find("cloud-test-sign-in", in: slow.view), "nothing of it is on screen before")
        Self.tap(slow, 1, every: 0, from: start.addingTimeInterval(4.2))
        XCTAssertNil(slow.testSignIn, "the tenth came after four seconds")

        let quick = CloudWelcomeViewController(context: context())
        show(quick)
        Self.tap(quick, 10, every: 0.3, from: start)
        let form = try? XCTUnwrap(quick.testSignIn)
        XCTAssertTrue(form?.password.text.isSecureTextEntry == true)
        XCTAssertNotNil(Self.find("cloud-test-sign-in", in: quick.view))
    }

    func testAProductionBuildHasNoTestSignIn() {
        let screen = CloudWelcomeViewController(context: context(.production))
        show(screen)
        XCTAssertNil(screen.art?.onTap)
        Self.tap(screen, 10, every: 0.1, from: Date())
        XCTAssertNil(screen.testSignIn)
    }

    func testATestAccountSignsInWithItsPasswordAndSaysWhyNot() async throws {
        let http = CloudHTTP()
        let screen = CloudWelcomeViewController(context: context())
        screen.http = http
        let navigation = UINavigationController(rootViewController: screen)
        show(navigation)
        Self.tap(screen, 10, every: 0.1, from: Date())
        let form = try XCTUnwrap(screen.testSignIn)

        form.button.tapped()
        await settle { !form.button.isLoading }
        XCTAssertEqual(screen.problem.string, "Enter the test account’s login and password.")
        let none = await http.requests
        XCTAssertEqual(none.count, 0)

        await http.answer("POST /v1/auth/password", 401, #"{"code":"invalid_credentials"}"#)
        form.login.text.text = " QA-iOS "
        form.password.text.text = "not-it"
        form.button.tapped()
        await settle { screen.problem.string != "" && !form.button.isLoading }
        XCTAssertEqual(screen.problem.string, "That login or password is wrong.")
        let tried = await http.requests.last
        XCTAssertEqual(tried?.url.absoluteString, HappyCloud.accounts + "/v1/auth/password")
        XCTAssertNil(tried?.headers["Authorization"])
        XCTAssertEqual(try tried.flatMap { try JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }, ["login": "qa-ios", "password": "not-it"])

        await http.answer("POST /v1/auth/password", 429, #"{"code":"locked","retryAfter":600}"#)
        form.button.tapped()
        await settle { screen.problem.string == "Too many tries. Try again in 10 min." }
        XCTAssertEqual(screen.problem.string, "Too many tries. Try again in 10 min.")
        await settle { !form.button.isLoading }

        let pass = Self.jwt(audience: HappyCloud.accounts + "/")
        await http.answer("POST /v1/auth/password", 200, #"{"access_token":"\#(pass)","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v1/servers", 200, #"{"servers":[]}"#)
        form.password.text.text = "right"
        form.button.tapped()
        await settle { navigation.topViewController is CloudServersViewController }
        XCTAssertTrue(navigation.topViewController is CloudServersViewController, "signed in, as after Apple")
        XCTAssertEqual(screen.problem.string, "")
        XCTAssertEqual(form.password.text.text ?? "", "", "the password is gone from the field")
        await settle { await http.requests.contains { $0.url.path == "/v1/servers" } }
        let listed = await http.requests.last { $0.url.path == "/v1/servers" }
        XCTAssertEqual(listed?.headers["Authorization"], "Bearer \(pass)")
        CloudScreens.account = nil
    }

    /// An account pass for `audience`, as the accounts service signs one.
    private static func jwt(audience: String) -> String {
        func part(_ json: String) -> String {
            Data(json.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        return part(#"{"alg":"ES256"}"#) + "." + part(#"{"sub":"qa","aud":"\#(audience)"}"#) + ".sig"
    }

    private static func find(_ id: String, in view: UIView) -> UIView? {
        if view.accessibilityIdentifier == id { return view }
        for child in view.subviews { if let found = find(id, in: child) { return found } }
        return nil
    }
}
#endif
