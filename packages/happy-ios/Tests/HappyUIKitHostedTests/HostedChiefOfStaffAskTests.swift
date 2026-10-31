#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct AskOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct AskNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct AskUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// Settings' asks, in the conversation: the words are typed in for the
/// person, the keyboard is up, and nothing is sent or saved on their
/// behalf. What the words are, and what happens to a draft already there,
/// is `ChatPrefillTests`.
@MainActor
final class HostedChiefOfStaffAskTests: XCTestCase {
    private static let agentId = "chief-of-staff-ask"

    func testTheAskIsTypedInFocusedAndUnsentWithoutWritingTheDraft() async throws {
        try await checkAsk(existing: nil)
    }

    func testTheAskWaitsForTheKeptDraftWithoutReplacingIt() async throws {
        try await checkAsk(existing: Draft(text: "Ask about the invoice", updatedAt: 42, synced: true))
    }

    private func checkAsk(existing: Draft?) async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in AskUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: AskOffline(), connector: AskNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"ask-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        await session.drafts.keep(Self.agentId, existing)
        // A conversation read ahead can deliver its first snapshot during
        // view loading, before the screen asks for the phone's kept draft.
        let warm = session.warm.hold(Self.agentId)
        defer { session.warm.release(warm.chat, token: warm.token, opened: false) }
        try await until { warm.chat.snapshot.loaded }
        let ask = ChatPrefill.agentName
        let expected = ask.applied(to: existing?.text ?? "").text
        let chat = ChatViewController(session: session, agentId: Self.agentId, title: "Happy", spaceId: nil, seedling: nil, prefill: ask)
        let navigation = UINavigationController(rootViewController: chat)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true }
        window.layoutIfNeeded()

        let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view))
        try await until { card.textView.text == expected }
        XCTAssertEqual(card.textView.selectedRange, NSRange(location: (ask.prefix as NSString).length, length: 0),
                       "the caret is after the ask, ready for the name")
        try await until { card.textView.isFirstResponder }

        // Opening writes nothing: an ask the person ignores is not kept.
        try await Task.sleep(for: .milliseconds(600))
        let drafts = session.drafts
        var kept = await drafts.draft(Self.agentId)
        XCTAssertEqual(kept, existing, "opening changed the stored draft")
        XCTAssertEqual(card.textView.text, expected, "the ask and existing words are still there, unsent")
        chat.view.frame.size = CGSize(width: 852, height: 393)
        chat.view.setNeedsLayout()
        chat.view.layoutIfNeeded()
        XCTAssertEqual(card.textView.text, expected, "another layout prefixed the draft again")
        XCTAssertEqual(card.textView.selectedRange.location, (ask.prefix as NSString).length)

        // Typing is what saves it, as anywhere else. The caret is where
        // the ask left it, so what is typed reads on from the words.
        card.textView.insertText("Steve's laptop")
        let typed = ask.prefix + "Steve's laptop" + (existing.map { "\n\n" + $0.text } ?? "")
        XCTAssertEqual(card.textView.text, typed)
        try await until {
            kept = await drafts.draft(Self.agentId)
            return kept?.text == typed
        }
    }

    /// No Chief of Staff read yet: Settings has nothing to open, and says
    /// so by having nothing to push.
    func testNoChiefOfStaffMeansNoConversationToOpen() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in AskUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: AskOffline(), connector: AskNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"ask-none","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        XCTAssertNil(ChiefOfStaffAsk.chat(session: session, snapshot: Snapshot(), ask: .agentAvatar))
        var snapshot = Snapshot()
        snapshot.happyAgentId = Self.agentId
        XCTAssertTrue(ChiefOfStaffAsk.chat(session: session, snapshot: snapshot, ask: .agentAvatar) is ChatViewController,
                      "with one read, its conversation opens")
    }

    private static func subview<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews {
            if let found = Self.subview(type, in: subview) { return found }
        }
        return nil
    }

    private func until(_ condition: () async -> Bool, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("timed out", file: file, line: line)
    }
}
#endif
