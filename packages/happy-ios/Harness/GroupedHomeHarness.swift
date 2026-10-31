#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

private struct GroupedHomeHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct GroupedHomeSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer with bots, tasks, Surfaces and a project, each with nested
/// conversations.
private actor GroupedHomeTransport: AgentTransport {
    /// The cloned repo's picture, as the daemon serves it.
    let avatar: Data
    init(avatar: Data) { self.avatar = avatar }

    private static let now = Date().timeIntervalSince1970 * 1000

    private static func agent(_ id: String, _ title: String, status: String = "idle", question: Bool = false, unread: Bool = false, line: String? = nil, subtasks: [[String: Any]] = [], parent: String? = nil, ago minutes: Double = 240) -> [String: Any] {
        var agent: [String: Any] = ["id": id, "workspaceId": "w-\(id)", "title": title, "status": status, "subtasks": subtasks, "lastActivityAt": now - minutes * 60_000]
        if question { agent["pendingQuestionId"] = "q-\(id)" }
        if unread { agent["unread"] = ["reason": "message", "since": now] }
        if let line { agent["statusLine"] = ["text": line, "updatedAt": now - 6 * 60_000] }
        if let parent { agent["parentAgentId"] = parent }
        return agent
    }

    static var bots: [[String: Any]] { [
        ["id": "happy", "name": "Happy", "systemKey": "chief_of_staff", "status": "active", "agent": agent("happy-agent", "Happy", line: "Watching the release", subtasks: [
            agent("happy-sub1", "Triage new issues", status: "working", parent: "happy-agent", ago: 7),
            agent("happy-sub2", "Weekly digest", parent: "happy-agent"),
        ], ago: 25)],
        ["id": "research", "name": "Research Assistant", "status": "active", "agent": agent("research-agent", "Research Assistant", status: "working", line: "Reading the papers", ago: 3)],
        ["id": "release", "name": "Release Bot", "status": "active", "agent": agent("release-agent", "Release Bot", question: true, line: "Ship 2026.10.4 to TestFlight?", ago: 12)],
    ] }

    static var tasks: [[String: Any]] { [
        ["id": "landing", "name": "Landing page copy", "agent": agent("landing-agent", "Landing page copy", unread: true, line: "Drafted three headlines", ago: 5)],
        ["id": "crash", "name": "Fix login crash", "agent": agent("crash-agent", "Fix login crash", status: "working", line: "Bisecting the keychain change", subtasks: [
            agent("crash-sub1", "Reproduce on iOS 26", parent: "crash-agent"),
            agent("crash-sub2", "Write the regression test", status: "working", parent: "crash-agent", ago: 2),
        ], ago: 1)],
        ["id": "report", "name": "Quarterly report", "agent": agent("report-agent", "Quarterly report", line: "Charts are in the doc", ago: 40)],
        ["id": "onboarding", "name": "Onboarding emails", "agent": agent("onboarding-agent", "Onboarding emails")],
    ] }

    static var surfaces: [[String: Any]] { [
        ["id": "groceries", "name": "Groceries", "type": "todo", "members": [["userId": NSNull(), "orderKey": "a"]]],
        ["id": "notes", "name": "Design notes", "type": "document", "members": [["userId": NSNull(), "orderKey": "b"]]],
        ["id": "calendar", "name": "Team calendar", "type": "calendar", "members": [["userId": NSNull(), "orderKey": "c"]]],
    ] }

    private func desktop() -> [String: Any] {
        [
            "cursor": "c1", "profile": ["userId": NSNull()],
            "userSettings": [],
            "bots": Self.bots, "tasks": Self.tasks,
            "taskMemberships": Self.tasks.map { ["taskId": $0["id"]!] },
            "surfaces": Self.surfaces,
            "projects": [
                ["id": "p1", "name": "happy", "status": "active", "orderKey": "a", "avatar": ["url": "/v0/projects/p1/avatar", "width": 64, "height": 64], "agents": [Self.agent("root", "Root chat")]],
                ["id": "p2", "name": "website", "status": "active", "orderKey": "b", "agents": []],
            ],
            "workspaces": [
                ["id": "w1", "projectId": "p1", "parentId": "p1", "name": "ios-grouped-home", "kind": "worktree", "status": "active", "orderKey": "a", "agents": [Self.agent("w1-agent", "Grouped home", ago: 18)]],
            ],
        ]
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let route = path.split(separator: "?").first.map(String.init) ?? path
        if route == "/v0/projects/p1/avatar" { return .init(status: 200, body: avatar) }
        let object: [String: Any]
        switch route {
        case "/v0/health": object = ["ready": true, "version": ["protocol": 27], "capabilities": ["sidebarOperations": true]]
        case "/v0/config": object = ["config": ["node": ["name": "Personal MacBook Pro"]]]
        case "/v0/bootstrap/desktop": object = desktop()
        case "/v0/bots": object = ["bots": Self.bots]
        case "/v0/tasks": object = ["tasks": Self.tasks, "memberships": Self.tasks.map { ["taskId": $0["id"]!] }]
        case "/v0/surfaces": object = ["surfaces": Self.surfaces.map { ["id": $0["id"]!, "name": $0["name"]!, "type": $0["type"]!] }]
        default: return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONSerialization.data(withJSONObject: object))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func reset() {}
    func close() {}
}

/// Home as the person sees it, grouped (`-screen groupedHome`): the real
/// home screen over a computer serving bots, tasks and Surfaces with
/// nested conversations, and a cloned repo wearing its
/// picture. With `-storyRows`, the story rows' list alone, grouped as home
/// draws it.
@MainActor
final class GroupedHomeHarness {
    private var account: AccountController?
    private var home: AgentHomeViewController?

    init(window: UIWindow, arguments: [String]) {
        if arguments.contains("-storyRows") {
            let controller = UIViewController()
            controller.view.backgroundColor = UIColor(Palette.groupedGround)
            let sidebar = SidebarView(frame: .zero)
            sidebar.style = .grouped
            sidebar.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            controller.view.addSubview(sidebar)
            window.rootViewController = controller
            DispatchQueue.main.async {
                sidebar.frame = controller.view.bounds.inset(by: UIEdgeInsets(top: controller.view.safeAreaInsets.top, left: 0, bottom: 0, right: 0))
                sidebar.apply(StoryRowsHarness.rows())
                sidebar.selectedRowId = "space:deploy"
            }
            return
        }
        let bottom = arguments.contains("-bottom")
        Task {
            await open(window: window)
            // With `-bottom`, the list's end, where the projects are.
            guard bottom else { return }
            try? await Task.sleep(for: .seconds(1.5))
            guard let list = home?.view.firstSubview(of: SidebarView.self) else { return }
            list.setContentOffset(CGPoint(x: 0, y: max(-list.contentInset.top, list.contentSize.height + list.contentInset.bottom - list.bounds.height)), animated: false)
        }
    }

    /// A repo's picture: a GitHub-like square, its initial on a gradient.
    private static func repoPicture() -> Data {
        let size = CGSize(width: 96, height: 96)
        return UIGraphicsImageRenderer(size: size).pngData { context in
            let colors = [UIColor(red: 0.42, green: 0.36, blue: 0.95, alpha: 1).cgColor, UIColor(red: 0.95, green: 0.38, blue: 0.62, alpha: 1).cgColor] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            let text = NSAttributedString(string: "h", attributes: [.font: UIFont.systemFont(ofSize: 60, weight: .bold), .foregroundColor: UIColor.white])
            let box = text.size()
            text.draw(at: CGPoint(x: (size.width - box.width) / 2, y: (size.height - box.height) / 2 - 4))
        }
    }

    private func open(window: UIWindow) async {
        let transport = GroupedHomeTransport(avatar: Self.repoPicture())
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/grouped-home",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: GroupedHomeHTTP(), connector: GroupedHomeSockets()
        )
        self.account = account
        do {
            let connection = try await account.agentConnections.add(.init(address: "grouped-home", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Personal MacBook Pro")
            let context = AppContext(account: account, variant: .development, version: "grouped-home")
            let home = AgentHomeViewController(context: context, id: connection.id)
            self.home = home
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
        } catch {
            print("GROUPED_HOME error: \(error)")
        }
    }
}

private extension UIView {
    func firstSubview<T: UIView>(of type: T.Type) -> T? {
        if let view = self as? T { return view }
        return subviews.lazy.compactMap { $0.firstSubview(of: type) }.first
    }
}
#endif
