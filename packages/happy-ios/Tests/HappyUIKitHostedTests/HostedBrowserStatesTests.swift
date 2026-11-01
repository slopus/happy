#if canImport(UIKit)
@testable import HappyCore
@testable import HappyUI
import UIKit
import WebKit
import XCTest

/// A fake computer behind the real proxy, whose pages, delays and failures
/// a test sets: WebKit still speaks real HTTP through our loopback listener.
actor BrowserStateDaemon: AgentTransport {
    struct Page {
        var status = 200
        var body: String
        /// Before the head is sent.
        var delay: Duration = .zero
        /// Between the first half of the body and the rest.
        var gap: Duration = .zero
    }

    var pages: [String: Page] = [:]
    /// Every connection to the computer fails: the link is down.
    var down = false
    /// Targets whose CONNECT the computer refuses, with its status.
    var refused: [String: Int] = [:]
    /// Artifact files whose upstream read fails, so the proxy answers 502.
    var failing: Set<String> = []
    private(set) var requests: [String] = []

    func set(_ path: String, _ page: Page) { pages[path] = page }
    func setDown(_ value: Bool) { down = value }
    func refuse(_ target: String, _ status: Int?) { refused[target] = status }
    func fail(_ path: String) { failing.insert(path) }
    func gets(_ path: String) -> Int { requests.filter { $0 == "GET \(path) HTTP/1.1" }.count }

    func browserConnection() async throws -> any BrowserStream {
        if down { throw URLError(.networkConnectionLost) }
        return Socket(self)
    }
    func close() async {}
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        HTTP1Response(status: 200, body: Data("{}".utf8))
    }

    enum Answer {
        case established(tls: Bool)
        case respond(head: Data, body: Data, delay: Duration, gap: Duration)
        case fail
    }

    func answer(_ head: BrowserHTTPHead) -> Answer {
        requests.append(head.line)
        let parts = head.line.split(separator: " ")
        let target = parts.count > 1 ? String(parts[1]) : "/"
        if head.line.hasPrefix("CONNECT ") {
            if target.hasPrefix("/v0/") { return .established(tls: false) }
            if let status = refused[target] {
                return .respond(head: Data("HTTP/1.1 \(status) Refused\r\nContent-Length: 0\r\n\r\n".utf8), body: Data(), delay: .zero, gap: .zero)
            }
            return .established(tls: target.hasSuffix(":8443"))
        }
        let path = target.components(separatedBy: "/files").last ?? target
        if failing.contains(path) { return .fail }
        let page = pages[path] ?? Page(body: Self.page(title: "Remote preview", text: "ready"))
        let body = Data(page.body.utf8)
        let reason = HTTPURLResponse.localizedString(forStatusCode: page.status).capitalized
        let head = "HTTP/1.1 \(page.status) \(reason)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        return .respond(head: Data(head.utf8), body: body, delay: page.delay, gap: page.gap)
    }

    nonisolated static func page(title: String, text: String) -> String {
        """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
        <title>\(title)</title></head><body style="font:18px -apple-system;padding:0 20px;margin:0">
        <h1 style="margin-top:12px">\(title)</h1><p id="result">\(text)</p>
        <p><a id="next" href="/second">Second page</a> · <a id="app" href="happy-nowhere://open">An app link</a></p>
        \((1...30).map { "<p>Paragraph \($0) of a page served by your computer.</p>" }.joined())
        </body></html>
        """
    }

    private actor Socket: BrowserStream {
        let daemon: BrowserStateDaemon
        var buffer = Data()
        var pending = Data()
        var reader: CheckedContinuation<Data, Error>?
        var ended = false
        var failure: (any Error)?
        var tls = false
        init(_ daemon: BrowserStateDaemon) { self.daemon = daemon }

        func read(maximumBytes: Int) async throws -> Data {
            if !pending.isEmpty { let data = Data(pending.prefix(maximumBytes)); pending.removeFirst(data.count); return data }
            if let failure { throw failure }
            if ended { return Data() }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { reader = $0 }
            } onCancel: { Task { await self.close() } }
        }

        func write(_ data: Data) async throws {
            if tls {
                // Plain text where a TLS handshake belongs.
                tls = false
                deliver(Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nno".utf8), end: true)
                return
            }
            buffer.append(data)
            guard let (head, body) = try BrowserHTTPHead.parse(buffer), body.count >= (Int(head.value("Content-Length") ?? "0") ?? 0) else { return }
            buffer = Data()
            switch await daemon.answer(head) {
            case .established(let tls):
                self.tls = tls
                deliver(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8), end: false)
            case .fail:
                failure = URLError(.networkConnectionLost)
                wake()
            case .respond(let head, let body, let delay, let gap):
                let half = body.count / 2
                Task {
                    if delay > .zero { try? await Task.sleep(for: delay) }
                    self.deliver(head + body.prefix(gap > .zero ? half : body.count), end: gap == .zero)
                    guard gap > .zero else { return }
                    try? await Task.sleep(for: gap)
                    self.deliver(body.suffix(from: half), end: true)
                }
            }
        }

        private func deliver(_ data: Data, end: Bool) {
            pending.append(data)
            if end { ended = true }
            wake()
        }

        private func wake() {
            guard let reader else { return }
            if !pending.isEmpty { self.reader = nil; let bytes = pending; pending = Data(); reader.resume(returning: bytes) }
            else if let failure { self.reader = nil; reader.resume(throwing: failure) }
            else if ended { self.reader = nil; reader.resume(returning: Data()) }
        }

        func close() async { ended = true; reader?.resume(returning: Data()); reader = nil }
    }
}

