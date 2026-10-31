#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import UIKit

private struct ChatHeaderHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ChatHeaderSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct ChatHeaderUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// A conversation under its glass header (`-screen chatHeader`): home of an
/// offline computer with the chat pushed over it, so the bar has its back
/// button, and a transcript long enough to run under the header. With
/// `-top` it rests at its first message, nothing under the header; without
/// it, at its newest, older words under the glass. `-dark` is dark mode.
@MainActor
final class ChatHeaderHarness {
    private var account: AccountController?

    init(window: UIWindow, arguments: [String]) {
        window.overrideUserInterfaceStyle = arguments.contains("-dark") ? .dark : .light
        let top = arguments.contains("-top")
        Task { await open(window: window, top: top) }
    }

    private static let words = [
        (ChatItem.Role.user, "Make the chat's header Liquid Glass, like Telegram's on iOS 26."),
        (.agent, "On it. Telegram draws the back button, the title and the avatar each on their own piece of glass, and the messages scroll under all of them with only a soft fade under the status bar. The bar itself has no ground at all."),
        (.user, "What goes where for us?"),
        (.agent, "Back stays the system's own glass circle, so its swipe and its history menu stay too. The name and what the agent is doing sit together on one capsule in the middle, and compose and the More menu share the capsule at the right, as UIKit groups neighbouring bar buttons."),
        (.user, "And the menu still opens out of its button?"),
        (.agent, "Yes: it is still the bar button's own native menu, so it morphs out of the glass it sits on. Nothing about the menu itself changes."),
        (.user, "Show me light and dark, at the top and scrolled."),
        (.agent, "Here they are. Scrolled, the earlier messages pass under the capsules and you can read them softly through the glass, the way Telegram's do."),
    ]

    private func open(window: UIWindow, top: Bool) async {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/chat-header",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in ChatHeaderUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ChatHeaderHTTP(), connector: ChatHeaderSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "chat-header", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Personal MacBook Pro")
            let context = AppContext(account: account, variant: .development, version: "chat-header")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            let chat = ChatViewController(session: session, agentId: "chat-header", title: "Liquid Glass chat header", spaceId: nil, seedling: nil)
            navigation.pushViewController(chat, animated: false)
            window.layoutIfNeeded()
            // The offline conversation's own empty plan lands first.
            try await Task.sleep(for: .seconds(1))
            guard let list = chat.view.firstSubview(of: AgentChatUltraList.self) else { return }
            let key = ChatPlanner.Key(width: chat.view.bounds.width, maxContentWidth: ContentWidth.maxWidth, environment: chat.traitCollection.textEnvironment)
            let plans = Self.words.enumerated().map { index, said in
                ChatPlanner.plan(ChatItem(id: "m\(index)", role: said.0, pieces: [.text(said.1)], delivery: .sent), key: key, copied: false, syntax: session.syntax)
            }
            list.apply(plans)
            try await Task.sleep(for: .milliseconds(300))
            if top { list.list.scrollToTop(animated: false) } else { list.scrollToNewest(animated: false) }
        } catch {
            print("CHAT_HEADER error: \(error)")
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
