#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct MentionsOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct MentionsNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A team's computer, a Happy Agent daemon in team mode or a Happy Cloud
/// server, as the `@` palette reads it: the desktop bootstrap's
/// `teammates` (Steve signed in) and one task, "Plan the launch".
private struct MentionsServer: AgentTransport {
    static let team: [(id: String, name: String, role: String?, hash: String?)] = [
        ("steve", "Steve", "founder", nil),
        ("kirill", "Kirill Brandt", "iOS", "1QcSHQRnh493V4dIh4eXh1h4kJUI"),
        ("anna", "Anna Petrova", "designer", "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"),
        ("max", "Max Müller", nil, nil),
        ("ada", "Ada Lovelace", "research", nil),
        ("bo", "Bo Kim", nil, nil),
    ]

    private static func person(_ user: (id: String, name: String, role: String?, hash: String?)) -> String {
        let photo = user.hash.map { #"{"thumbhash":"\#($0)"}"# } ?? "null"
        let role = user.role.map { #""\#($0)""# } ?? "null"
        return #"{"id":"\#(user.id)","name":"\#(user.name)","photo":\#(photo),"role":\#(role)}"#
    }

    static var bootstrap: String {
        #"""
        {"cursor":"cursor-1","profile":{"userId":"steve","name":"Steve"},"userSettings":[],
         "projects":[],"workspaces":[],"bots":[],
         "tasks":[{"id":"launch","name":"Plan the launch","ownerUserId":"steve","status":"active","agent":{"id":"launch-agent","workspaceId":"w1","status":"idle"}}],
         "taskMemberships":[{"taskId":"launch"}],"surfaces":[],
         "teammates":[\#(team.map(person).joined(separator: ","))]}
        """#
    }

    private static func message(_ id: String, role: String, _ text: String) -> JSONValue {
        let message: JSONValue = .object(["id": .string(id), "role": .string(role), "createdAt": .number(1_000), "metadata": .object([:]),
                                          "content": .array([.object(["type": .string("text"), "text": .string(text)])])])
        return role == "user" ? MessageSchema.withUserFields(message) : message
    }

    /// The task's one turn: a mention in the agent's answer reads as "@" and the name.
    private static let history: JSONValue = .object(["hasMore": .bool(false), "runs": .array([.object([
        "id": .string("r1"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
        "messages": .array([
            message("u1", role: "user", "Draft the launch plan for Monday."),
            message("m1", role: "agent", "Here is a first plan. [Anna Petrova](happy://users/anna) could take the visuals."),
        ]),
    ])])])

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        if path == "/v0/bootstrap/desktop" { return ok(Self.bootstrap) }
        if path == "/v0/permissions" { return ok(#"{"granted":["content.write"]}"#) }
        if path == "/v0/health" { return ok(#"{"ok":true}"#) }
        if path.hasPrefix("/v0/users?ids=") { return ok(#"{"users":[\#(Self.team.map(Self.person).joined(separator: ","))]}"#) }
        if path.contains("/agents/launch-agent/messages") {
            return HTTP1Response(status: 200, body: try JSONEncoder().encode(Self.history))
        }
        if path.hasSuffix("/agents/launch-agent/bootstrap") {
            return ok(#"{"agent":{"id":"launch-agent","workspaceId":"w1","status":"idle"},"pending":[],"slashCommands":[]}"#)
        }
        return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() async {}
    func close() async {}
}

/// The agent composer's `@` mentions (`-screen mentions`): a team's
/// computer (`-server agent` for a Happy Agent daemon, else Happy Cloud),
/// the task's chat or new work (`-open chat|new`), the composer focused
/// with `-draft` typed into it, with `-pick` the first person picked by
/// Return, and with `-send` a few more words typed and sent. `-snapshot
/// <name>` draws every window into Documents/mentions/<name>.png, for a
/// device, where nothing outside the app can take the screen. Prints `MENTIONS ready` once it is on screen.
@MainActor
final class MentionsHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        let server = MentionsServer()
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/mentions",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: MentionsOffline(), connector: MentionsNoSocket()
        )
        self.account = account
        if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
        do {
            let connection: AgentConnection
            if value("-server") == "agent" {
                connection = try await account.agentConnections.add(.init(address: "team-daemon", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Team daemon")
            } else {
                let origin = HappyCloud.server(named: "acme")
                connection = try await account.agentConnections.addServer(AgentOrigin(origin),
                    signIn: ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(clientId: "harness"), userId: "steve"),
                    access: OAuthAccess(token: "harness", expiresAt: nil), name: "Acme")
            }
            let context = AppContext(account: account, variant: .development, version: "mentions")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            try? await Task.sleep(for: .seconds(1))
            let chat = value("-open") == "new"
                ? NewWork.chat(session, task: NewTask(client: session.client))
                : ChatViewController(session: session, agentId: "launch-agent", title: "Plan the launch", spaceId: "launch", intro: nil)
            navigation.pushViewController(chat, animated: false)
            try? await Task.sleep(for: .seconds(1))
            chat.card.focus()
            if let draft = value("-draft") {
                chat.card.setText(draft, selection: NSRange(location: (draft as NSString).length, length: 0))
            }
            try? await Task.sleep(for: .seconds(1))
            if arguments.contains("-pick") {
                _ = chat.agentInputCardShouldInsertNewline(chat.card)
                try? await Task.sleep(for: .milliseconds(500))
            }
            if arguments.contains("-send") {
                chat.card.textView.insertText("can you take the visuals?")
                chat.agentInputCardDidPressSend(chat.card)
                try? await Task.sleep(for: .seconds(1))
                chat.card.blur()
                try? await Task.sleep(for: .milliseconds(800))
            }
            if let name = value("-snapshot") { snapshot(window, name: name) }
            print("MENTIONS ready draft=\(chat.card.text)")
        } catch {
            print("MENTIONS error: \(error)")
        }
    }

    private func snapshot(_ window: UIWindow, name: String) {
        guard let scene = window.windowScene else { return }
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.screen.scale
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            for each in scene.windows where !each.isHidden {
                each.drawHierarchy(in: each.frame, afterScreenUpdates: true)
            }
        }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("mentions")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? image.pngData()?.write(to: directory.appendingPathComponent(name + ".png"))
    }
}
#endif
