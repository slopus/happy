#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct RecordingOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct RecordingNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private actor RecordingComputer: AgentTransport {
    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1_761_990_000_000), "metadata": .object([:]), "content": .array(content)])
    }

    static let runs: [JSONValue] = (0..<12).map { index in
        .object([
            "id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
            "messages": .array([
                message("u\(index)", role: "user", [text("Question \(index): why does the cache test fail?")]),
                message("m\(index)", role: "agent", [text("Answer \(index). The cache keeps what it read and drops it when the file changes.")]),
            ]),
        ])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(Self.runs)])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() {}
    func close() {}
}

/// Not a check: a few sends in each chat, slowed down `HAPPY_RECORDING`
/// times, for a screen recording of the send. Skipped without it.
@MainActor
final class HostedSendRecordingTests: XCTestCase {
    private var slow: Float = 1

    override func setUp() async throws {
        try await super.setUp()
        guard let factor = ProcessInfo.processInfo.environment["HAPPY_RECORDING"].flatMap(Float.init) else { throw XCTSkip("no HAPPY_RECORDING") }
        slow = factor
        LegacyFonts.registerBundledFonts()
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews { if let found = find(type, in: subview) { return found } }
        return nil
    }

    private func sends(_ card: AgentInputCardView, view: UIView, window: UIWindow, name: String) async throws {
        XCTAssertTrue(card.textView.becomeFirstResponder())
        _ = try await until(seconds: 3) { view.keyboardLayoutGuide.layoutFrame.height > 100 }
        try await Task.sleep(for: .milliseconds(1200))
        let recorder = HostedFrameRecorder(window: window, name: name)
        recorder?.start()
        defer { recorder?.stop() }
        window.layer.speed = 1 / slow
        for words in ["Run the tests", "Then clear the cache and run them again, and tell me which of them got faster"] {
            card.setText(words, selection: NSRange(location: (words as NSString).length, length: 0))
            try await Task.sleep(for: .milliseconds(Int(500 * slow)))
            card.delegate?.agentInputCardDidPressSend(card)
            try await Task.sleep(for: .milliseconds(Int(1000 * slow)))
        }
        window.endEditing(true)
        try await Task.sleep(for: .milliseconds(Int(600 * slow)))
        window.layer.speed = 1
        card.setText("Once more with the keyboard down", selection: NSRange(location: 32, length: 0))
        try await Task.sleep(for: .milliseconds(600))
        window.layer.speed = 1 / slow
        card.delegate?.agentInputCardDidPressSend(card)
        try await Task.sleep(for: .milliseconds(Int(1000 * slow)))
        window.layer.speed = 1
    }

    func testRecordTheAgentChatsSend() async throws {
        let computer = RecordingComputer()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RecordingOffline(), connector: RecordingNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"recording","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "Cache", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        addTeardownBlock { @MainActor in
            window.layer.speed = 1
            window.endEditing(true)
            window.isHidden = true
            hostWindow?.makeKey()
            Session.forget(pairing.id)
            try? await controller.agentConnections.remove(pairing.id)
        }
        window.layoutIfNeeded()
        _ = try await until { chat.plans.count > 12 }
        try await Task.sleep(for: .milliseconds(800))
        try await sends(chat.card, view: chat.view, window: window, name: "agent")
    }

    func testRecordTheLegacyChatsSend() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RecordingOffline(), connector: RecordingNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let chat = LegacyChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + FixtureScenario.long.rawValue)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.layer.speed = 1
            window.endEditing(true)
            window.isHidden = true
            hostWindow?.makeKey()
            await controller.signOut()
        }
        window.layoutIfNeeded()
        _ = try await until { chat.contentInstalled }
        let list = try XCTUnwrap(find(ChatListView.self, in: chat.view))
        _ = try await until { list.plans.count > 20 && list.isDisplayReady }
        try await Task.sleep(for: .milliseconds(800))
        let card = try XCTUnwrap(find(AgentInputCardView.self, in: try XCTUnwrap(find(ChatDockView.self, in: chat.view))))
        try await sends(card, view: chat.view, window: window, name: "legacy")
    }
}
#endif
