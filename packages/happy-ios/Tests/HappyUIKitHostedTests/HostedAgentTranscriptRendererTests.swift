#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private struct RendererOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct RendererNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct RendererUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// Which transcript the agents' chat opens on, and that the UI tests can
/// still find it either way.
@MainActor
final class HostedAgentTranscriptRendererTests: XCTestCase {
    private func session() async throws -> (AccountController, Session) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in RendererUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RendererOffline(), connector: RendererNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"renderer-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        return (controller, try XCTUnwrap(Session.session(for: computer.id, context: context)))
    }

    private func chat(_ session: Session, previewing: Bool = false) -> ChatViewController {
        let chat = ChatViewController(session: session, agentId: "renderer", title: "Chat", spaceId: nil, seedling: nil, previewing: previewing)
        chat.view.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        chat.loadViewIfNeeded()
        chat.view.layoutIfNeeded()
        return chat
    }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews {
            if let found = find(type, in: subview) { return found }
        }
        return nil
    }

    /// With nothing stored, which is UltraList now, the transcript is the
    /// list, and it carries the identifier the UI tests look for.
    func testTheChatOpensOnUltraListAndKeepsTheTranscriptIdentifier() async throws {
        let (_, session) = try await self.session()
        XCTAssertEqual(session.localSettings.chatListRenderer, .ultraList)
        let chat = self.chat(session)
        let list = try XCTUnwrap(find(UltraListView.self, in: chat.view), "no UltraList in the chat")
        XCTAssertEqual(list.accessibilityIdentifier, "transcript")
        XCTAssertNil(find(UIScrollView.self, in: chat.view)?.accessibilityIdentifier,
                     "a scroll view also claimed to be the transcript")
    }

    /// The collection renderer, still in Appearance, keeps the scroll view
    /// the screen fills itself, with the same identifier on it.
    func testThePickedCollectionRendererKeepsTheScrollView() async throws {
        let (_, session) = try await self.session()
        session.localSettings.chatListRenderer = .collectionView
        addTeardownBlock { @MainActor in session.localSettings.chatListRenderer = .ultraList }
        let chat = self.chat(session)
        XCTAssertNil(find(UltraListView.self, in: chat.view))
        let scroll = try XCTUnwrap(find(UIScrollView.self, in: chat.view))
        XCTAssertEqual(scroll.accessibilityIdentifier, "transcript")
    }

    /// A preview keeps the scroll view whatever the setting says: its fade
    /// and its title are measured against that scroll's own offset.
    func testAPreviewKeepsTheScrollViewOnEitherRenderer() async throws {
        let (_, session) = try await self.session()
        let preview = chat(session, previewing: true)
        XCTAssertNil(find(UltraListView.self, in: preview.view), "a preview was given the list")
        XCTAssertNotNil(find(UIScrollView.self, in: preview.view))
    }
}
#endif
