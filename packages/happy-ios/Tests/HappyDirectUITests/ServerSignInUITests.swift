import XCTest

/// A team server behind an SSO load balancer, end to end against the edge
/// mock (`scripts/edge-sso-mock/run-ui-test.sh` starts it and trusts its
/// CA in this simulator only). The phone adds it only by scanning Happy
/// Desktop's server code; the simulator has no camera, so each launch hands
/// the scanner its code (`HAPPY_SIMULATED_SCAN`). The test is refused a
/// server under a path and the code opened as a link, signs in to a code
/// naming another installation and is refused after the browser, then
/// scans the right one on the very first screen: signs in through the
/// browser, gives its name to the profile gate, lands on the server's home,
/// comes back signed in after being killed and launched again (the
/// Keychain's refresh token, no browser), survives its access tokens
/// being expired (refresh), sees "Sign in again" once the SSO session ends,
/// signs in again, opens instance links from outside (its own
/// installation's, and refuses any other), and scanning the code again
/// adds nothing.
@MainActor
final class ServerSignInUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    private static let server = "https://localhost:8443"
    /// The mock's health `instanceId`.
    private static let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    /// Happy Desktop's code for the mock, its escapes in lowercase hex.
    private static let code = "happy://\(instance)/server?url=https%3a%2f%2flocalhost%3a8443%2f"

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

    /// Tokens the mock issued, by grant type.
    private func grants() -> [String: Int] {
        let done = expectation(description: "grants")
        var result: [String: Int] = [:]
        URLSession.shared.dataTask(with: URL(string: "\(Self.server)/control/grants")!) { data, _, error in
            XCTAssertNil(error, "control grants")
            result = data.flatMap { try? JSONDecoder().decode([String: Int].self, from: $0) } ?? [:]
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return result
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

    /// `url` opened by another app: iOS asks whether to open it in Happy.
    private func openFromOutside(_ url: URL) {
        app.open(url)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
    }

    /// Leaves for the home screen and back: the app reconnects at once.
    private func bounce() {
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.activate()
    }

    /// Launched with the scanner reading `code`.
    private func launch(scanning code: String) {
        app.terminate()
        app.launchEnvironment["HAPPY_SIMULATED_SCAN"] = code
        app.launch()
    }

    /// The camera's permission prompt, which may still ask in the simulator.
    private func allowCamera() {
        for button in ["Allow", "OK"] where springboard.alerts.buttons[button].exists {
            springboard.alerts.buttons[button].tap()
        }
    }

    /// Start, whose scanner reads the launch's code.
    private func scanFromStart() {
        let start = app.buttons["start-button"]
        XCTAssertTrue(start.waitForExistence(timeout: 30), "no Start")
        start.tap()
        Thread.sleep(forTimeInterval: 1)
        allowCamera()
    }

    /// The sign-in screen a scanned code opened, showing its server, and on.
    private func continueToSignIn(shot: String) {
        let address = element("server-sign-in-url")
        XCTAssertTrue(address.waitForExistence(timeout: 10), "the sign-in screen didn't open")
        XCTAssertFalse(address.isEnabled, "the server can be typed")
        XCTAssertEqual(address.value as? String, Self.server)
        capture(shot)
        element("server-sign-in-continue").tap()
    }

    private func alert(containing text: String) -> XCUIElement {
        app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testSignInRefreshAndSignInAgain() {
        // A server under a path can't be reached from a phone yet: nothing starts.
        launch(scanning: "happy://\(Self.instance)/server?url=https%3A%2F%2Flocalhost%3A8443%2Fhappy%2F")
        scanFromStart()
        XCTAssertTrue(alert(containing: "web address path").waitForExistence(timeout: 10), "a server under a path wasn't refused")
        capture("1-path-prefix")
        app.alerts.buttons.firstMatch.tap()
        // A server code opened as a link adds nothing.
        openFromOutside(URL(string: Self.code)!)
        XCTAssertTrue(alert(containing: "works only when you scan it").waitForExistence(timeout: 10), "a server code opened as a link")
        capture("2-scan-only")
        app.alerts.buttons.firstMatch.tap()

        // A code naming another installation: refused once health answers,
        // after the sign-in, and nothing is kept.
        launch(scanning: "happy://zzzzzzzzzzzzzzzzzzzzzzzz/server?url=https%3A%2F%2Flocalhost%3A8443%2F")
        scanFromStart()
        continueToSignIn(shot: "3-scanned-other-installation")
        signInInBrowser(nil)
        let mismatch = app.staticTexts["This code doesn’t match the server it points to."]
        XCTAssertTrue(mismatch.waitForExistence(timeout: 30), "another installation's code wasn't refused")
        capture("4-wrong-server")

        launch(scanning: Self.code)
        XCTAssertTrue(app.buttons["start-button"].waitForExistence(timeout: 30), "a refused code kept the server")
        scanFromStart()
        continueToSignIn(shot: "5-scanned-server")
        signInInBrowser("6-identity-provider")

        // First time on this server: the profile gate wants a name.
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 20), "no name prompt")
        name.typeText("Steve")
        capture("7-name")
        app.alerts.buttons["Continue"].tap()

        let task = element("row:space:Behind the SSO load balancer")
        XCTAssertTrue(task.waitForExistence(timeout: 60), "the server's home didn't show")
        capture("8-home")

        // Killed and launched again: the Keychain's refresh token restores
        // the session without the browser or a new authorization code.
        let before = grants()
        app.terminate()
        app.launch()
        XCTAssertTrue(task.waitForExistence(timeout: 60), "the session didn't come back after a relaunch")
        XCTAssertFalse(springboard.alerts.buttons["Continue"].exists, "a relaunch asked to sign in")
        let after = grants()
        XCTAssertEqual(after["authorization_code"], before["authorization_code"], "a relaunch signed in again")
        XCTAssertGreaterThan(after["refresh_token"] ?? 0, before["refresh_token"] ?? 0, "a relaunch didn't refresh")
        capture("9-relaunched")

        // Expired access tokens: the next requests refresh and carry on.
        control("expire")
        bounce()
        Thread.sleep(forTimeInterval: 6)
        XCTAssertTrue(task.waitForExistence(timeout: 10), "home went away after a refresh")

        app.buttons["settings"].firstMatch.tap()
        XCTAssertTrue(element("settings:server-sign-in").waitForExistence(timeout: 10))
        XCTAssertTrue(element("settings:server").exists)
        XCTAssertTrue(element("settings:disconnect").exists, "the server can't be signed out of")
        capture("10-settings")

        // The SSO session ends: everything is redirected to the IdP and the
        // refresh is refused.
        control("revoke")
        bounce()
        let needsSignIn = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sign in again")).firstMatch
        XCTAssertTrue(needsSignIn.waitForExistence(timeout: 30), "no Sign in again")
        capture("11-needs-sign-in")

        control("restore")
        element("settings:server-sign-in").tap()
        let again = element("server-sign-in-continue")
        XCTAssertTrue(again.waitForExistence(timeout: 10))
        capture("12-sign-in-again")
        again.tap()
        signInInBrowser(nil)
        let connected = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Connected")).firstMatch
        XCTAssertTrue(connected.waitForExistence(timeout: 60), "not connected again")
        XCTAssertFalse(needsSignIn.exists)
        capture("13-signed-in-again")

        // A link from outside opens only on the installation it names: the
        // mock's health `instanceId`, read while connecting.
        openFromOutside(URL(string: "happy://\(Self.instance)/artifacts/q3report")!)
        XCTAssertTrue(element("artifact").waitForExistence(timeout: 20), "the instance link didn't open its artifact")
        XCTAssertTrue(app.navigationBars.staticTexts["Q3 report"].waitForExistence(timeout: 10), "not the linked artifact")
        XCTAssertTrue(element("artifact-copy-link").exists, "no Copy Link")
        capture("14-instance-link")
        // Another installation's link never falls back to this one.
        openFromOutside(URL(string: "happy://zzzzzzzzzzzzzzzzzzzzzzzz/artifacts/q3report")!)
        let unknown = app.alerts.staticTexts["This link belongs to a Happy server you’re not connected to."]
        XCTAssertTrue(unknown.waitForExistence(timeout: 10), "an unknown installation's link wasn't refused")
        capture("15-unknown-instance")
        app.alerts.buttons.firstMatch.tap()
        // Nor does one naming no installation open from outside.
        openFromOutside(URL(string: "happy://artifacts/q3report")!)
        XCTAssertTrue(app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "doesn’t say which Happy server")).firstMatch.waitForExistence(timeout: 10),
                      "a link naming no installation opened")
        app.alerts.buttons.firstMatch.tap()

        // Scanning the code again shows this server and adds nothing.
        app.buttons["settings"].firstMatch.tap()
        let add = element("settings:connect-agent")
        XCTAssertTrue(add.waitForExistence(timeout: 10), "no Add Agent")
        add.tap()
        Thread.sleep(forTimeInterval: 3)
        allowCamera()
        XCTAssertFalse(element("server-sign-in-url").exists, "a connected server's code started a sign-in")
        XCTAssertTrue(task.waitForExistence(timeout: 20), "the server's home didn't come forward")
        capture("16-already-connected")
    }

    /// On a phone, where the mock isn't reachable: a scanned server whose
    /// `/v0/authentication` is answered by a plain website (an edge in front
    /// of Happy, as far as the app can tell) is refused with the
    /// administrator's fix, over the real network. Runs only with
    /// `TEST_RUNNER_HAPPY_EDGE_DEVICE=1`.
    func testDiscoveryAnsweredByTheEdgeOnADevice() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HAPPY_EDGE_DEVICE"] == "1")
        launch(scanning: "happy://\(Self.instance)/server?url=https%3A%2F%2Fexample.com%2F")
        scanFromStart()
        let address = element("server-sign-in-url")
        XCTAssertTrue(address.waitForExistence(timeout: 10), "the sign-in screen didn't open")
        capture("device-1-scanned-server")
        element("server-sign-in-continue").tap()
        let refused = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "/v0/authentication")).firstMatch
        XCTAssertTrue(refused.waitForExistence(timeout: 30), "no refusal")
        capture("device-2-edge-answered")
    }
}
