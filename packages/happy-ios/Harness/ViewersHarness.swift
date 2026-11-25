#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct ViewersOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ViewersNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A Happy Cloud team server that serves viewers as API.md has them:
/// its stream says hello with a `streamId`, `PUT /v0/viewers/streams/:id`
/// answers who else looks at each target, and `viewers.updated` frames
/// come over the stream for the targets the phone said it looks at.
/// Steve is signed in; his team is Kirill, Anna, Max and more.
private actor ViewersServer: AgentTransport {
    enum Scenario: String {
        /// Kirill here, Anna 4 minutes ago, Max and Ada seen before.
        case tiers
        /// Ten people: three here, three recent, four seen.
        case ten
        /// Nobody else, ever.
        case none
        /// People come and go over the stream, again and again.
        case live
        /// An older team server: the route answers 404.
        case old
    }

    static let streamId = "stream-viewers"
    static let kirillHash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    static let annaHash = "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"

    static let team: [(id: String, name: String, hash: String?)] = [
        ("kirill", "Kirill", kirillHash), ("anna", "Anna", annaHash), ("max", "Max", nil), ("ada", "Ada", nil),
        ("bo", "Bo", nil), ("chen", "Chen", nil), ("dana", "Dana", nil), ("eli", "Eli", nil), ("fay", "Fay", nil), ("gus", "Gus", nil),
    ]

    static var bootstrap: String {
        let teammates = team.map { #"{"id":"\#($0.id)","name":"\#($0.name)","photo":\#($0.hash.map { #"{"thumbhash":"\#($0)"}"# } ?? "null")}"# }
        return #"""
        {"cursor":"cursor-1","profile":{"userId":"steve","name":"Steve"},"userSettings":[],
         "projects":[],"workspaces":[],"bots":[],
         "tasks":[{"id":"launch","name":"Plan the launch","ownerUserId":"steve","status":"active","agent":{"id":"launch-agent","workspaceId":"w1","status":"idle"}}],
         "taskMemberships":[{"taskId":"launch"}],
         "surfaces":[{"id":"todos","name":"Launch checklist","type":"todo","members":[]},
                     {"id":"notes","name":"Launch notes","type":"document","members":[]}],
         "teammates":[\#(teammates.joined(separator: ","))]}
        """#
    }

    private let scenario: Scenario
    private var lists: [ViewerTarget: [Viewer]] = [:]
    private var watched: [ViewerTarget] = []
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var scripting = false
    private(set) var puts = 0

    init(scenario: Scenario) {
        self.scenario = scenario
    }

    private static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    private func people(_ target: ViewerTarget) -> [Viewer] {
        if let list = lists[target] { return list }
        let now = Self.now()
        let minute: Double = 60_000
        let november12 = 1_794_506_400_000.0
        let list: [Viewer]
        switch scenario {
        case .tiers:
            list = [Viewer(userId: "kirill", here: true, lastSeenAt: now), Viewer(userId: "anna", here: false, lastSeenAt: now - 4 * minute - 10_000),
                    Viewer(userId: "max", here: false, lastSeenAt: november12), Viewer(userId: "ada", here: false, lastSeenAt: november12 - 86_400_000)]
        case .ten:
            list = Self.team.enumerated().map { index, person in
                switch index {
                case 0..<3: Viewer(userId: person.id, here: true, lastSeenAt: now)
                case 3..<6: Viewer(userId: person.id, here: false, lastSeenAt: now - Double(index) * minute)
                default: Viewer(userId: person.id, here: false, lastSeenAt: november12 - Double(index) * 86_400_000)
                }
            }
        case .live:
            list = [Viewer(userId: "anna", here: false, lastSeenAt: now - 6 * minute), Viewer(userId: "max", here: false, lastSeenAt: november12)]
        case .none, .old:
            list = []
        }
        lists[target] = list
        return list
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        if path == "/v0/bootstrap/desktop" { return ok(Self.bootstrap) }
        if path == "/v0/permissions" { return ok(#"{"granted":["content.write"]}"#) }
        if path == "/v0/health" { return ok(#"{"ok":true,"capabilities":{"collaborativeDocuments":false}}"#) }
        if method == "PUT", path == "/v0/viewers/streams/\(Self.streamId)" { return try viewers(body) }
        if path.hasPrefix("/v0/users?ids=") {
            let users = Self.team.map { #"{"id":"\#($0.id)","name":"\#($0.name)","photo":\#($0.hash.map { #"{"thumbhash":"\#($0)"}"# } ?? "null")}"# }
            return ok(#"{"users":[\#(users.joined(separator: ","))]}"#)
        }
        if let picture = Self.picture(path) { return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: picture) }
        if path.contains("/agents/launch-agent/messages") { return ok(Self.transcript) }
        if path.hasSuffix("/agents/launch-agent/bootstrap") {
            return ok(#"{"agent":{"id":"launch-agent","workspaceId":"w1","status":"idle"},"pending":[],"slashCommands":[]}"#)
        }
        if path.hasPrefix("/v0/surfaces/todo/todos?") { return ok(Self.todos) }
        if path == "/v0/surfaces/document/notes" {
            return ok(##"{"document":{"text":"# Launch notes\n\nShip the Feed to every team on Monday.\n\n- Covers in every artifact list\n- New onboarding\n- Viewers in every header","seq":1}}"##)
        }
        return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
    }

    private func viewers(_ body: Data?) throws -> HTTP1Response {
        puts += 1
        if scenario == .old { return HTTP1Response(status: 404, body: Data(#"{"error":"Not found","code":"not_found"}"#.utf8)) }
        struct Request: Decodable { let targets: [ViewerTarget] }
        let targets = (body.flatMap { try? JSONDecoder().decode(Request.self, from: $0) })?.targets ?? []
        watched = targets
        if scenario == .live, !targets.isEmpty, !scripting {
            scripting = true
            Task { await self.script() }
        }
        let now = Self.now()
        let entries: [JSONValue] = try targets.map { target in
            let viewers = people(target).map { $0.here ? Viewer(userId: $0.userId, here: true, lastSeenAt: now) : $0 }
            return .object([
                "target": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(target)),
                "viewers": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(viewers)),
            ])
        }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(JSONValue.object(["targets": .array(entries)])))
    }

    /// Kirill comes and goes, Ada drops by, Bo and Chen look in: each a
    /// `viewers.updated` to whatever the phone looks at, on a loop.
    private func script() async {
        let beats: [(String, Bool)] = [("kirill", true), ("ada", true), ("kirill", false), ("bo", true), ("ada", false), ("chen", true),
                                       ("kirill", true), ("bo", false), ("chen", false), ("kirill", false), ("ada", true), ("ada", false)]
        while true {
            for (person, here) in beats {
                try? await Task.sleep(for: .seconds(3))
                let viewer = Viewer(userId: person, here: here, lastSeenAt: Self.now())
                for target in watched {
                    lists[target] = ViewerTiers.applying(viewer, to: people(target))
                    send(target, viewer)
                }
            }
        }
    }

    private func send(_ target: ViewerTarget, _ viewer: Viewer) {
        struct Frame: Encodable { let target: ViewerTarget; let viewer: Viewer }
        guard let data = try? JSONEncoder().encode(Frame(target: target, viewer: viewer)), let text = String(data: data, encoding: .utf8) else { return }
        for stream in streams { stream.yield(Data("event: viewers.updated\ndata: \(text)\n\n".utf8)) }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"streamId\":\"\(Self.streamId)\",\"daemonId\":\"daemon-1\"}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }

    func reset() async {}
    func close() async {}

    static let todos: String = {
        let texts = ["Freeze the release branch", "Write the changelog", "Screenshots for the store", "Tell support what changed", "Ship it"]
        let todos = texts.enumerated().map { index, text in
            #"{"id":"t\#(index)","surfaceId":"todos","text":"\#(text)","status":"active","orderKey":"a\#(index)","version":"1"}"#
        }
        return #"{"todos":[\#(todos.joined(separator: ","))]}"#
    }()

    static let transcript: String = {
        func message(_ id: String, _ role: String, _ text: String) -> String {
            #"{"id":"\#(id)","role":"\#(role)","createdAt":1,"metadata":{},"content":[{"type":"text","text":"\#(text)"}]}"#
        }
        let turns = [
            ("What's left before Monday's launch?", "Three things: the changelog, the store screenshots, and a note to support. The release branch is frozen."),
            ("Who's reviewing the changelog?", "Kirill took it this morning; Anna is on the screenshots."),
        ]
        let runs = turns.enumerated().map { index, turn in
            #"{"id":"r\#(index)","status":"completed","startedAt":1000,"endedAt":2000,"reason":"completed","messages":[\#(message("u\(index)", "user", turn.0)),\#(message("m\(index)", "agent", turn.1))]}"#
        }
        return #"{"hasMore":false,"runs":[\#(runs.joined(separator: ","))]}"#
    }()

    /// Kirill's and Anna's faces, in their ThumbHashes' colours.
    private static func picture(_ path: String) -> Data? {
        let colors: [UIColor]
        switch path {
        case "/v0/users/kirill/photo": colors = [.systemBlue, .systemTeal]
        case "/v0/users/anna/photo": colors = [.systemRed, .systemOrange]
        default: return nil
        }
        return UIGraphicsImageRenderer(size: CGSize(width: 240, height: 240)).pngData { context in
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors.map(\.cgColor) as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 240, y: 240), options: [])
            let initial = NSAttributedString(string: String(path.dropFirst("/v0/users/".count).prefix(1)).uppercased(),
                                             attributes: [.font: UIFont.systemFont(ofSize: 120, weight: .bold), .foregroundColor: UIColor.white])
            let size = initial.size()
            initial.draw(at: CGPoint(x: (240 - size.width) / 2, y: (240 - size.height) / 2))
        }
    }
}

/// Viewers in the headers of a team server's screens (`-screen viewers`):
/// `-open chat` (default), `todo` or `document`, with `-viewers tiers`
/// (default), `ten`, `none`, `live` or `old`; `-dark` for dark mode.
/// After two seconds it logs where the title and the slot sit in the
/// window (`VIEWERS-PROBE`), and keeps it in the bar's accessibility
/// value for UI tests, so a header with nobody and one with ten can be
/// compared.
///
/// Where UI tests can't drive the phone, it shoots itself:
/// `-shots 3,9` saves the app's windows that many seconds after the
/// screen opened, `-openList 4` opens the viewers' list then,
/// `-recordFrames 40` records what the window draws (`FrameRecorder`),
/// all under Documents/viewers with the probe's line
/// (`devicectl device copy from`). `-busyMain` holds the main thread
/// 300 ms of every 1.5 s, for a trace that shows the ring and the pops
/// keep moving without it.
///
/// `-real http://HOST:PORT -token JWT -target ID` opens the same screen
/// on a real team-mode daemon instead (happy-agent's viewers fixture),
/// over plain HTTP: `-open chat` takes `-target` as an agent's ID, `todo`
/// and `document` as a Surface's.
@MainActor
final class ViewersHarness {
    private var account: AccountController?
    private var recorder: FrameRecorder?
    private var name = ""

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        if let real = value("-real").flatMap(URL.init(string:)), let host = real.host, let token = value("-token") {
            await openReal(window: window, host: host, port: UInt16(real.port ?? 80), token: token, open: value("-open") ?? "chat", target: value("-target") ?? "", arguments: arguments)
            return
        }
        let scenario = value("-viewers").flatMap(ViewersServer.Scenario.init(rawValue:)) ?? .tiers
        name = "\(value("-open") ?? "chat")-\(scenario.rawValue)\(arguments.contains("-dark") ? "-dark" : "")"
        let server = ViewersServer(scenario: scenario)
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/viewers",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ViewersOffline(), connector: ViewersNoSocket()
        )
        self.account = account
        if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
        do {
            let origin = HappyCloud.server(named: "acme")
            let connection = try await account.agentConnections.addServer(AgentOrigin(origin),
                signIn: ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(clientId: "harness"), userId: "steve"),
                access: OAuthAccess(token: "harness", expiresAt: nil), name: "Acme")
            let context = AppContext(account: account, variant: .development, version: "viewers")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            try? await Task.sleep(for: .seconds(1))
            let screen: UIViewController
            switch value("-open") ?? "chat" {
            case "todo": screen = SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: "todos", type: "todo", name: "Launch checklist"))
            case "document": screen = SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: "notes", type: "document", name: "Launch notes"))
            default: screen = ChatViewController(session: session, agentId: "launch-agent", title: "Plan the launch", spaceId: "launch", intro: nil)
            }
            navigation.pushViewController(screen, animated: false)
            await perform(window: window, navigation: navigation, arguments: arguments)
        } catch {
            print("VIEWERS error: \(error)")
        }
    }

    private func openReal(window: HarnessWindow, host: String, port: UInt16, token: String, open: String, target: String, arguments: [String]) async {
        name = "real-\(open)"
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/viewers-real",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in SocketAgentTransport(.tcp(host: host, port: port)) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ViewersOffline(), connector: ViewersNoSocket()
        )
        self.account = account
        do {
            let connection = try await account.agentConnections.add(AgentConnectionCredentials(address: host, port: port, deviceID: "viewers-real", deviceToken: token), name: "Team daemon")
            let context = AppContext(account: account, variant: .development, version: "viewers-real")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            // The slot is a team's: the bootstrap names the person first.
            for _ in 0..<100 where session.home.userId == nil { try? await Task.sleep(for: .milliseconds(100)) }
            print("VIEWERS-REAL user=\(session.home.userId ?? "none") live=\(session.home.live)")
            let screen: UIViewController = switch open {
            case "todo": SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: target, type: "todo", name: "Todos"))
            case "document": SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: target, type: "document", name: "Notes"))
            default: ChatViewController(session: session, agentId: target, title: "Team agent", spaceId: nil, intro: nil)
            }
            navigation.pushViewController(screen, animated: false)
            await perform(window: window, navigation: navigation, arguments: arguments)
        } catch {
            print("VIEWERS-REAL error: \(error)")
        }
    }

    /// Once the screen is up: the recorder, the busy main thread, the
    /// probe, then the shots and the list at their moments.
    private func perform(window: HarnessWindow, navigation: UINavigationController, arguments: [String]) async {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        let opened = ContinuousClock.now
        if let seconds = value("-recordFrames").flatMap(Double.init) { recorder = FrameRecorder(window: window, seconds: seconds, top: nil) }
        if arguments.contains("-busyMain") {
            Task { @MainActor in
                while true {
                    try? await Task.sleep(for: .milliseconds(1200))
                    let until = Date().addingTimeInterval(0.3)
                    while Date() < until {}
                    print("VIEWERS-BUSY held the main thread 300 ms")
                }
            }
        }
        try? await Task.sleep(for: .seconds(2))
        probe(navigation)
        var moments: [(Double, () -> Void)] = (value("-shots") ?? "").split(separator: ",").compactMap { Double($0) }.map { at in
            (at, { [weak self] in self?.shoot(window, at) })
        }
        if let at = value("-openList").flatMap(Double.init) { moments.append((at, { [weak self] in self?.openList(window) })) }
        for (at, run) in moments.sorted(by: { $0.0 < $1.0 }) {
            try? await Task.sleep(until: opened + .milliseconds(Int(at * 1000)), clock: .continuous)
            run()
        }
    }

    /// Where the title and the slot are in the window, as text.
    private func probe(_ navigation: UINavigationController) {
        let bar = navigation.navigationBar
        func find(_ view: UIView, _ match: (UIView) -> Bool) -> UIView? {
            if match(view) { return view }
            for child in view.subviews { if let found = find(child, match) { return found } }
            return nil
        }
        let title = find(bar) { $0.accessibilityIdentifier == "chat-capsule" }
            ?? find(bar) { ($0 as? UILabel)?.text == navigation.topViewController?.navigationItem.title }
        let slot = find(bar) { $0 is ViewersSlotView }
        func frame(_ view: UIView?) -> String {
            guard let view, let window = view.window else { return "none" }
            let rect = view.convert(view.bounds, to: window)
            return String(format: "%.1f,%.1f,%.1f,%.1f", rect.minX, rect.minY, rect.width, rect.height)
        }
        let line = "title=\(frame(title)) slot=\(frame(slot))"
        print("VIEWERS-PROBE \(line)")
        try? Data(line.utf8).write(to: Self.directory.appendingPathComponent("probe-\(name).txt"))
        bar.accessibilityIdentifier = "viewers-bar"
        bar.accessibilityValue = line
    }

    private static let directory: URL = {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("viewers")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private static func slot(_ view: UIView) -> ViewersSlotView? {
        if let slot = view as? ViewersSlotView { return slot }
        for child in view.subviews { if let found = slot(child) { return found } }
        return nil
    }

    /// Every window of the app, as the screen shows them: an open menu
    /// is a window of its own.
    private func shoot(_ window: UIWindow, _ at: Double) {
        guard let scene = window.windowScene else { return }
        let bounds = window.bounds
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.screen.scale
        let image = UIGraphicsImageRenderer(size: bounds.size, format: format).image { _ in
            for each in scene.windows.filter({ !$0.isHidden }).sorted(by: { $0.windowLevel < $1.windowLevel }) {
                each.drawHierarchy(in: each.frame, afterScreenUpdates: false)
            }
        }
        let file = Self.directory.appendingPathComponent(String(format: "%@-%04.1f.png", name, at))
        try? image.pngData()?.write(to: file)
        print("VIEWERS-SHOT \(file.lastPathComponent)")
    }

    /// As a tap on the slot opens it; UIKit has no public call for a
    /// button's menu, so this harness uses the interaction's own.
    private func openList(_ window: UIWindow) {
        guard let slot = Self.slot(window), let interaction = slot.contextMenuInteraction else { return }
        let selector = NSSelectorFromString("_presentMenuAtLocation:")
        guard interaction.responds(to: selector) else { print("VIEWERS-LIST unavailable"); return }
        typealias Present = @convention(c) (AnyObject, Selector, CGPoint) -> Void
        let present = unsafeBitCast(interaction.method(for: selector), to: Present.self)
        present(interaction, selector, CGPoint(x: slot.bounds.midX, y: slot.bounds.midY))
        print("VIEWERS-LIST opened")
    }
}
#endif
