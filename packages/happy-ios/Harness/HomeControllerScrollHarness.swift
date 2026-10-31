#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

private struct ScrollTraceHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct ScrollTraceSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Fixed IDs, labels, order and membership. Only working flags change.
/// The app reads these over its real engine/store/session/controller path.
private actor ScrollTraceTransport: AgentTransport {
    static let count = 120
    private var version = 1
    private var working = Set<Int>()
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var online = true
    private var bootstrapDelay = false
    private var sent = 0

    private func bot(_ index: Int) -> [String: Any] {
        ["id": "b\(index)", "name": "Conversation \(index)", "status": "active",
         "agent": ["id": "a\(index)", "workspaceId": "w\(index)", "title": "Conversation \(index)", "status": working.contains(index) ? "working" : "idle"]]
    }

    func flip(_ index: Int) throws {
        version += 1
        if working.contains(index) { working.remove(index) } else { working.insert(index) }
        let data = try JSONSerialization.data(withJSONObject: ["type": "bot.updated", "payload": ["bot": bot(index)]])
        let frame = Data("event: message\ndata: \(String(decoding: data, as: UTF8.self))\n\n".utf8)
        streams.forEach { $0.yield(frame) }
        sent += 1
    }

    func cycleConnection(_ index: Int) {
        switch index % 3 {
        case 0:
            online = false
            streams.forEach { $0.finish(throwing: URLError(.networkConnectionLost)) }
            streams.removeAll()
        case 1: online = true; bootstrapDelay = true
        default: online = true; bootstrapDelay = false
        }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        let route = path.split(separator: "?").first.map(String.init) ?? path
        var object: [String: Any]
        switch route {
        case "/v0/health":
            if bootstrapDelay { try await Task.sleep(for: .milliseconds(450)) }
            object = ["ready": true, "version": ["protocol": 27], "capabilities": ["sidebarOperations": true]]
        case "/v0/config": object = ["config": ["node": ["name": "Personal MacBook Pro"]]]
        case "/v0/bootstrap/desktop":
            if bootstrapDelay { try await Task.sleep(for: .milliseconds(450)) }
            object = ["cursor": "c1", "profile": ["userId": NSNull()], "projects": [], "workspaces": [], "userSettings": [],
                      "bots": (0..<Self.count).map(bot)]
        case "/v0/bots": object = ["bots": []]
        case "/v0/tasks": object = ["tasks": []]
        default: return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONSerialization.data(withJSONObject: object))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func reset() {}
    func close() { streams.forEach { $0.finish() }; streams.removeAll() }
}

@MainActor
final class HomeControllerScrollHarness: NSObject {
    private let window: UIWindow
    private let transport = ScrollTraceTransport()
    private var account: AccountController?
    private var home: AgentHomeViewController?
    private var sidebar: SidebarView?
    private var session: Session?
    private let probe = UIView()
    private var link: CADisplayLink?
    private var updates: Task<Void, Never>?
    private var samples: [[String: Any]] = []
    private var mutations: [[String: Any]] = []
    private var started: CFTimeInterval?
    private var sent = 0
    private var ready = false
    private var finished = false
    private var initialOrder: [String] = []
    private var currentArm = "off"
    private var lastProbe = 0.0

    init(window: UIWindow) {
        self.window = window
        super.init()
        currentArm = Self.argument("-traceArm") ?? "off"
        Task { await open() }
    }

    private static func argument(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }

    private func open() async {
        let transport = transport
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/full-home-scroll",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ScrollTraceHTTP(), connector: ScrollTraceSockets()
        )
        self.account = account
        do {
            let connection = try await account.agentConnections.add(.init(address: "full-home-scroll", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Personal MacBook Pro")
            let context = AppContext(account: account, variant: .development, version: "scroll-fixture")
            let home = AgentHomeViewController(context: context, id: connection.id)
            session = Session.session(for: connection.id, context: context)
            self.home = home
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            sidebar = Self.find(SidebarView.self, in: home.view)
            // The same offline full Home fixture, without trace controls
            // covering its native bottom actions.
            if ProcessInfo.processInfo.arguments.contains("-homeActionsOnly") { return }
            probe.isAccessibilityElement = true
            probe.accessibilityIdentifier = "home-controller-probe"
            probe.accessibilityLabel = "Full home trace"
            probe.frame = CGRect(x: 8, y: 120, width: 4, height: 4)
            window.addSubview(probe)
            for (index, title) in ["Start", "Stop"].enumerated() {
                let button = UIButton(type: .system)
                button.setTitle(title, for: .normal)
                button.backgroundColor = .systemBackground
                button.accessibilityIdentifier = "home-trace-\(title.lowercased())"
                button.frame = CGRect(x: window.bounds.width - 130 + CGFloat(index) * 64, y: window.bounds.height - 45, width: 60, height: 40)
                button.addTarget(self, action: index == 0 ? #selector(start) : #selector(stop), for: .touchUpInside)
                window.addSubview(button)
            }
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            self.link = link
            link.add(to: .main, forMode: .common)
        } catch { probe.accessibilityValue = "error: \(error)" }
    }

    private static func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let value = view as? T { return value }
        return view.subviews.lazy.compactMap { find(type, in: $0) }.first
    }

    @objc private func start() {
        guard let sidebar, ready else { return }
        samples = []; mutations = []; sent = 0
        finished = false
        initialOrder = sidebar.rows.map(\.id)
        started = CACurrentMediaTime()
        if currentArm != "off" {
            updates = Task { [weak self] in
                var iteration = 0
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(80)) } catch { return }
                    guard let self else { return }
                    let before = self.sample(event: "before-update")
                    let ids = sidebar.visibleRows.compactMap { Int($0.id.replacingOccurrences(of: "bot:b", with: "")) }
                    let index = ids.isEmpty ? 40 : ids[iteration % ids.count]
                    try? await transport.flip(index)
                    if currentArm == "connection", iteration.isMultiple(of: 12) {
                        let phase = iteration / 12
                        await transport.cycleConnection(phase)
                        if phase % 3 == 0 { await account?.agentConnections.setForeground(false) }
                        if phase % 3 == 1 { await account?.agentConnections.setForeground(true) }
                    }
                    sent += 1
                    mutations.append(["t": CACurrentMediaTime(), "index": index, "iteration": iteration, "order": sidebar.rows.map(\.id), "before": before])
                    iteration += 1
                }
            }
        }
    }

    @objc private func stop() {
        updates?.cancel(); updates = nil
        guard started != nil else { return }
        let object: [String: Any] = ["source": "a18bb0aad + test-only harness", "arm": currentArm, "initialOrder": initialOrder, "samples": samples, "mutations": mutations, "updates": sent, "viewport": rect(window.bounds)]
        if let data = try? JSONSerialization.data(withJSONObject: object), let path = Self.argument("-traceOutput") {
            try? data.write(to: URL(fileURLWithPath: path))
        }
        started = nil
        finished = true
        probe.accessibilityValue = "stopped:\(samples.count):\(sent)"
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let sidebar else { return }
        if !ready, CACurrentMediaTime() - lastProbe > 1 {
            lastProbe = CACurrentMediaTime()
            let info: [String: Any] = ["sidebarRows": sidebar.rows.count, "bots": sidebar.rows.filter { $0.targetKind == "bot" }.count]
            probe.accessibilityValue = "setup:\(sidebar.rows.count)"
            if let path = Self.argument("-traceOutput"), let data = try? JSONSerialization.data(withJSONObject: info) { try? data.write(to: URL(fileURLWithPath: path + ".setup.json")) }
        }
        if !ready, sidebar.rows.filter({ $0.targetKind == "bot" }).count == ScrollTraceTransport.count {
            sidebar.setContentOffset(CGPoint(x: 0, y: 1800), animated: false)
            ready = true
        }
        guard started != nil else {
            if ready && !finished { probe.accessibilityValue = "ready" }
            return
        }
        var frame = sample(event: "frame")
        frame["displayTime"] = link.timestamp
        frame["targetTime"] = link.targetTimestamp
        samples.append(frame)
        if CACurrentMediaTime() - lastProbe > 0.2 {
            lastProbe = CACurrentMediaTime()
            probe.accessibilityValue = "running:\(samples.count):\(sent):\(sidebar.isDecelerating):\(sidebar.isTracking)"
        }
    }

    private func rect(_ rect: CGRect) -> [CGFloat] { [rect.minX, rect.minY, rect.width, rect.height] }
    private func sample(event: String) -> [String: Any] {
        guard let sidebar, let home else { return [:] }
        var rows: [String: [CGFloat]] = [:]
        for row in sidebar.visibleRows {
            guard let view = sidebar.view(for: row.id) else { continue }
            let frame = view.convert(view.bounds, to: window)
            let presented = view.layer.presentation().map { $0.convert($0.bounds, to: window.layer.presentation() ?? window.layer) }
            rows[row.id] = [frame.minY, view.frame.minY, presented?.minY ?? frame.minY, frame.height]
        }
        let top = -sidebar.adjustedContentInset.top
        let bottom = max(top, sidebar.contentSize.height + sidebar.adjustedContentInset.bottom - sidebar.bounds.height)
        let labels = home.navigationItem.leftBarButtonItem?.customView
        let banners = Self.find(BannerView.self, in: home.view)
        let nav = home.navigationController?.navigationBar
        return ["event": event, "t": CACurrentMediaTime(), "offset": sidebar.contentOffset.y,
                "height": sidebar.contentSize.height, "bounds": rect(sidebar.bounds), "rows": rows,
                "insets": [sidebar.contentInset.top, sidebar.contentInset.bottom, sidebar.adjustedContentInset.top, sidebar.adjustedContentInset.bottom],
                "tracking": sidebar.isTracking, "dragging": sidebar.isDragging, "decelerating": sidebar.isDecelerating,
                "pan": sidebar.panGestureRecognizer.state.rawValue, "panVelocity": sidebar.panGestureRecognizer.velocity(in: sidebar).y,
                "topDistance": sidebar.contentOffset.y - top, "bottomDistance": bottom - sidebar.contentOffset.y,
                "bar": nav.map { rect($0.convert($0.bounds, to: window)) } ?? [],
                "title": labels.map { rect($0.convert($0.bounds, to: window)) } ?? [],
                "banner": banners.map { rect($0.convert($0.bounds, to: window)) } ?? [],
                "bannerHidden": banners?.isHidden ?? true, "headerState": String(describing: home.headerState),
                "order": sidebar.rows.map(\.id), "working": sidebar.rows.filter { $0.status == .working }.map(\.id), "updates": sent]
    }
}
#endif