private struct BrowserShellNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct BrowserShellNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct BrowserShellUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// The browser's header, loading bar and error page against real WebKit:
/// each failure a person can meet, the bar's whole run, and the buttons.
/// With `HAPPY_PREVIEW_DIR` set, it writes light and dark pictures of each.
@MainActor
final class HostedBrowserStatesTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func show(_ browser: BrowserViewController) async throws -> UIWindow {
        let navigation = UINavigationController(rootViewController: UIViewController())
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.pushViewController(browser, animated: false)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        window.layoutIfNeeded()
        return window
    }

    private func open(_ daemon: BrowserStateDaemon, url: String = "http://localhost:5173/", record: ((BrowserProgress) -> Void)? = nil) async throws -> (UIWindow, BrowserViewController) {
        let page = try await BrowserPage.workspace(client: AgentClient(transport: daemon, token: "native-secret"), url: XCTUnwrap(URL(string: url)), workspaceID: "work1")
        let browser = BrowserViewController(url: page.url, page: page)
        browser.progressChanged = record
        return (try await show(browser), browser)
    }

    private func until(_ what: String, timeout: Duration = .seconds(20), _ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTFail("Timed out waiting for \(what)")
        throw BrowserError.timeout
    }

    private func loaded(_ browser: BrowserViewController) async throws {
        try await until("the page to load") { browser.web?.isLoading == false && browser.web?.url != nil && browser.progress.phase == .hidden }
    }

    private func failed(_ browser: BrowserViewController, _ problem: BrowserProblem) async throws {
        try await until("the error page for \(problem)") { browser.problem != nil && !browser.failureView.isHidden }
        XCTAssertEqual(browser.problem, problem)
        XCTAssertEqual(browser.progress.phase, .hidden, "A failure never leaves the bar up")
    }

    private func text(_ web: WKWebView?) async -> String? {
        try? await web?.evaluateJavaScript("document.querySelector('#result')?.textContent") as? String
    }

    func testPageRunsUnderTheHeaderAndTheBarStartsCreepsCompletesAndFades() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.set("/", .init(body: BrowserStateDaemon.page(title: "Remote preview", text: "ready"), delay: .milliseconds(1200), gap: .milliseconds(500)))
        var history: [BrowserProgress] = []
        let (window, browser) = try await open(daemon) { history.append($0) }
        defer { window.isHidden = true }
        XCTAssertEqual(history.first?.phase, .loading)
        XCTAssertEqual(history.first?.value, BrowserProgress.start)
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertGreaterThan(browser.progress.value, BrowserProgress.start, "While the tunnel opens the bar creeps on its own")
        XCTAssertEqual(browser.reloadItem.accessibilityLabel, Strings.Browser.stop)
        try await shots(window, "browser-loading")
        try await loaded(browser)

        let loading = history.prefix { $0.phase == .loading }.map(\.value)
        XCTAssertGreaterThan(loading.count, 3)
        XCTAssertEqual(loading, loading.sorted(), "The bar never goes back within a load")
        XCTAssertEqual(Array(history.suffix(2).map(\.phase)), [.finishing, .hidden])
        XCTAssertEqual(history.last(where: { $0.phase == .finishing })?.value, 1)
        let bar = try XCTUnwrap(browser.view.subviews.first { $0 is BrowserProgressView })
        XCTAssertEqual(bar.alpha, 0)
        XCTAssertEqual(bar.frame.minY, browser.view.safeAreaInsets.top, "The bar sits on the header's bottom edge")

        let web = try XCTUnwrap(browser.web)
        XCTAssertEqual(web.frame, browser.view.bounds, "The page runs under the header and the home indicator")
        XCTAssertEqual(web.scrollView.adjustedContentInset.top, browser.view.safeAreaInsets.top)
        XCTAssertEqual(web.isOpaque, false)
        XCTAssertEqual(browser.navigationItem.title, "Remote preview")
        XCTAssertEqual(browser.navigationItem.subtitle, "localhost")
        XCTAssertNil(browser.view.subviews.first { $0.accessibilityIdentifier == "browser-route" }, "No “via <computer>” line")
        XCTAssertNil(browser.view.subviews.first { $0 is UIToolbar }, "Navigation is in the header, not a bottom toolbar")
        XCTAssertEqual(browser.navigationItem.rightBarButtonItems?.count, 5)
        try await shots(window, "browser-page")
    }

    func testButtonsFollowHistoryAndTheBackSwipeIsThePagesUntilTheFirstPage() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.set("/second", .init(body: BrowserStateDaemon.page(title: "Second page", text: "second")))
        let (window, browser) = try await open(daemon)
        defer { window.isHidden = true }
        try await loaded(browser)
        XCTAssertFalse(browser.backItem.isEnabled)
        XCTAssertFalse(browser.forwardItem.isEnabled)
        XCTAssertFalse(browser.takesBackSwipe, "On the first page the swipe closes the screen")
        XCTAssertEqual(browser.reloadItem.accessibilityLabel, Strings.Browser.reload)

        _ = try await browser.web?.evaluateJavaScript("document.querySelector('#next').click()")
        try await until("the second page") { await text(browser.web) == "second" }
        try await loaded(browser)
        XCTAssertTrue(browser.backItem.isEnabled)
        XCTAssertFalse(browser.forwardItem.isEnabled)
        XCTAssertTrue(browser.takesBackSwipe, "With history the swipe goes back a page")
        XCTAssertEqual(browser.navigationItem.title, "Second page")

        browser.goBack()
        try await until("the first page again") { await text(browser.web) == "ready" }
        try await until("forward to enable") { browser.forwardItem.isEnabled }
        try await loaded(browser)
        XCTAssertFalse(browser.backItem.isEnabled)
        XCTAssertFalse(browser.takesBackSwipe)

        // Stop while loading: no error, and the bar goes.
        await daemon.set("/slow", .init(body: BrowserStateDaemon.page(title: "Slow", text: "slow"), delay: .seconds(5)))
        browser.web?.load(URLRequest(url: try XCTUnwrap(URL(string: "http://localhost:5173/slow"))))
        try await until("the slow page to be asked for") { await daemon.gets("/slow") == 1 }
        XCTAssertEqual(browser.reloadItem.accessibilityLabel, Strings.Browser.stop)
        browser.reloadOrStop()
        try await until("the load to stop") { browser.web?.isLoading == false && browser.progress.phase == .hidden }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(browser.problem, "Stopping is not a failure")
        XCTAssertEqual(browser.reloadItem.accessibilityLabel, Strings.Browser.reload)
    }

    func testAReplacedLoadIsCancelledWithoutAnError() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.set("/slow", .init(body: BrowserStateDaemon.page(title: "Slow", text: "slow"), delay: .seconds(3)))
        let (window, browser) = try await open(daemon, url: "http://localhost:5173/slow")
        defer { window.isHidden = true }
        let web = try await waitForWeb(browser)
        try await Task.sleep(for: .milliseconds(300))
        web.load(URLRequest(url: try XCTUnwrap(URL(string: "http://localhost:5173/second"))))
        try await until("the second page") { await text(browser.web) == "ready" }
        try await loaded(browser)
        XCTAssertNil(browser.problem)
        XCTAssertTrue(browser.failureView.isHidden)
    }

    func testComputerUnreachableAndItsReturnRetriesByItself() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.setDown(true)
        let (window, browser) = try await open(daemon)
        defer { window.isHidden = true }
        try await failed(browser, .computerUnreachable)
        XCTAssertEqual(browser.failureView.shownTitle, "Can’t Reach \(Strings.agentConnection)")
        XCTAssertEqual(browser.navigationItem.title, "localhost")
        try await shots(window, "browser-error-computer-unreachable")

        await daemon.setDown(false)
        browser.linkChanged(.offline)
        browser.linkChanged(.online)
        try await until("the page after the computer came back") { await text(browser.web) == "ready" }
        XCTAssertNil(browser.problem)
        XCTAssertTrue(browser.failureView.isHidden)
    }

    func testOfflineWordsComeFromTheConnection() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.refuse("localhost:5173", 502)
        let page = try await BrowserPage.workspace(client: AgentClient(transport: daemon, token: "native-secret"), url: XCTUnwrap(URL(string: "http://localhost:5173/")), workspaceID: "work1")
        let browser = BrowserViewController(url: page.url, page: page)
        browser.linkChanged(.waitingForNetwork)
        let window = try await show(browser)
        defer { window.isHidden = true }
        try await failed(browser, .noNetwork)
        try await shots(window, "browser-error-no-network")
    }

    func testServerOnTheComputerNotRespondingThenTryAgain() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.refuse("localhost:5173", 502)
        let (window, browser) = try await open(daemon)
        defer { window.isHidden = true }
        try await failed(browser, .serverNotResponding)
        XCTAssertEqual(browser.failureView.shownTitle, "Server Isn’t Responding")
        XCTAssertTrue(browser.failureView.shownMessage.contains("“localhost:5173”"), browser.failureView.shownMessage)
        try await shots(window, "browser-error-server-not-responding")

        await daemon.refuse("localhost:5173", nil)
        browser.failureView.retry.sendActions(for: .primaryActionTriggered)
        try await until("the page after Try Again") { await text(browser.web) == "ready" }
        XCTAssertTrue(browser.failureView.isHidden)
    }

    func testProxyGatewayErrorIsFlaggedEvenWithABody() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.fail("/index.html")
        let client = AgentClient(transport: daemon, token: "native-secret")
        let page = try await BrowserPage.artifact(client: client, id: "art1", version: 1, entry: "index.html")
        let browser = BrowserViewController(url: page.url, artifactID: "art1", page: page)
        let window = try await show(browser)
        defer { window.isHidden = true }
        try await failed(browser, .serverNotResponding)
        XCTAssertFalse(browser.failureView.shownMessage.contains(".invalid"), "A bundled artifact's made-up host is never shown")
    }

    func testEmptyErrorStatusAndTryAgainLoadsTheAddressThatFailed() async throws {
        let daemon = BrowserStateDaemon()
        await daemon.set("/missing", .init(status: 404, body: ""))
        await daemon.set("/styled-404", .init(status: 404, body: BrowserStateDaemon.page(title: "Not here", text: "custom 404")))
        let (window, browser) = try await open(daemon)
        defer { window.isHidden = true }
        try await loaded(browser)

        // The page's own error page shows as it is.
        browser.web?.load(URLRequest(url: try XCTUnwrap(URL(string: "http://localhost:5173/styled-404"))))
        try await until("the page's own 404") { await text(browser.web) == "custom 404" }
        XCTAssertNil(browser.problem)

        browser.web?.load(URLRequest(url: try XCTUnwrap(URL(string: "http://localhost:5173/missing"))))
        try await failed(browser, .http(status: 404))
        XCTAssertEqual(browser.failedURL?.path, "/missing")
        XCTAssertTrue(browser.backItem.isEnabled, "Back returns to the page under the error")
        try await shots(window, "browser-error-http-404")

        await daemon.set("/missing", .init(body: BrowserStateDaemon.page(title: "Found", text: "found")))
        browser.retry()
        try await until("the failed address, not the last good one") { await text(browser.web) == "found" }
        XCTAssertEqual(browser.web?.url?.path, "/missing")
        let missingLoads = await daemon.gets("/missing")
        XCTAssertEqual(missingLoads, 2)
    }

    func testCrashedPageReloadsOnceThenShowsTheError() async throws {
        let daemon = BrowserStateDaemon()
        let (window, browser) = try await open(daemon)
        defer { window.isHidden = true }
        try await loaded(browser)
        let web = try XCTUnwrap(browser.web)
        kill(web, browser)
        try await until("the automatic reload") { await daemon.gets("/") == 2 && web.isLoading == false }
        try await until("the page back") { await text(web) == "ready" }
        XCTAssertNil(browser.problem, "The first crash reloads quietly")

        kill(web, browser)
        try await failed(browser, .crashed)
        try await shots(window, "browser-error-crashed")
        browser.retry()
        try await until("the page after Try Again") { await text(browser.web) == "ready" }
        XCTAssertNil(browser.problem)
    }

    func testSecureConnectionFailure() async throws {
        let daemon = BrowserStateDaemon()
        let (window, browser) = try await open(daemon, url: "https://localhost:8443/")
        defer { window.isHidden = true }
        try await failed(browser, .insecure)
        try await shots(window, "browser-error-insecure")
    }

    func testNoConnectionShowsUnavailableWithoutAWebView() async throws {
        let browser = BrowserViewController(url: try XCTUnwrap(URL(string: "http://localhost:5173/")))
        var history: [BrowserProgress] = []
        browser.progressChanged = { history.append($0) }
        let window = try await show(browser)
        defer { window.isHidden = true }
        try await failed(browser, .unavailable)
        XCTAssertNil(browser.web)
        XCTAssertEqual(history.first?.phase, .loading, "The bar starts while the session connects")
        try await shots(window, "browser-error-unavailable")
    }

    func testAppLinkNobodyOpensSaysSo() async throws {
        let daemon = BrowserStateDaemon()
        let (window, browser) = try await open(daemon)
        defer { window.isHidden = true }
        try await loaded(browser)
        _ = try await browser.web?.evaluateJavaScript("document.querySelector('#app').click()")
        try await until("the alert") { browser.presentedViewController is UIAlertController }
        XCTAssertEqual((browser.presentedViewController as? UIAlertController)?.title, Strings.Browser.cantOpenLink)
        XCTAssertNil(browser.problem, "The page stays")
        browser.dismiss(animated: false)
    }

    /// In the app's own shell: the phone's stack, or on an iPad the main
    /// panel beside home. With history the swipe is the page's; on the
    /// first page, and over the error page, it closes the screen.
    func testInTheShellTheBackSwipeIsThePagesOnlyWithHistory() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in BrowserShellUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: BrowserShellNoNetwork(), connector: BrowserShellNoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"browser-shell","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: computer.id)
        let phone = UINavigationController(rootViewController: home)
        let shell = ShellViewController(context: context, phone: phone, splits: UIDevice.current.userInterfaceIdiom == .pad)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: shell)
        defer { window.isHidden = true }
        shell.view.layoutIfNeeded()

        let daemon = BrowserStateDaemon()
        await daemon.refuse("localhost:3000", 502)
        let page = try await BrowserPage.workspace(client: AgentClient(transport: daemon, token: "native-secret"), url: XCTUnwrap(URL(string: "http://localhost:5173/")), workspaceID: "work1")
        let browser = BrowserViewController(url: page.url, page: page)
        let opener = UIViewController()
        opener.view.backgroundColor = .systemBackground
        shell.setStack([home, opener, browser], animated: false)
        let navigation = try XCTUnwrap(browser.navigationController)
        if UIDevice.current.userInterfaceIdiom == .pad {
            try await until("the main panel") { shell.isExpanded && navigation === shell.main }
        }
        let swipe = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        try await loaded(browser)
        XCTAssertEqual(swipe.delegate?.gestureRecognizerShouldBegin?(swipe), true, "The first page's swipe closes the screen")
        XCTAssertEqual(browser.view.subviews.first { $0 is WKWebView }?.frame, browser.view.bounds)

        _ = try await browser.web?.evaluateJavaScript("document.querySelector('#next').click()")
        try await until("the second page") { browser.web?.url?.path == "/second" && browser.web?.isLoading == false }
        XCTAssertEqual(swipe.delegate?.gestureRecognizerShouldBegin?(swipe), false, "With history the page goes back, not the screen")
        try await shots(window, UIDevice.current.userInterfaceIdiom == .pad ? "browser-ipad-main-panel" : "browser-shell-phone")

        browser.web?.load(URLRequest(url: try XCTUnwrap(URL(string: "http://localhost:3000/"))))
        try await failed(browser, .serverNotResponding)
        XCTAssertEqual(swipe.delegate?.gestureRecognizerShouldBegin?(swipe), true, "Over the error page the swipe closes the screen")
        if UIDevice.current.userInterfaceIdiom == .pad { try await shots(window, "browser-ipad-error") }
    }

    private func kill(_ web: WKWebView, _ browser: BrowserViewController) {
        let selector = NSSelectorFromString("_killWebContentProcess")
        if web.responds(to: selector) { web.perform(selector) } else { browser.webViewWebContentProcessDidTerminate(web) }
    }

    private func waitForWeb(_ browser: BrowserViewController) async throws -> WKWebView {
        try await until("the web view") { browser.web != nil }
        return try XCTUnwrap(browser.web)
    }

    /// Light and dark, settled.
    private func shots(_ window: UIWindow, _ name: String) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(350))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let label = "\(name)-\(style == .light ? "light" : "dark")"
            let attachment = XCTAttachment(image: image); attachment.name = label; attachment.lifetime = .keepAlways; add(attachment)
            if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
                try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(label).png"))
            }
        }
        window.overrideUserInterfaceStyle = .unspecified
    }
}
#endif
