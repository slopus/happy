#if canImport(UIKit)
import CryptoKit
@testable import HappyCore
@testable import HappyUI
import UIKit
import WebKit
import XCTest

/// A byte-level fake daemon, behind the same CONNECT and artifact translation
/// used in production. WebKit still speaks real HTTP to our loopback listener.
actor BrowserDaemon: AgentTransport {
    var requests: [String] = []
    var bodies: [Data] = []
    var credentials: [String] = []
    var targetCredentials: [String] = []
    let artifactHTML: String?
    let keepAlive: Bool
    var connections = 0
    init(artifactHTML: String? = nil, keepAlive: Bool = false) { self.artifactHTML = artifactHTML; self.keepAlive = keepAlive }

    func browserConnection() async throws -> any BrowserStream { connections += 1; return Socket(self) }
    func close() async {}
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let text: String
        if path == "/v0/config" { text = #"{"config":{"node":{"name":"Studio Mac"}}}"# }
        else if path == "/v0/workspaces" { text = #"{"workspaces":[{"id":"host1","status":"active","compute":{"type":"host"}}]}"# }
        else if path.hasPrefix("/v0/agents/") { text = #"{"agent":{"id":"agent1","workspaceId":"work1","status":"idle"}}"# }
        else if path.hasPrefix("/v0/artifacts/") { text = #"{"artifact":{"updatedSource":{"kind":"workspace","workspaceId":"work1"}}}"# }
        else { text = "{}" }
        return HTTP1Response(status: 200, body: Data(text.utf8))
    }

    func answer(_ head: BrowserHTTPHead, body: Data) -> (Data, Bool) {
        requests.append(head.line); bodies.append(body)
        if let credential = head.value("Authorization") { credentials.append(credential) }
        if head.line.hasPrefix("CONNECT ") { return (Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8), true) }
        targetCredentials.append(head.value("Authorization") ?? "none")
        if let key = head.value("Sec-WebSocket-Key") {
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            var bytes = Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
            bytes.append(contentsOf: [0x81, 7]); bytes.append(Data("ws-live".utf8))
            return (bytes, true)
        }
        if head.line.contains("/api/v1/kv/events") {
            let event = "data: shared-update\n\n"
            return (Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\n\(String(event.utf8.count, radix: 16))\r\n\(event)\r\n".utf8), true)
        }
        let content: String
        let type: String
        if head.line.contains("/api/v1/kv/entry") { content = #"{"value":"saved"}"#; type = "application/json" }
        else if head.line.contains("/api/v1/style.css") { content = ":root{}"; type = "text/css" }
        else if head.line.contains("/public.js") { content = "window.publicResourceLoaded=true;"; type = "text/javascript" }
        else if head.line.contains("/app.js") {
            content = "document.querySelector('#js').textContent='JavaScript loaded'; const ws=new WebSocket('ws://'+location.host+'/socket'); ws.onmessage=e=>document.querySelector('#result').textContent=e.data;"
            type = "text/javascript"
        } else if head.line.contains("/versions/") {
            content = artifactHTML ?? Self.html; type = "text/html"
        } else {
            content = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>Remote preview</title></head><body style='font:20px -apple-system;padding:24px;background:#f3f6fc;color:#14233a'><h1>Remote preview</h1><p id='js'>Loading script…</p><p id='result'>Connecting…</p><script src='/app.js'></script><script src='http://assets.example.invalid/public.js'></script></body></html>"
            type = "text/html"
        }
        let reuse = keepAlive && head.value("Connection") == "keep-alive"
        return (Data("HTTP/1.1 200 OK\r\nContent-Type: \(type); charset=utf-8\r\nContent-Length: \(content.utf8.count)\r\nConnection: \(reuse ? "keep-alive" : "close")\r\n\r\n\(content)".utf8), reuse)
    }

    nonisolated static let html = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared counter</title></head>
    <body style="font:20px -apple-system;padding:24px;background:#edf4ee;color:#183c27"><h1>Shared counter</h1><p id="result">Saving…</p>
    <script>fetch('/api/v1/kv/entry?key=count',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':'version1'},body:JSON.stringify({value:42})}).then(r=>r.json()).then(()=>{let events=new EventSource('/api/v1/kv/events');events.onmessage=e=>document.querySelector('#result').textContent=e.data;}).catch(e=>document.querySelector('#result').textContent='error:'+e);</script></body></html>
    """

    private actor Socket: BrowserStream {
        let daemon: BrowserDaemon
        var buffer = Data()
        var pending = Data()
        var reader: CheckedContinuation<Data, Error>?
        var ended = false
        var websocket = false
        init(_ daemon: BrowserDaemon) { self.daemon = daemon }
        func read(maximumBytes: Int) async throws -> Data {
            if !pending.isEmpty { let data = Data(pending.prefix(maximumBytes)); pending.removeFirst(data.count); return data }
            if ended { return Data() }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { reader = $0 }
            } onCancel: { Task { await self.close() } }
        }
        func write(_ data: Data) async throws {
            if websocket { return }
            buffer.append(data)
            guard let (head, body) = try BrowserHTTPHead.parse(buffer), body.count >= (Int(head.value("Content-Length") ?? "0") ?? 0) else { return }
            buffer = Data()
            let (response, staysOpen) = await daemon.answer(head, body: body)
            websocket = head.value("upgrade") != nil
            pending.append(response); ended = !staysOpen
            if let reader { self.reader = nil; let bytes = pending; pending = Data(); reader.resume(returning: bytes) }
        }
        func close() async { ended = true; reader?.resume(returning: Data()); reader = nil }
    }
}

@MainActor
final class HostedBrowserTests: XCTestCase {
    func testArtifactAPIReusesUpstreamWhileSSEStaysOpen() async throws {
        let daemon = BrowserDaemon(artifactHTML: """
        <!doctype html><p id="result">Starting</p><script>
        const events = new EventSource('/api/v1/kv/events');
        events.onmessage = async () => {
          try {
            for (let i = 0; i < 100; i++) {
              const r = await fetch('/api/v1/kv/entry?key='+i, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:i})});
              if (r.status !== 200 || (await r.json()).value !== 'saved') throw Error('bad response');
            }
            document.querySelector('#result').textContent='100 reused writes and SSE';
          } catch(e) {document.querySelector('#result').textContent=String(e);}
        };
        </script>
        """, keepAlive: true)
        let client = AgentClient(transport: daemon, token: "native-secret")
        let page = try await BrowserPage.artifact(client: client, id: "art1", version: 1, entry: "index.html")
        let browser = BrowserViewController(url: page.url, artifactID: "art1", page: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        let web = try await waitForWeb(browser)
        try await waitForText("100 reused writes and SSE", web: web)
        let connections = await daemon.connections
        let writes = await daemon.requests.filter { $0.hasPrefix("PUT ") }
        XCTAssertEqual(writes.count, 100)
        XCTAssertLessThan(connections, 8, "Sequential API requests must reuse upstream sockets alongside SSE")
    }

    func testArtifactWriteAndLiveUpdate() async throws {
        let daemon = BrowserDaemon()
        let client = AgentClient(transport: daemon, token: "native-secret")
        let page = try await BrowserPage.artifact(client: client, id: "art1", version: 2, entry: "index.html")
        let browser = BrowserViewController(url: page.url, artifactID: "art1", page: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        let web = try await waitForWeb(browser)
        try await waitForText("shared-update", web: web)
        let requests = await daemon.requests
        XCTAssertTrue(requests.contains("PUT /v0/artifacts/art1/api/v1/kv/entry?key=count HTTP/1.1"), "\(requests)")
        XCTAssertTrue(requests.contains("GET /v0/artifacts/art1/api/v1/kv/events HTTP/1.1"))
        let bodies = await daemon.bodies
        XCTAssertTrue(bodies.contains(Data(#"{"value":42}"#.utf8)))
        let credentials = await daemon.credentials
        XCTAssertTrue(credentials.allSatisfy { $0 == "Bearer native-secret" })
        let content = try await web.evaluateJavaScript("document.documentElement.outerHTML") as? String
        XCTAssertFalse(content?.contains("native-secret") == true)
        try screenshot(window, name: "browser-artifact")
    }

    func testLocalhostPageLoadsScriptAndWebSocketThroughWorkspace() async throws {
        let daemon = BrowserDaemon()
        let page = try await BrowserPage.workspace(client: AgentClient(transport: daemon, token: "native-secret"), url: URL(string: "http://localhost:5173")!, workspaceID: "runner1")
        let browser = BrowserViewController(url: page.url, page: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        let web = try await waitForWeb(browser)
        try await waitForText("ws-live", web: web)
        let js = try await web.evaluateJavaScript("document.querySelector('#js').textContent") as? String
        XCTAssertEqual(js, "JavaScript loaded")
        let requests = await daemon.requests
        XCTAssertTrue(requests.contains { $0.hasPrefix("CONNECT /v0/workspaces/runner1/proxy") }, "\(requests)")
        XCTAssertTrue(requests.contains { $0.hasPrefix("CONNECT localhost:5173") })
        XCTAssertTrue(requests.contains { $0.hasPrefix("GET /app.js") })
        XCTAssertTrue(requests.contains { $0.hasPrefix("GET /socket") })
        window.overrideUserInterfaceStyle = .light
        try screenshot(window, name: "browser-localhost-light")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(150))
        try screenshot(window, name: "browser-localhost-dark")
    }

    func testPublicPageAndPublicResourcesUseProxyWithoutDirectFallback() async throws {
        let daemon = BrowserDaemon()
        let page = try await BrowserPage.workspace(client: AgentClient(transport: daemon, token: "native-secret"), url: URL(string: "http://public.example.invalid")!, workspaceID: "work1")
        let settings = try XCTUnwrap(page.configuration.websiteDataStore.proxyConfigurations.first)
        XCTAssertFalse(settings.allowFailover)
        XCTAssertTrue(settings.matchDomains.isEmpty)
        XCTAssertTrue(settings.excludedDomains.isEmpty)
        let browser = BrowserViewController(url: page.url, page: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        let web = try await waitForWeb(browser)
        try await waitForText("ws-live", web: web)
        let requests = await daemon.requests
        // Neither domain can resolve on the phone. Every load must reach the
        // fake daemon, including the cross-origin script and WebSocket.
        XCTAssertTrue(requests.contains { $0.hasPrefix("CONNECT public.example.invalid:80") }, "\(requests)")
        XCTAssertTrue(requests.contains { $0.hasPrefix("CONNECT assets.example.invalid:80") }, "\(requests)")
        let publicResource = try await web.evaluateJavaScript("window.publicResourceLoaded") as? Bool
        XCTAssertEqual(publicResource, true)
        let targetCredentials = await daemon.targetCredentials
        XCTAssertTrue(targetCredentials.allSatisfy { $0 == "none" })
        XCTAssertTrue(requests.contains { $0.hasPrefix("GET /socket") })
        XCTAssertEqual(BrowserPolicy.route(page.url), .web)
        XCTAssertEqual(BrowserPolicy.route(URL(string: "mailto:hello@example.com")!), .system)
    }

    func testNoConnectionNeverCreatesADirectWebView() async throws {
        let browser = BrowserViewController(url: URL(string: "http://public.example.invalid")!)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(browser.view.subviews.compactMap { $0 as? WKWebView }.isEmpty)
        XCTAssertTrue(browser.view.subviews.compactMap { $0 as? UILabel }.contains { $0.text?.hasPrefix("Can’t reach") == true })
    }

    func testChatLocalhostLinkUsesItsWorkspaceAndShowsComputerName() async throws {
        let daemon = BrowserDaemon()
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "browser-test", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in daemon })
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"browser-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"native-secret"}"#.utf8)), name: "Studio Mac")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let chat = ChatViewController(session: session, agentId: "agent1", title: "Preview", spaceId: nil, seedling: nil, previewing: true)
        let navigation = UINavigationController(rootViewController: chat)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer {
            window.isHidden = true; Session.forget(connection.id)
            Task { try? await account.agentConnections.remove(connection.id) }
        }
        chat.transcriptOpened("http://localhost:5173")
        let browser = try XCTUnwrap(navigation.topViewController as? BrowserViewController)
        let web = try await waitForWeb(browser)
        try await waitForText("ws-live", web: web)
        let route = browser.view.subviews.compactMap { $0 as? UILabel }.first { $0.accessibilityIdentifier == "browser-route" }
        XCTAssertEqual(route?.text, "via Studio Mac")
        let requests = await daemon.requests
        XCTAssertTrue(requests.contains { $0.hasPrefix("CONNECT /v0/workspaces/work1/proxy") })
        window.overrideUserInterfaceStyle = .light
        try screenshot(window, name: "browser-chat-light")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(150))
        try screenshot(window, name: "browser-chat-dark")
    }

    func testURLArtifactGetsItsAPIWhileItsFilesUseWorkspace() async throws {
        let daemon = BrowserDaemon()
        let page = try await BrowserPage.workspace(client: AgentClient(transport: daemon, token: "native-secret"), url: URL(string: "http://localhost:5173")!, workspaceID: "runner1", artifactID: "art1")
        let browser = BrowserViewController(url: page.url, artifactID: "art1", page: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        let web = try await waitForWeb(browser)
        try await waitForText("ws-live", web: web)
        _ = try await web.evaluateJavaScript("fetch('/api/v1/kv/entry?key=count',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{\"value\":42}'}).then(()=>{const events=new EventSource('/api/v1/kv/events');events.onmessage=e=>document.querySelector('#result').textContent=e.data;});void 0;")
        try await waitForText("shared-update", web: web)
        let requests = await daemon.requests
        XCTAssertTrue(requests.contains { $0.hasPrefix("PUT /v0/artifacts/art1/api/v1/kv/entry") })
        XCTAssertTrue(requests.contains { $0.hasPrefix("GET /v0/artifacts/art1/api/v1/kv/events") })
        XCTAssertTrue(requests.contains { $0.hasPrefix("CONNECT /v0/workspaces/runner1/proxy") })
    }

    private func waitForWeb(_ browser: BrowserViewController) async throws -> WKWebView {
        for _ in 0..<150 {
            if let web = browser.view.subviews.compactMap({ $0 as? WKWebView }).first { return web }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw BrowserError.unavailable
    }
    private func waitForText(_ text: String, web: WKWebView) async throws {
        for _ in 0..<200 {
            if let result = try? await web.evaluateJavaScript("document.querySelector('#result')?.textContent"), result as? String == text { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        let result = try? await web.evaluateJavaScript("document.documentElement.outerHTML")
        XCTFail("Page did not reach \(text): \(String(describing: result))")
        throw BrowserError.unavailable
    }
    private func screenshot(_ window: UIWindow, name: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
#endif