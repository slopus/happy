#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import CryptoKit
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit

private struct SplitOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct SplitNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A paired computer that answers from fixtures: a few tasks and bots, and
/// one conversation every agent shares, for looking at the iPad's split
/// view with a Happy Agent home.
private actor DemoComputer: AgentTransport {
    private static let home = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],
     "bots":[{"id":"research","name":"Research Assistant","agent":{"id":"research-agent","workspaceId":"w","status":"idle"}},
       {"id":"inbox","name":"Inbox Triage","agent":{"id":"inbox-agent","workspaceId":"w","status":"idle"}}],
     "tasks":[{"id":"ipad","name":"iPad split view","agent":{"id":"ipad-agent","workspaceId":"w","status":"idle","unread":{"reason":"finished"}}},
       {"id":"cache","name":"Ship the cache","agent":{"id":"cache-agent","workspaceId":"w","status":"idle"}},
       {"id":"notes","name":"Release notes","agent":{"id":"notes-agent","workspaceId":"w","status":"idle"}}],
     "taskMemberships":[{"taskId":"ipad"},{"taskId":"cache"},{"taskId":"notes"}],"surfaces":[]}
    """#

    private static func message(_ id: String, _ role: String, _ at: Double, _ text: String) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(at), "metadata": .object([:]),
                 "content": .array([.object(["type": .string("text"), "text": .string(text)])])])
    }

    /// With `rounds`, that many more questions and answers after the
    /// four, enough to scroll.
    private let rounds: Int
    init(rounds: Int = 0) { self.rounds = rounds }

    private var run: JSONValue {
        guard case .object(var run) = Self.base, case .array(var messages)? = run["messages"] else { return Self.base }
        for round in 0..<rounds {
            let at = Double(5 + 2 * round)
            messages.append(Self.message("ru\(round)", "user", at, "Question \(round + 1): what moves when the window narrows?"))
            messages.append(Self.message("ra\(round)", "agent", at + 1, "Round \(round + 1). The sidebar folds into the stack, home at its root, and the main panel's screens follow it in order; widened, they go back where they were."))
        }
        run["messages"] = .array(messages)
        return .object(run)
    }

    private static let base: JSONValue = .object([
        "id": .string("r1"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
        "messages": .array([
            message("u1", "user", 1, "How should the iPad lay out the app?"),
            message("m1", "agent", 2, """
            A **sidebar and a main panel**, with UIKit's own `UISplitViewController`:

            - The sidebar is home: the account's list, its switcher and search.
            - The main panel holds every screen opened from it, pushed on its own stack.
            - Narrowed below 768 points, the window becomes a phone again: one stack, home at its root.

            Text in the main panel keeps a readable width, so a line never runs across a 13-inch screen.
            """),
            message("u2", "user", 3, "And when the sidebar is hidden?"),
            message("m2", "agent", 4, "The main panel takes the whole window, and the transcript stays centred at its readable width. The sidebar's button, or ⌃⌘S, brings it back, and the window remembers which way it was left."),
        ]),
    ])

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path == "/v0/bootstrap/desktop" {
            value = try JSONDecoder().decode(JSONValue.self, from: Data(Self.home.utf8))
        } else if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([run])])
        } else if path.hasSuffix("/bootstrap"), path.hasPrefix("/v0/agents/") {
            let id = String(path.split(separator: "/")[2])
            value = .object(["agent": .object(["id": .string(id), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else if method == "PUT", path.hasSuffix("/file"), let body,
                  let content = try JSONDecoder().decode(JSONValue.self, from: body)["content"]?.stringValue,
                  let bytes = Data(base64Encoded: content) {
            // A picked video is kept in the workspace, as the computer would.
            value = .object(["hash": .string(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())])
        } else if method == "POST" {
            value = .object([:])
        } else {
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func reset() {}
    func close() {}
}

/// The seeded computer's Happy CLI with `-composeMachine`: compose's first
/// send makes a Claude session there at once (its row written, as sync
/// would) instead of asking a computer that is offline.
private struct SplitComposeMachine: HomeOps, HomeSessionOps {
    static let sessionId = "split-compose-session"
    let store: LocalStore

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: Self.sessionId, seq: 0, createdAt: now, updatedAt: now, active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(options.directory), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(options.machineId), "flavor": .string(options.agent ?? "claude"), "version": .string("1.2.6"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
        try? await Task.detached { [store] in try store.upsertSessions([record]) }.value
        return .success(sessionId: Self.sessionId)
    }
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult { .error(errorMessage: "") }
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult { .error(errorMessage: "") }
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { try! JSONDecoder().decode(MachineOperationResult.self, from: Data(#"{"success":true}"#.utf8)) }
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse { throw URLError(.cannotConnectToHost) }

    func sessionKill(sessionId: String) async throws -> SessionKillResponse { throw URLError(.cannotConnectToHost) }
    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
    func archive(sessionId: String) async throws {}
    func ensureSessionReady(sessionId: String) async throws {}
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { throw URLError(.cannotConnectToHost) }

    @MainActor static func install() {
        LegacyComposeStart.makeStarter = { account in
            let machine = SplitComposeMachine(store: account.store)
            return SessionStarter(environment: .init(
                ops: machine,
                sessionOps: machine,
                sender: account.sender,
                metadataTransport: account.realtime,
                saveInitialModes: { [sender = account.sender] in try await sender.saveInitialModes(sessionId: $0, patch: $1) },
                refreshSessions: {},
                paintBotFace: { _ in throw URLError(.cannotConnectToHost) },
                attachmentPlan: { [sender = account.sender] message, sessionId in try await sender.attachmentPlan(for: message, sessionId: sessionId) },
                spawnRequests: account.spawnRequests
            ))
        }
    }
}

/// The whole app, offline, as an iPad shows it (`-screen split`): the
/// seeded Happy CLI account (`SeededAccount`), or with `-agent` a Happy
/// Agent answering from fixtures, under AppCoordinator's own split view.
///
/// For screenshots and recordings, after launch: `-open <session id or
/// agent id>` opens a chat from the sidebar, `-info` pushes its profile,
/// `-settings` opens Settings instead, `-hideSidebar` hides the sidebar,
/// `-dark` darkens the window, `-landscape` turns it on its side,
/// `-resizeLoop` narrows and widens the window in turn, `-narrow` leaves
/// an iPad's window 600 wide, `-animated` pushes the chat `-open` opens as
/// a tap does, for a recording of the push, `-linkLoop` has the switcher
/// say the link is down and up again in turn, `-pushLoop <chat id,
/// artifacts or settings>` pushes it from home and pops it in turn,
/// `-infoLoop` does the same with the open chat's detail, for recordings
/// of the header's glass going over, `-probe` reads the open chat's list
/// (`ChatScrollProbe`), `-pageProbe` the open page's scroll view
/// (`PageScrollProbe`), `-long` gives the agent's conversation 60 more
/// rounds, `-composeMachine` lets compose's first send make a session on
/// the seeded computer (`SplitComposeMachine`).
@MainActor
final class SplitAppHarness {
    private var coordinator: AppCoordinator?
    private var probe: ChatScrollProbe?
    private var pageProbe: PageScrollProbe?

    init(window: UIWindow, arguments: [String]) {
        func option(_ name: String) -> String? {
            arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        let agent = arguments.contains("-agent")
        if arguments.contains("-composeMachine") { SplitComposeMachine.install() }
        let computer = DemoComputer(rounds: arguments.contains("-long") ? 60 : 0)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/split-harness",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(),
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SplitOffline(), connector: SplitNoSocket()
        )
        Task { @MainActor in
            do {
                if agent {
                    let credentials = try JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"split-harness","port":1,"deviceID":"split-harness","deviceToken":"fixture"}"#.utf8))
                    _ = try await controller.agentConnections.add(credentials, name: "Studio Mac")
                } else {
                    try await controller.signIn(Credentials(token: "split-harness", secret: Data(repeating: 29, count: 32)))
                    guard let store = controller.session?.store else { return }
                    try await Task.detached { try SeededAccount.seed(store) }.value
                }
            } catch { fatalError("Split harness: \(error)") }
            let context = AppContext(account: controller, variant: .development, version: "split-harness")
            let coordinator = AppCoordinator(window: window, context: context)
            self.coordinator = coordinator
            coordinator.start()
            try? await Task.sleep(for: .seconds(2))
            guard let shell = window.rootViewController as? ShellViewController, let home = shell.stack.first else { return }
            // After the account's own theme has been applied.
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            // An iPad's window narrowed to the one stack, as Split View leaves it.
            if arguments.contains("-narrow"), UIDevice.current.userInterfaceIdiom == .pad {
                window.frame = CGRect(x: 0, y: 0, width: 600, height: window.bounds.height)
                try? await Task.sleep(for: .milliseconds(500))
            }
            if arguments.contains("-landscape") {
                window.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { error in print("split harness: \(error)") }
                try? await Task.sleep(for: .seconds(1))
            }
            if arguments.contains("-settings") {
                if agent {
                    SettingsViewController.open(context: context, computer: controller.agentConnections.activeID, from: home)
                } else {
                    home.push(.settings, context: context)
                }
            } else if let id = option("-open") {
                Self.open(id, from: home, context: context, agent: agent, animated: arguments.contains("-animated"))
                try? await Task.sleep(for: .seconds(1))
                if arguments.contains("-info"), let chat = shell.topViewController {
                    if let legacy = chat as? LegacyChatViewController {
                        legacy.push(.sessionInfo(id: legacy.sessionId), context: context)
                    } else if let session = controller.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }) {
                        chat.navigationController?.pushViewController(SessionDetailViewController(session: session, agentId: id, title: "iPad split view", spaceId: nil), animated: true)
                    }
                }
            }
            // The chat list as the scroll tests read it (`ChatScrollProbe`).
            if arguments.contains("-probe"), let window = window as? HarnessWindow, let chat = shell.topViewController {
                self.probe = ChatScrollProbe(window: window, chat: chat)
            }
            if arguments.contains("-pageProbe"), let page = shell.topViewController {
                try? await Task.sleep(for: .seconds(1))
                self.pageProbe = PageScrollProbe(window: window, page: page)
            }
            if arguments.contains("-hideSidebar") {
                try? await Task.sleep(for: .milliseconds(500))
                shell.setSidebarHidden(true)
            }
            if arguments.contains("-resizeLoop") { await Self.resizeLoop(window) }
            if arguments.contains("-pushLoop") {
                await Self.pushLoop(option("-pushLoop"), from: home, context: context, agent: agent)
            }
            if arguments.contains("-infoLoop"), let id = option("-open"), let chat = shell.topViewController {
                for _ in 0..<3 {
                    try? await Task.sleep(for: .seconds(2))
                    if let legacy = chat as? LegacyChatViewController {
                        legacy.push(.sessionInfo(id: legacy.sessionId), context: context)
                    } else if let session = controller.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }) {
                        chat.navigationController?.pushViewController(SessionDetailViewController(session: session, agentId: id, title: "iPad split view", spaceId: nil), animated: true)
                    }
                    try? await Task.sleep(for: .seconds(2))
                    chat.navigationController?.popToViewController(chat, animated: true)
                }
            }
            if arguments.contains("-linkLoop"), let bar = home.navigationController?.navigationBar {
                func find(_ view: UIView) -> AccountSwitcherButton? {
                    if let button = view as? AccountSwitcherButton { return button }
                    return view.subviews.lazy.compactMap(find).first
                }
                for step in 0..<6 {
                    try? await Task.sleep(for: .seconds(1.5))
                    find(bar)?.setStatus(step.isMultiple(of: 2) ? "Waiting for network…" : nil, animated: true, bar: bar)
                }
            }
        }
    }

    /// Narrow and wide in turn, as Split View or Stage Manager would leave
    /// the window, for a recording of the stack being rewritten: 600 wide
    /// (one stack), then the scene's whole width (the split), every 3 s.
    private static func resizeLoop(_ window: UIWindow) async {
        let whole = window.bounds
        for step in 0..<8 {
            try? await Task.sleep(for: .seconds(3))
            let width = step.isMultiple(of: 2) ? 600 : whole.width
            window.frame = CGRect(x: 0, y: 0, width: width, height: whole.height)
        }
    }

    /// Pushes and pops in turn, every 2 s, for a recording of the header's
    /// glass going over: `what` is a chat's id (session or agent),
    /// `artifacts` or `settings`.
    private static func pushLoop(_ what: String?, from home: UIViewController, context: AppContext, agent: Bool) async {
        guard let what, let navigation = home.navigationController else { return }
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            switch what {
            case "settings":
                if agent {
                    SettingsViewController.open(context: context, computer: context.account.agentConnections.activeID, from: home)
                } else {
                    home.push(.settings, context: context)
                }
            case "artifacts":
                guard let session = context.account.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }) else { return }
                navigation.pushViewController(ArtifactsViewController(session: session), animated: true)
            default:
                open(what, from: home, context: context, agent: agent, animated: true)
            }
            try? await Task.sleep(for: .seconds(2))
            navigation.popToRootViewController(animated: true)
        }
    }

    /// What tapping the row does: a chat from the sidebar.
    private static func open(_ id: String, from home: UIViewController, context: AppContext, agent: Bool, animated: Bool = false) {
        if agent {
            guard let session = context.account.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }),
                  let row = session.home.rows.first(where: { $0.agentId == id }) else { return }
            home.navigationController?.pushViewController(ChatViewController(session: session, agentId: id, title: row.label, spaceId: row.spaceId, intro: nil), animated: animated)
        } else {
            home.push(.session(id: id), context: context, animated: animated)
        }
    }
}
/// A page's scroll view as the UI tests read it (an element named
/// `page-scroll-probe`): its offset and how far it scrolls, and every
/// change to its offset or insets made while neither a finger nor a glide
/// was moving it. Something laying the page out under the reader shows
/// there.
@MainActor
final class PageScrollProbe: NSObject {
    private let element = ProbeElement(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private weak var scroll: UIScrollView?
    private var observations: [NSKeyValueObservation] = []
    private var foreignOffsets = 0
    private var insetChanges = 0

    init(window: UIWindow, page: UIViewController) {
        super.init()
        scroll = Self.scrollView(in: page.view)
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "page-scroll-probe"
        element.isUserInteractionEnabled = false
        element.alpha = 0.02
        element.read = { [weak self] in self?.report() ?? "{}" }
        window.addSubview(element)
        guard let scroll else { return }
        observations.append(scroll.observe(\.contentOffset, options: [.old, .new]) { [weak self] view, change in
            MainActor.assumeIsolated {
                guard change.oldValue != change.newValue, !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
                self?.foreignOffsets += 1
            }
        })
        observations.append(scroll.observe(\.contentInset, options: [.old, .new]) { [weak self] _, change in
            MainActor.assumeIsolated { if change.oldValue != change.newValue { self?.insetChanges += 1 } }
        })
    }

    private static func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        for child in view.subviews { if let found = scrollView(in: child) { return found } }
        return nil
    }

    private func report() -> String {
        guard let scroll else { return "{}" }
        let top = -scroll.adjustedContentInset.top
        let value: [String: Any] = [
            "offsetY": scroll.contentOffset.y - top,
            "maxOffsetY": max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height - top),
            "offsetX": scroll.contentOffset.x + scroll.adjustedContentInset.left,
            "foreignOffsets": foreignOffsets,
            "insetChanges": insetChanges,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
