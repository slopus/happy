#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct AppModeHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct AppModeSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer with one conversation whose agent made two HTML artifacts:
/// `game`, a canvas game that asks to run as an app, and `notes`, a page.
/// Its files come through the same artifact proxy a real computer's do.
private actor AppModeComputer: AgentTransport {
    nonisolated static let game = """
    <!doctype html><html><head><meta charset="utf-8"><meta name="happy-page-mode" content="app"><title>Dot Chase</title>
    <style>
    :root{color-scheme:dark}
    body{background:#101225;color:#e8e8ff;font:13px -apple-system,system-ui}
    canvas{position:fixed;inset:0;width:100%;height:100%;touch-action:none}
    #hud{position:fixed;top:var(--happy-app-inset-top,0px);left:calc(var(--happy-app-inset-left,0px) + 12px);right:calc(var(--happy-app-inset-right,0px) + 12px);
      padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.08);white-space:pre-wrap;line-height:1.35}
    #safe{position:fixed;inset:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      border:2px dashed rgba(120,255,170,.6);pointer-events:none}
    #tall{height:4000px}
    #bottom{position:fixed;left:0;right:0;bottom:var(--happy-app-inset-bottom,0px);text-align:center;padding:10px;font-weight:600;color:#9ff}
    </style></head><body>
    <canvas id="c"></canvas><div id="safe"></div><div id="tall"></div>
    <div id="hud" aria-label="hud">…</div><div id="bottom">Drag to chase the dot · score <span id="score">0</span></div>
    <script>
    const c=document.getElementById('c'),x=c.getContext('2d'),hud=document.getElementById('hud'),root=document.documentElement;
    let W=0,H=0,p={x:0,y:0},dot={x:0,y:0},score=0,touches=0;
    function size(){const r=devicePixelRatio;W=innerWidth;H=innerHeight;c.width=W*r;c.height=H*r;x.setTransform(r,0,0,r,0,0);if(!p.x){p={x:W/2,y:H/2};move();}}
    function move(){dot={x:40+Math.random()*(W-80),y:120+Math.random()*(H-240)};}
    function safe(){const d=document.createElement('div');d.style.cssText='position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';document.body.appendChild(d);const s=getComputedStyle(d);const v=[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].map(parseFloat);d.remove();return v.join(',');}
    function inset(){const s=getComputedStyle(root);return ['top','right','bottom','left'].map(k=>parseFloat(s.getPropertyValue('--happy-app-inset-'+k))).join(',');}
    function report(){hud.textContent='mode='+root.getAttribute('data-happy-page-mode')+' scrollY='+Math.round(scrollY)+' zoom='+(visualViewport?visualViewport.scale.toFixed(2):'?')+'\\nsafe='+safe()+'\\nhappy-inset='+inset()+'\\nviewport='+W+'x'+H+' touches='+touches;}
    function at(e){const t=e.touches?e.touches[0]:e;if(t){p={x:t.clientX,y:t.clientY};}}
    addEventListener('touchstart',e=>{touches++;at(e);},{passive:true});addEventListener('touchmove',at,{passive:true});
    addEventListener('pointerdown',at);addEventListener('pointermove',e=>{if(e.buttons)at(e);});
    addEventListener('keydown',e=>{const k={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[e.key];if(k){p.x+=k[0];p.y+=k[1];}});
    addEventListener('resize',size);addEventListener('scroll',report);
    function frame(){x.fillStyle='#101225';x.fillRect(0,0,W,H);x.fillStyle='#ff5ca8';x.beginPath();x.arc(dot.x,dot.y,16,0,7);x.fill();
      x.fillStyle='#7cf';x.beginPath();x.arc(p.x,p.y,22,0,7);x.fill();
      if(Math.hypot(p.x-dot.x,p.y-dot.y)<38){score++;document.getElementById('score').textContent=score;move();}
      report();requestAnimationFrame(frame);}
    size();frame();
    </script></body></html>
    """

    nonisolated static let notes = """
    <!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head>
    <body style="font:17px -apple-system;padding:16px"><h1>Release notes</h1><p>An ordinary page, which scrolls.</p></body></html>
    """

    private static func artifact(_ id: String, title: String) -> String {
        #"{"artifact":{"id":"\#(id)","type":"html","title":"\#(title)","status":"active","latestVersion":1,"entry":{"path":"index.html","mimeType":"text/html","size":1},"live":null}}"#
    }

    private static func version(_ id: String, title: String, size: Int) -> String {
        let file = #"{"path":"index.html","mimeType":"text/html","size":\#(size)}"#
        return #"{"version":{"artifactId":"\#(id)","number":1,"title":"\#(title)","entry":\#(file),"files":[\#(file)]}}"#
    }

    private static func call(_ id: String, title: String) -> String {
        #"{"type":"tool_call","id":"t-\#(id)","name":"artifact_create","status":"completed","presentation":{"type":"artifact","artifactId":"\#(id)","artifactType":"html","title":"\#(title)","version":1,"shows":"latest"}}"#
    }

    private static let runs = #"""
    {"hasMore":false,"runs":[{"id":"r1","status":"completed","startedAt":1000,"endedAt":2000,"reason":"completed","messages":[
      {"id":"u1","role":"user","createdAt":1,"metadata":{},"content":[{"type":"text","text":"Make me a small game I can play on my phone."}]},
      {"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[{"type":"text","text":"Here it is: drag to chase the dot."},\#(call("game", title: "Dot Chase")),
        {"type":"text","text":"And the notes, as a page."},\#(call("notes", title: "Release notes"))]}
    ]}]}
    """#

    private func file(_ id: String) -> String { id == "game" ? Self.game : Self.notes }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let text: String
        if path.contains("/agents/harness/messages?") {
            text = Self.runs
        } else if path.hasSuffix("/agents/harness/bootstrap") {
            text = #"{"agent":{"id":"harness","workspaceId":"w","status":"idle"},"pending":[],"slashCommands":[]}"#
        } else if let id = ["game", "notes"].first(where: { path.hasPrefix("/v0/artifacts/\($0)") }) {
            let title = id == "game" ? "Dot Chase" : "Release notes"
            if path.hasSuffix("/files/index.html") {
                let bytes = Data(file(id).utf8)
                return HTTP1Response(status: 206, headers: ["content-range": "bytes 0-\(bytes.count - 1)/\(bytes.count)"], body: bytes)
            }
            text = path.contains("/versions/") ? Self.version(id, title: title, size: file(id).utf8.count) : Self.artifact(id, title: title)
        } else {
            throw URLError(.cannotConnectToHost)
        }
        return HTTP1Response(status: 200, body: Data(text.utf8))
    }

    nonisolated func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func browserConnection() async throws -> any BrowserStream { Socket(self) }
    func reset() async {}
    func close() async {}

    /// The daemon's artifact routes, as the proxy asks for them.
    func answer(_ head: BrowserHTTPHead) -> Data {
        let content: String
        let type: String
        if head.line.contains("/api/v1/style.css") { content = ":root{}"; type = "text/css" }
        else if head.line.contains("/v0/artifacts/game/") { content = Self.game; type = "text/html" }
        else if head.line.contains("/v0/artifacts/notes/") { content = Self.notes; type = "text/html" }
        else { return Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8) }
        return Data("HTTP/1.1 200 OK\r\nContent-Type: \(type); charset=utf-8\r\nContent-Length: \(content.utf8.count)\r\nConnection: close\r\n\r\n\(content)".utf8)
    }

    private actor Socket: BrowserStream {
        let computer: AppModeComputer
        var buffer = Data()
        var pending = Data()
        var reader: CheckedContinuation<Data, Error>?
        var ended = false
        init(_ computer: AppModeComputer) { self.computer = computer }

        func read(maximumBytes: Int) async throws -> Data {
            if !pending.isEmpty { let data = Data(pending.prefix(maximumBytes)); pending.removeFirst(data.count); return data }
            if ended { return Data() }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { reader = $0 }
            } onCancel: { Task { await self.close() } }
        }

        func write(_ data: Data) async throws {
            buffer.append(data)
            guard let (head, _) = try BrowserHTTPHead.parse(buffer) else { return }
            buffer = Data()
            pending.append(await computer.answer(head)); ended = true
            if let reader { self.reader = nil; let bytes = pending; pending = Data(); reader.resume(returning: bytes) }
        }

        func close() async { ended = true; reader?.resume(returning: Data()); reader = nil }
    }
}

/// App mode for HTML artifacts (`-screen appMode`): the conversation with
/// the game's card, which opens it full screen. `-viaViewer [game|notes]`
/// pushes that artifact's viewer as well, as the Artifacts list and the
/// Feed open it: for the game it steps aside for the app. `-autoplay`
/// walks a device with no UI automation through it on a clock, saying each
/// step as it comes (`APP_MODE phase`), and prints what the app and its page
/// hold.
@MainActor
final class AppModeHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/app-mode",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in AppModeComputer() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: AppModeHTTP(), connector: AppModeSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "app-mode", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "app-mode")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            let chat = ChatViewController(session: session, agentId: "harness", title: "Games", spaceId: nil, intro: nil)
            navigation.pushViewController(chat, animated: false)
            if arguments.contains("-autoplay") { autoplay(chat: chat, navigation: navigation, session: session) }
            if let index = arguments.firstIndex(of: "-viaViewer") {
                let id = arguments.indices.contains(index + 1) && !arguments[index + 1].hasPrefix("-") ? arguments[index + 1] : "game"
                let artifact = Artifact(id: id, version: 1, type: "html", title: id == "game" ? "Dot Chase" : "Release notes", followsLatest: true)
                navigation.pushViewController(ArtifactViewController(session: session, artifact: artifact), animated: true)
            }
        } catch {
            print("APP_MODE error: \(error)")
        }
    }

    private func autoplay(chat: ChatViewController, navigation: UINavigationController, session: Session) {
        Task { @MainActor in
            func at(_ seconds: Double, _ phase: String) async {
                try? await Task.sleep(for: .seconds(seconds))
                print("APP_MODE phase \(phase) at \(Date().timeIntervalSince1970)")
            }
            await at(4, "card")
            await at(3, "opening")
            chat.act(.openArtifact(Artifact(id: "game", version: 1, type: "html", title: "Dot Chase", followsLatest: true)))
            await at(1, "open")
            await report(navigation)
            await at(6, "faded")
            await report(navigation)
            await at(5, "closing")
            (navigation.presentedViewController as? AppPageViewController)?.close()
            await at(2, "page")
            navigation.pushViewController(ArtifactViewController(session: session, artifact: Artifact(id: "notes", version: 1, type: "html", title: "Release notes", followsLatest: true)), animated: true)
        }
    }

    /// What the presented app holds: how it is presented, and its page's state.
    private func report(_ navigation: UINavigationController) async {
        guard let app = navigation.presentedViewController as? AppPageViewController,
              let browser = app.children.first as? BrowserViewController, let web = browser.web else {
            print("APP_MODE report: no app presented")
            return
        }
        let close = app.view.subviews.first { $0 is AppCloseButton }
        print("APP_MODE native: style=\(app.modalPresentationStyle == .fullScreen ? "fullScreen" : "other") modalInPresentation=\(app.isModalInPresentation) statusBarHidden=\(app.prefersStatusBarHidden) homeIndicatorAutoHidden=\(app.prefersHomeIndicatorAutoHidden) deferredEdges=\(app.preferredScreenEdgesDeferringSystemGestures == .all) scroll=\(web.scrollView.isScrollEnabled) bounces=\(web.scrollView.bounces) pinch=\(web.scrollView.pinchGestureRecognizer?.isEnabled ?? false) swipeNav=\(web.allowsBackForwardNavigationGestures) linkPreview=\(web.allowsLinkPreview) safe=\(app.view.safeAreaInsets) close=\(close?.frame ?? .zero) closeAlpha=\(close?.alpha ?? -1)")
        let script = "[document.documentElement.getAttribute('data-happy-page-mode'), scrollY, visualViewport.scale, document.documentElement.scrollHeight, innerHeight, getComputedStyle(document.documentElement).overflow, getComputedStyle(document.documentElement).getPropertyValue('--happy-host-page-inset'), document.querySelector('meta[name=viewport]:last-of-type')?.content].join(' | ')"
        let page = try? await web.evaluateJavaScript(script)
        print("APP_MODE page: \(page ?? "nil")")
    }
}
#endif
