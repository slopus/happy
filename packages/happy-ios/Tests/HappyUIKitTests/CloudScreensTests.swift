#if canImport(UIKit)
import AuthenticationServices
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

/// A cloud server's daemon: each request kept, each answer by path.
private actor CloudDaemon: AgentTransport {
    var requests: [(method: String, path: String, body: Data?)] = []
    var answers: [String: String] = [:]
    /// Refusals by `METHOD path`, with words of the server's own.
    var refusals: [String: Int] = [:]
    func answer(_ path: String, _ body: String) { answers[path] = body }
    func refuse(_ request: String, _ status: Int?) { refusals[request] = status }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append((method, path, body))
        if let status = refusals["\(method) \(path)"] { return HTTP1Response(status: status, body: Data(#"{"code":"internal","error":"Internal boom"}"#.utf8)) }
        return HTTP1Response(status: 200, body: Data((answers[path] ?? "{}").utf8))
    }
    func browserConnection() async throws -> any BrowserStream { throw BrowserError.unavailable }
    func close() async {}
}

/// An access token for `audience`, as the accounts service issues one: unsigned.
private func token(for audience: String) -> String {
    func encode(_ object: [String: Any]) -> String {
        try! JSONSerialization.data(withJSONObject: object).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    return encode(["alg": "RS256", "typ": "JWT"]) + "." + encode(["aud": audience, "sub": "steve"]) + ".c2ln"
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

        // The keyboard's return goes through the same button, once it's on.
        screen.primary.isEnabled = true
        await http.answer("POST /v1/servers", 500, #"{"code":"internal","error":"Something broke."}"#)
        _ = screen.textFieldShouldReturn(screen.field.text)
        await settle { screen.status.string == "Something broke." }
        XCTAssertEqual(screen.status.string, "Something broke.")
    }

    /// A member a cloud server has no profile for (`userId` null) gets
    /// Create your profile, offered Apple's name from this sign-in, else
    /// the server's suggestion; what they give is saved as their name,
    /// never one made up, then their picture. Back saves nothing, and the
    /// screen says the server needs a name.
    func testANamelessMemberIsAskedTheirNameOnConnect() async throws {
        let origin = HappyCloud.server(named: "acme")
        let http = CloudHTTP()
        await http.answer("POST /v1/servers/s1/token", 200, #"{"access_token":"\#(token(for: origin + "/"))","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":null,"methods":[]}"#)
        let daemon = CloudDaemon()
        await daemon.answer("/v0/health", #"{"ready":true}"#)
        await daemon.answer("/v0/profile", #"{"profile":{"name":"Steve K","email":"s@example.com","updatedAt":0,"version":"v0"}}"#)
        func connect(apple: String?) async throws -> (CloudConnectingViewController, CloudProfileViewController, UINavigationController) {
            CloudScreens.appleName = apple
            let screen = CloudConnectingViewController(context: context(), account: CloudAccount.preview(token: "account", http: http),
                                                       server: CloudServer(id: "s1", name: "acme", url: origin + "/", role: .member))
            screen.makeFlow = { try ServerSignInFlow.cloud($0, http: http, makeTransport: { _ in daemon }) }
            let navigation = UINavigationController(rootViewController: screen)
            show(navigation)
            await settle { navigation.topViewController is CloudProfileViewController && navigation.transitionCoordinator == nil }
            let profile = try XCTUnwrap(navigation.topViewController as? CloudProfileViewController, "no profile step")
            profile.view.layoutIfNeeded()
            return (screen, profile, navigation)
        }

        // The server's suggestion, then Back: nothing saved, and why.
        var (screen, profile, navigation) = try await connect(apple: nil)
        XCTAssertEqual(profile.titleLabel.string, "Create your profile")
        XCTAssertEqual(profile.bodyLabel.string, "This is how your team and agents see you on @acme.")
        XCTAssertEqual(profile.nameField.text.text, "Steve K")
        XCTAssertEqual(profile.photoButton.title(for: .normal), "Add photo")
        XCTAssertEqual(profile.seed, "acme", "the server's identity picks the placeholder, never a name")
        XCTAssertTrue(profile.primary.isEnabled)
        navigation.popViewController(animated: false)
        await settle { screen.bodyLabel.string == Strings.ServerSignIn.nameNeeded }
        XCTAssertEqual(screen.bodyLabel.string, Strings.ServerSignIn.nameNeeded)
        let none = await daemon.requests.contains { $0.method != "GET" }
        XCTAssertFalse(none, "no name made up")
        window?.isHidden = true

        // Apple's name over the suggestion. An empty name can't continue;
        // a refused one says so in the same words whatever the server said.
        (screen, profile, navigation) = try await connect(apple: "Steve Korshakov")
        XCTAssertEqual(profile.nameField.text.text, "Steve Korshakov")
        XCTAssertEqual(profile.seed, "acme")
        profile.nameField.text.text = "  "
        profile.edited()
        XCTAssertFalse(profile.primary.isEnabled, "no name, no Continue")
        profile.nameField.text.text = "Steve"
        profile.edited()
        XCTAssertEqual(profile.seed, "acme", "the placeholder doesn't follow the typing")
        profile.choose(CloudProfileViewController.previewPhoto())
        XCTAssertEqual(profile.photoButton.title(for: .normal), "Change photo")
        await daemon.refuse("PATCH /v0/profile", 500)
        profile.primary.tapped()
        await settle { !profile.status.string.isEmpty }
        XCTAssertEqual(profile.status.string, "Couldn’t save your name. Check your connection and try again.")
        await settle { !profile.primary.isLoading }
        let unsentPhoto = await daemon.requests.contains { $0.method == "PUT" }
        XCTAssertFalse(unsentPhoto, "no picture before a name")

        // Continue saves the name, with the suggested email, then the picture.
        await daemon.refuse("PATCH /v0/profile", nil)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        profile.primary.tapped()
        await settle { await daemon.requests.contains { $0.method == "PUT" } }
        let writes = await daemon.requests.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.method), ["PATCH", "PATCH", "PUT"])
        XCTAssertEqual(writes.last?.path, "/v0/profile/photo")
        XCTAssertEqual(writes.last?.body?.prefix(2), Data([0xFF, 0xD8]), "a JPEG")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(writes[1].body)) as? [String: Any]
        XCTAssertEqual(body?["name"] as? String, "Steve")
        XCTAssertEqual(body?["email"] as? String, "s@example.com")
        await settle { !profile.primary.isLoading }
        XCTAssertTrue(navigation.topViewController === profile && navigation.viewControllers.count == 2,
                      "the server opens from the profile: nothing pops back to Connecting")
        XCTAssertEqual(screen.bodyLabel.string, Strings.HappyCloud.connectingBody, "and nothing failed")
        XCTAssertEqual(screen.context.account.agentConnections.accounts.count, 1, "the server is kept")
        XCTAssertNil(CloudScreens.appleName)
        XCTAssertNil(CloudScreens.takePhotoNote(), "the picture went")
        window?.isHidden = true
    }

    /// A picture that doesn't upload never holds the person up: the server
    /// is kept, and it is said once they have landed.
    func testAPictureThatDoesntUploadIsSaidAfterLanding() async throws {
        let origin = HappyCloud.server(named: "acme")
        let http = CloudHTTP()
        await http.answer("POST /v1/servers/s1/token", 200, #"{"access_token":"\#(token(for: origin + "/"))","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":null,"methods":[]}"#)
        let daemon = CloudDaemon()
        await daemon.answer("/v0/health", #"{"ready":true}"#)
        await daemon.answer("/v0/profile", #"{"profile":{"name":null,"updatedAt":0,"version":"v0"}}"#)
        await daemon.refuse("PUT /v0/profile/photo", 500)
        CloudScreens.appleName = nil
        let screen = CloudConnectingViewController(context: context(), account: CloudAccount.preview(token: "account", http: http),
                                                   server: CloudServer(id: "s1", name: "acme", url: origin + "/", role: .member))
        screen.makeFlow = { try ServerSignInFlow.cloud($0, http: http, makeTransport: { _ in daemon }) }
        let navigation = UINavigationController(rootViewController: screen)
        show(navigation)
        await settle { navigation.topViewController is CloudProfileViewController && navigation.transitionCoordinator == nil }
        let profile = try XCTUnwrap(navigation.topViewController as? CloudProfileViewController)
        XCTAssertEqual(profile.nameField.text.text ?? "", "", "no suggestion, an empty field")
        XCTAssertEqual(profile.seed, "acme")
        XCTAssertFalse(profile.primary.isEnabled)
        profile.nameField.text.text = "Steve"
        profile.edited()
        profile.choose(CloudProfileViewController.previewPhoto())
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        profile.primary.tapped()
        await settle { !profile.primary.isLoading }
        XCTAssertTrue(navigation.topViewController === profile, "opened from the profile")
        XCTAssertEqual(profile.status.string, "", "the name went")
        let patches = await daemon.requests.filter { $0.method == "PATCH" }
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(patches.first?.body)) as? [String: Any]
        XCTAssertNil(body?["email"], "no suggested email, none sent")
        XCTAssertEqual(CloudScreens.takePhotoNote(), "Your photo didn’t upload. You can add it later in Settings › Profile.")
        XCTAssertNil(CloudScreens.takePhotoNote(), "said once")
    }

    /// A member the server already has a name for is never asked again.
    func testANamedMemberIsNotAsked() async throws {
        let origin = HappyCloud.server(named: "acme")
        let http = CloudHTTP()
        await http.answer("POST /v1/servers/s1/token", 200, #"{"access_token":"\#(token(for: origin + "/"))","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        let daemon = CloudDaemon()
        await daemon.answer("/v0/health", #"{"ready":true}"#)
        let screen = CloudConnectingViewController(context: context(), account: CloudAccount.preview(token: "account", http: http),
                                                   server: CloudServer(id: "s1", name: "acme", url: origin + "/", role: .member))
        screen.makeFlow = { try ServerSignInFlow.cloud($0, http: http, makeTransport: { _ in daemon }) }
        let navigation = UINavigationController(rootViewController: screen)
        show(navigation)
        await settle { await daemon.requests.contains { $0.path == "/v0/health" } }
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(navigation.viewControllers.contains { $0 is CloudProfileViewController })
        let asked = await daemon.requests.contains { $0.path.hasPrefix("/v0/profile") }
        XCTAssertFalse(asked)
    }

    func testTappingJoinJoinsAndAMissingCodeSaysSo() async throws {
        let http = CloudHTTP()
        await http.answer("POST /v1/servers/join", 404, #"{"code":"not_found","error":"No such server."}"#)
        let screen = CloudJoinViewController(context: context(), account: CloudAccount.preview(token: "account", http: http))
        show(screen)
        XCTAssertEqual(screen.titleLabel.string, "Join with an invite")
        XCTAssertFalse(screen.primary.isEnabled, "Join server waits for both")
        screen.nameField.text.text = "@acme"
        screen.edited()
        XCTAssertFalse(screen.primary.isEnabled)
        screen.primary.tapped()
        await settle { !screen.status.string.isEmpty }
        XCTAssertEqual(screen.status.string, Strings.HappyCloud.joinMissing)
        await settle { !screen.primary.isLoading }
        let none = await http.requests.count
        XCTAssertEqual(none, 0)

        screen.codeField.text.text = "pcmurcvd"
        screen.edited()
        XCTAssertTrue(screen.primary.isEnabled)
        screen.primary.tapped()
        await settle { screen.status.string == "No server has that name and invite code." }
        XCTAssertEqual(screen.status.string, "No server has that name and invite code.")
        let joined = await http.requests.first
        XCTAssertEqual(try joined.flatMap { try JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }, ["name": "acme", "code": "pcmurcvd"])
    }

    // MARK: The welcome and sign-in

    /// Desktop's five Cloud slides, word for word, and the sign-in under
    /// them: Apple's own button where Start is, Google's under it, GitHub
    /// under that, all as wide.
    func testTheWelcomeIsDesktopsCloudSlidesOverTheSignIn() {
        let welcome = CloudWelcomeViewController(context: context())
        show(UINavigationController(rootViewController: welcome))
        XCTAssertEqual(CloudWelcomeViewController.slides.map(\.title), ["Happy Cloud", "Built for lots of agents", "Programmable permissions", "No lock-in", "Private open source"])
        XCTAssertEqual(CloudWelcomeViewController.slides.first?.body, "A hardened, high-performance control plane for your agents, hosted by Happy.")
        XCTAssertEqual(CloudWelcomeViewController.slides.map(\.art), [.cloud, .scene(.robot), .scene(.closedLock), .scene(.sparkles), .scene(.openHands)])
        XCTAssertEqual(welcome.gallery.dots.numberOfPages, 5)
        let apple = try? XCTUnwrap(welcome.appleButton)
        XCTAssertEqual(apple?.accessibilityIdentifier, "cloud-apple")
        XCTAssertEqual(welcome.github.title, "Sign in with GitHub")
        XCTAssertEqual(welcome.github.display, .filled)
        XCTAssertEqual(welcome.google.accessibilityIdentifier, "cloud-google")
        XCTAssertEqual(welcome.google.accessibilityLabel, "Continue with Google")
        XCTAssertEqual(apple?.frame.width, welcome.github.frame.width)
        XCTAssertEqual(welcome.google.frame.width, welcome.github.frame.width)
        XCTAssertEqual(apple?.frame.minX, welcome.github.frame.minX)
        XCTAssertEqual(welcome.google.frame.minX, welcome.github.frame.minX)
        XCTAssertEqual(welcome.google.frame.height, apple?.frame.height)
        XCTAssertEqual((apple?.frame.maxY ?? 0) + 12, welcome.google.frame.minY)
        XCTAssertEqual(welcome.google.frame.maxY + 12, welcome.github.frame.minY)
        XCTAssertGreaterThan(apple?.frame.minY ?? 0, welcome.gallery.frame.maxY)
        XCTAssertEqual(welcome.note.string, "")
        XCTAssertEqual(welcome.note.frame.height, 0)
        XCTAssertNil(Self.find("cloud-continue", in: welcome.view), "no Continue: the sign-in is here")
        XCTAssertNil(Self.find("cloud-connect", in: welcome.view), "no Other Ways to Sign In")
    }

    /// The pass ended: the welcome says so over the buttons.
    func testAnEndedPassSaysSoOverTheButtons() {
        let welcome = CloudWelcomeViewController(context: context(), expired: true)
        show(UINavigationController(rootViewController: welcome))
        XCTAssertEqual(welcome.note.string, "Your Happy Cloud sign-in has ended. Sign in again.")
        XCTAssertGreaterThan(welcome.note.frame.height, 0)
        XCTAssertLessThanOrEqual(welcome.note.frame.maxY + 12, (welcome.appleButton?.frame.minY ?? 0) + 0.5)
    }

    /// While the pass lasts the flow opens on Join a server; after, on the
    /// welcome.
    func testALivePassOpensOnTheServers() {
        CloudScreens.account = CloudAccount.preview(token: "account", http: CloudHTTP())
        XCTAssertTrue(CloudScreens.first(context: context()) is CloudServersViewController)
        CloudScreens.account = CloudAccount.preview(token: "account", expiresAt: Date(timeIntervalSinceNow: -60), http: CloudHTTP())
        XCTAssertTrue(CloudScreens.first(context: context()) is CloudWelcomeViewController)
        XCTAssertNil(CloudScreens.account)
    }

    /// The first slide's art is the cloud in liquid metal, 1.3 times the
    /// art's square; it moves while its slide shows and holds still once
    /// another slides in, or the screen goes.
    func testTheFirstSlideIsTheLiquidMetalCloudMovingOnlyWhileItShows() {
        let welcome = CloudWelcomeViewController(context: context())
        show(UINavigationController(rootViewController: welcome))
        welcome.gallery.isRunning = true
        let cloud = Self.find("cloud-liquid-metal", in: welcome.view) as? LiquidMetalView
        XCTAssertNotNil(cloud)
        XCTAssertEqual(cloud?.frame.width ?? 0, 124.8, accuracy: 0.5, "1.3 times the 96 art square, on whole pixels")
        XCTAssertEqual(cloud?.frame.height ?? 0, 124.8, accuracy: 0.5)
        XCTAssertEqual(cloud?.isPaused, false)
        welcome.gallery.show(1, animated: false)
        XCTAssertEqual(cloud?.isPaused, true, "out of view")
        welcome.gallery.show(0, animated: false)
        XCTAssertEqual(cloud?.isPaused, false)
        welcome.gallery.isRunning = false
        XCTAssertEqual(cloud?.isPaused, true, "the screen went")
    }

    private static func tap(_ screen: CloudWelcomeViewController, _ times: Int, every seconds: TimeInterval, from start: Date) {
        for index in 0..<times { screen.logoTapped(at: start.addingTimeInterval(Double(index) * seconds)) }
    }

    func testTenTapsOnTheLogoWithinFourSecondsOpenTheTestSignInAndNothingFewer() async {
        let start = Date(timeIntervalSince1970: 1_000)
        let slow = CloudWelcomeViewController(context: context())
        let slowNavigation = UINavigationController(rootViewController: slow)
        show(slowNavigation)
        XCTAssertNotNil(slow.gallery.onArtTap, "the logo hears taps")
        Self.tap(slow, 9, every: 0.3, from: start)
        XCTAssertEqual(slowNavigation.viewControllers.count, 1, "nine taps")
        Self.tap(slow, 1, every: 0, from: start.addingTimeInterval(4.2))
        XCTAssertEqual(slowNavigation.viewControllers.count, 1, "the tenth came after four seconds")

        let quick = CloudWelcomeViewController(context: context())
        let navigation = UINavigationController(rootViewController: quick)
        show(navigation)
        Self.tap(quick, 10, every: 0.3, from: start)
        await settle { navigation.topViewController is CloudTestSignInViewController }
        let signIn = navigation.topViewController as? CloudTestSignInViewController
        signIn?.loadViewIfNeeded()
        let form = signIn?.testSignIn
        XCTAssertTrue(form?.password.text.isSecureTextEntry == true)
        XCTAssertNotNil(signIn.flatMap { Self.find("cloud-test-sign-in", in: $0.view) })
    }

    func testAProductionBuildHasNoTestSignIn() {
        let screen = CloudWelcomeViewController(context: context(.production))
        let navigation = UINavigationController(rootViewController: screen)
        show(navigation)
        XCTAssertNil(screen.gallery.onArtTap)
        Self.tap(screen, 10, every: 0.1, from: Date())
        XCTAssertEqual(navigation.viewControllers.count, 1)
        let signIn = CloudTestSignInViewController(context: context(.production))
        signIn.loadViewIfNeeded()
        XCTAssertNil(signIn.testSignIn)
    }

    func testATestAccountSignsInWithItsPasswordAndSaysWhyNot() async throws {
        let http = CloudHTTP()
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = http
        let navigation = UINavigationController(rootViewController: welcome)
        show(navigation)
        Self.tap(welcome, 10, every: 0.1, from: Date())
        await settle { navigation.topViewController is CloudTestSignInViewController }
        let screen = try XCTUnwrap(navigation.topViewController as? CloudTestSignInViewController)
        screen.loadViewIfNeeded()
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
        await http.answer("GET /v1/servers", 200, #"{"servers":[{"id":"s1","name":"acme","url":"","role":"owner"}]}"#)
        form.password.text.text = "right"
        form.button.tapped()
        // The stack holds the step going out until the push is over.
        await settle { navigation.topViewController is CloudServersViewController && navigation.transitionCoordinator == nil }
        XCTAssertTrue(navigation.topViewController is CloudServersViewController, "signed in, as after Apple")
        XCTAssertEqual(navigation.viewControllers.count, 1, "the servers in the place of every sign-in step: Back never returns to one")
        XCTAssertEqual(screen.problem.string, "")
        XCTAssertEqual(form.password.text.text ?? "", "", "the password is gone from the field")
        await settle { await http.requests.contains { $0.url.path == "/v1/servers" } }
        let listed = await http.requests.last { $0.url.path == "/v1/servers" }
        XCTAssertEqual(listed?.headers["Authorization"], "Bearer \(pass)")
        CloudScreens.account = nil
    }

    // MARK: Join a server

    /// Each server with its name, `@name` and Join; no Continue until one
    /// is joined; Bootstrap a new one and Join with an invite under them.
    func testTheServersEachHaveJoin() async throws {
        let account = CloudAccount.preview(token: "account", http: CloudHTTP())
        let servers = [CloudServer(id: "s1", name: "acme", url: "", role: .owner, displayName: "Acme"),
                       CloudServer(id: "s2", name: "globex", url: "", role: .member)]
        let screen = CloudServersViewController(context: context(), account: account, load: { servers })
        let navigation = UINavigationController(rootViewController: CloudWelcomeViewController(context: context()))
        navigation.pushViewController(screen, animated: false)
        show(navigation)
        await settle { Self.find("cloud-server-globex", in: screen.view) != nil }
        XCTAssertEqual(screen.titleLabel.string, "Join a server")
        XCTAssertEqual(screen.bodyLabel.string, "Your account is already on these servers. Join as many as you like.")
        let join = try XCTUnwrap(Self.find("cloud-server-acme", in: screen.view) as? RoundButton)
        XCTAssertEqual(join.title, "Join")
        XCTAssertEqual(join.accessibilityLabel, "Join Acme")
        XCTAssertTrue(screen.primary.isHidden, "no Continue before a join")
        XCTAssertEqual(screen.bootstrap.title, "Bootstrap a new one")
        XCTAssertEqual(screen.invite.title, "Join with an invite")
        XCTAssertFalse(screen.bootstrap.isHidden)
        screen.view.layoutIfNeeded()
        XCTAssertGreaterThan(screen.bootstrap.frame.minY, join.convert(join.bounds, to: screen.content).maxY)
    }

    /// No server yet: Bootstrap a server leads, says so, offers an invite,
    /// and Back from it signs the account out.
    func testNoServersLeadsToBootstrapWhoseBackSignsOut() async throws {
        let account = CloudAccount.preview(token: "account", http: CloudHTTP())
        CloudScreens.account = account
        let welcome = CloudWelcomeViewController(context: context())
        let navigation = UINavigationController(rootViewController: welcome)
        navigation.pushViewController(CloudServersViewController(context: context(), account: account, load: { [] }), animated: false)
        show(navigation)
        await settle { navigation.topViewController is CloudCreateViewController && navigation.transitionCoordinator == nil }
        let create = try XCTUnwrap(navigation.topViewController as? CloudCreateViewController)
        create.loadViewIfNeeded()
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertEqual(create.titleLabel.string, "Bootstrap a server")
        XCTAssertEqual(create.bodyLabel.string, "Your account has no servers yet. Name your team’s first one.")
        XCTAssertFalse(create.invite.isHidden)
        XCTAssertEqual(create.invite.title, "Have an invite? Join a server")
        XCTAssertFalse(create.primary.isEnabled, "Bootstrap waits for a free name")
        XCTAssertTrue(create.signsOutOnBack)
        navigation.popViewController(animated: false)
        await settle { CloudScreens.account == nil }
        XCTAssertNil(CloudScreens.account, "Back signed the account out")
        XCTAssertFalse(CloudCreateViewController(context: context(), account: account).signsOutOnBack, "a second server's Back doesn't")
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
