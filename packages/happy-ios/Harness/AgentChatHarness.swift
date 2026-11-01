#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct AgentChatHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct AgentChatSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `harness`, with forty turns of a question and a few lines of
/// answer, and nothing streaming.
private struct AgentChatComputer: AgentTransport {
    private static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    private static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    private static let runs: [JSONValue] = (0..<40).map { index in
        let answer = "Answer \(index). " + String(repeating: "The cache keeps what it read and drops it when the file changes. ", count: 1 + index % 4)
        return .object([
            "id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
            "messages": .array([
                message("u\(index)", role: "user", [text("Question \(index): why does the cache test fail?")]),
                message("m\(index)", role: "agent", [text(answer)]),
            ]),
        ])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/harness/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(Self.runs)])
        } else if path.hasSuffix("/agents/harness/bootstrap") {
            value = .object(["agent": .object(["id": .string("harness"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else {
            throw URLError(.cannotConnectToHost)
        }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() async {}
    func close() async {}
}

/// The agents' chat for the keyboard's UI tests (`-screen agentChat`): an
/// offline computer's home with a long conversation pushed over it, and
/// the same probe the sessions' chat has (`ChatScrollProbe`).
/// `-hideKeyboardButton` and `-keyboard` work as they do there.
@MainActor
final class AgentChatHarness {
    private var account: AccountController?
    private var probe: ChatScrollProbe?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/agent-chat",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in AgentChatComputer() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: AgentChatHTTP(), connector: AgentChatSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "agent-chat", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "agent-chat")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            let chat = ChatViewController(session: session, agentId: "harness", title: "Cache", spaceId: nil, intro: nil)
            navigation.pushViewController(chat, animated: false)
            let probe = ChatScrollProbe(window: window, chat: chat)
            self.probe = probe
            if arguments.contains("-keyboard") { probe.focusComposerWhenFilled() }
        } catch {
            print("AGENT_CHAT error: \(error)")
        }
    }
}
#endif
