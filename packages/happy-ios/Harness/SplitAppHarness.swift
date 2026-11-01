#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import Foundation
import HappyCore
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

    private static let run: JSONValue = .object([
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
            value = .object(["hasMore": .bool(false), "runs": .array([Self.run])])
        } else if path.hasSuffix("/bootstrap"), path.hasPrefix("/v0/agents/") {
            let id = String(path.split(separator: "/")[2])
            value = .object(["agent": .object(["id": .string(id), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
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

/// The whole app, offline, as an iPad shows it (`-screen split`): the
/// seeded Happy CLI account (`SeededAccount`), or with `-agent` a Happy
/// Agent answering from fixtures, under AppCoordinator's own split view.
///
/// For screenshots and recordings, after launch: `-open <session id or
/// agent id>` opens a chat from the sidebar, `-info` pushes its profile,
/// `-settings` opens Settings instead, `-hideSidebar` hides the sidebar,
/// `-dark` darkens the window, `-landscape` turns it on its side,
/// `-resizeLoop` narrows and widens the window in turn, `-narrow` leaves
/// an iPad's window 600 wide, `-probe` reads the open chat's list
/// (`ChatScrollProbe`).
@MainActor
final class SplitAppHarness {
    private var coordinator: AppCoordinator?
    private var probe: ChatScrollProbe?

    init(window: UIWindow, arguments: [String]) {
        func option(_ name: String) -> String? {
            arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        let agent = arguments.contains("-agent")
        let computer = DemoComputer()
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
                Self.open(id, from: home, context: context, agent: agent)
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
            if arguments.contains("-hideSidebar") {
                try? await Task.sleep(for: .milliseconds(500))
                shell.setSidebarHidden(true)
            }
            if arguments.contains("-resizeLoop") { await Self.resizeLoop(window) }
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

    /// What tapping the row does: a chat from the sidebar.
    private static func open(_ id: String, from home: UIViewController, context: AppContext, agent: Bool) {
        if agent {
            guard let session = context.account.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }),
                  let row = session.home.rows.first(where: { $0.agentId == id }) else { return }
            home.navigationController?.pushViewController(ChatViewController(session: session, agentId: id, title: row.label, spaceId: row.spaceId, intro: nil), animated: false)
        } else {
            home.push(.session(id: id), context: context, animated: false)
        }
    }
}
#endif
