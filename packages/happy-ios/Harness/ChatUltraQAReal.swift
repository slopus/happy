#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
@testable import HappyUI
import UIKit

/// QA only (`-qaRealChat`): the TEST account's own Home and chats, read
/// only, with the chat on UltraList and `ChatUltraQAProbe` watching.
///
/// The recovery secret arrives as a one-use file in this harness's
/// Documents (`qa-real-secret`), read and deleted at launch; it never
/// appears in launch arguments, the environment or logs. Credentials and
/// the store live in memory, and local settings in memory, so nothing is
/// shared with an installed Happy app.
///
/// The transport lets through reads only: GETs, the sign-in challenge,
/// and the two read grants for avatars and attachments. Every other
/// request fails before it leaves the phone and is counted, by method and
/// path with ids masked, in `chat-ultra-qa-real` (with the state), so the
/// report shows what a write-free session tried to do. There are no
/// sockets, so nothing live arrives while it runs.
private final class BlockedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    func add(_ request: HTTPRequest) {
        let path = request.url.path.split(separator: "/").map { part in
            part.count > 16 || part.contains(where: \.isNumber) ? "*" : String(part)
        }.joined(separator: "/")
        lock.lock()
        counts["\(request.method) /\(path)", default: 0] += 1
        lock.unlock()
    }

    var summary: [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        return counts
    }
}

private struct ReadOnlyTransport: HTTPTransport {
    let base = URLSessionTransport()
    let blocked: BlockedRequests

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let path = request.url.path
        let read = request.method == "GET" || request.method == "HEAD"
        let grant = request.method == "POST" && (path == "/v1/auth" || path.hasSuffix("/avatar/request-download") || path.hasSuffix("/attachments/request-download"))
        guard read || grant else {
            blocked.add(request)
            throw URLError(.noPermissionsToReadFile)
        }
        return try await base.send(request)
    }
}

private struct NoRealSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

@MainActor
final class ChatUltraQAReal {
    private let window: HarnessWindow
    private var account: AccountController?
    private var probe: ChatUltraQAProbe?
    private let blocked = BlockedRequests()
    private let state = ProbeElement(frame: CGRect(x: 10, y: 0, width: 2, height: 2))
    private var phase = "loading"
    private var sessions = 0

    init(window: HarnessWindow) {
        self.window = window
        state.isAccessibilityElement = true
        state.accessibilityIdentifier = "chat-ultra-qa-real"
        state.isUserInteractionEnabled = false
        state.alpha = 0.02
        state.read = { [weak self] in self?.report() ?? "{}" }
        window.addSubview(state)
        Task { await open() }
    }

    private func report() -> String {
        let value: [String: Any] = ["phase": phase, "sessions": sessions, "blocked": blocked.summary]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private func open() async {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/chat-ultra-qa", credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: { _ in InMemoryKeyValueStore() },
            transport: ReadOnlyTransport(blocked: blocked), connector: NoRealSocket()
        )
        account = controller
        do {
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let url = documents.appendingPathComponent("qa-real-secret")
            let secret = try await Task.detached {
                defer { try? FileManager.default.removeItem(at: url) }
                return try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            }.value
            let credentials = try await controller.authService.restore(secretKey: secret)
            try await controller.signIn(credentials)
            guard let session = controller.session else { throw URLError(.userAuthenticationRequired) }
            phase = "syncing"
            await session.sync.run(.sessions)
            await session.sync.run(.machines)
            await session.sync.run(.projects)
            let snapshot = try await Task.detached { try session.store.homeSnapshot() }.value
            sessions = snapshot.sessions.count
            controller.localSettings.chatListRenderer = .ultraList
            let context = AppContext(account: controller, variant: .preview, version: "chat-ultra-qa")
            let navigation = UINavigationController(rootViewController: LegacyHomeViewController(context: context, session: session))
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            let shell = TabletShellViewController(context: context, detail: navigation)
            window.rootViewController = shell
            probe = ChatUltraQAProbe(window: window, chat: nil, redacted: true)
            shell.rootDidChange()
            window.bringSubviewToFront(state)
            phase = "ready"
        } catch {
            phase = "failed (details withheld)"
        }
    }
}
#endif
