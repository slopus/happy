import XCTest

/// A team server behind an SSO load balancer, end to end against the edge
/// mock (`scripts/edge-sso-mock/run-ui-test.sh` starts it and trusts its
/// CA in this simulator only). The managed configuration (`serverUrl`
/// https://localhost:8443, everything else off) makes the app open on
/// signing in to that server. The test signs in through the
/// browser, gives its name to the profile gate, lands on the server's home,
/// survives its access tokens being expired (refresh), sees "Sign in again"
/// once the SSO session ends, and signs in again.
@MainActor
final class ServerSignInUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    private static let server = "https://localhost:8443"

    override func setUp() { continueAfterFailure = false }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The mock's test controls: expire every access token, end the SSO
    /// session, or let it sign in again.
    private func control(_ action: String) {
        let done = expectation(description: action)
        URLSession.shared.dataTask(with: URL(string: "\(Self.server)/control/\(action)")!) { _, response, error in
            XCTAssertNil(error, "control \(action)")
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
    }

    /// Continue on iOS's "wants to use … to sign in", then the IdP's page.
    private func signInInBrowser(_ shot: String?) {
        let consent = springboard.alerts.buttons["Continue"]
        XCTAssertTrue(consent.waitForExistence(timeout: 20), "no sign-in consent")
        consent.tap()
        let deadline = Date().addingTimeInterval(30)
        var link: XCUIElement?
        while Date() < deadline, link == nil {
            for candidate in [app.links["Continue to Happy"], browser.links["Continue to Happy"], springboard.links["Continue to Happy"]] where candidate.exists {
                link = candidate
            }
            if link == nil { Thread.sleep(forTimeInterval: 0.5) }
        }
        guard let link else { return XCTFail("the identity provider's page never showed") }
        if let shot { capture(shot) }
        link.tap()
    }

    /// Leaves for the home screen and back: the app reconnects at once.
    private func bounce() {
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.activate()
    }

    /// What an MDM would deliver, through the argument domain so the run
    /// needs no profile; the app reads it the same way.
    private static let managed = """
    <dict><key>serverUrl</key><string>\(server)</string><key>allowAdditionalServers</key><false/>\
    <key>analyticsEnabled</key><false/><key>hostedRelayEnabled</key><false/>\
    <key>tailcatEnabled</key><false/><key>phonePairingEnabled</key><false/></dict>
    """

    func testSignInRefreshAndSignInAgain() {
        app.launchArguments = ["-com.apple.configuration.managed", Self.managed]
        app.launch()

        // The managed server opens by itself, its address filled in and fixed.
        let address = element("server-sign-in-url")
        XCTAssertTrue(address.waitForExistence(timeout: 30), "the managed server's sign-in didn't open")
        XCTAssertEqual(address.value as? String, Self.server)
        XCTAssertFalse(address.isEnabled)
        capture("1-managed-server")
        element("server-sign-in-continue").tap()
        signInInBrowser("2-identity-provider")

        // First time on this server: the profile gate wants a name.
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 20), "no name prompt")
        name.typeText("Steve")
        capture("3-name")
        app.alerts.buttons["Continue"].tap()

        let task = element("row:space:Behind the SSO load balancer")
        XCTAssertTrue(task.waitForExistence(timeout: 60), "the server's home didn't show")
        capture("4-home")

        // Expired access tokens: the next requests refresh and carry on.
        control("expire")
        bounce()
        Thread.sleep(forTimeInterval: 6)
        XCTAssertTrue(task.waitForExistence(timeout: 10), "home went away after a refresh")

        app.buttons["settings"].firstMatch.tap()
        XCTAssertTrue(element("settings:server-sign-in").waitForExistence(timeout: 10))
        XCTAssertTrue(element("settings:server").exists)
        XCTAssertFalse(element("settings:disconnect").exists, "the managed server can be removed")
        XCTAssertFalse(element("settings:connect-agent").exists, "another server can be added")
        capture("5-settings")

        // The SSO session ends: everything is redirected to the IdP and the
        // refresh is refused.
        control("revoke")
        bounce()
        let needsSignIn = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sign in again")).firstMatch
        XCTAssertTrue(needsSignIn.waitForExistence(timeout: 30), "no Sign in again")
        XCTAssertFalse(element("settings:connect-agent").exists, "only Sign in again renews the managed server")
        capture("6-needs-sign-in")

        control("restore")
        element("settings:server-sign-in").tap()
        let again = element("server-sign-in-continue")
        XCTAssertTrue(again.waitForExistence(timeout: 10))
        capture("7-sign-in-again")
        again.tap()
        signInInBrowser(nil)
        let connected = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Connected")).firstMatch
        XCTAssertTrue(connected.waitForExistence(timeout: 60), "not connected again")
        XCTAssertFalse(needsSignIn.exists)
        capture("8-signed-in-again")
    }

    /// On a phone, where the mock isn't reachable: a managed server whose
    /// `/v0/authentication` is answered by a plain website (an edge in front
    /// of Happy, as far as the app can tell) is refused with the
    /// administrator's fix, over the real network. Runs only with
    /// `TEST_RUNNER_HAPPY_EDGE_DEVICE=1`.
    func testDiscoveryAnsweredByTheEdgeOnADevice() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HAPPY_EDGE_DEVICE"] == "1")
        app.launchArguments = ["-com.apple.configuration.managed", Self.managed.replacingOccurrences(of: Self.server, with: "https://example.com")]
        app.launch()
        let address = element("server-sign-in-url")
        XCTAssertTrue(address.waitForExistence(timeout: 30), "the managed server's sign-in didn't open")
        XCTAssertEqual(address.value as? String, "https://example.com")
        capture("device-1-managed-server")
        element("server-sign-in-continue").tap()
        let refused = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "/v0/authentication")).firstMatch
        XCTAssertTrue(refused.waitForExistence(timeout: 30), "no refusal")
        capture("device-2-edge-answered")
    }
}
