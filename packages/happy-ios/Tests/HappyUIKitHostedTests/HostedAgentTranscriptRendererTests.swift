#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
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
        XCTAssertNotNil(chat.view.subviews.compactMap { $0 as? HeaderScrimView }.first { $0.edge == .top })
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
        XCTAssertFalse(chat.view.subviews.compactMap { $0 as? HeaderScrimView }.contains { $0.edge == .top })
        let scroll = try XCTUnwrap(find(UIScrollView.self, in: chat.view))
        XCTAssertEqual(scroll.accessibilityIdentifier, "transcript")
    }

    func testASendReadsTheUltraListDistanceInHistoryAndNearTheEnd() async throws {
        let (_, session) = try await self.session()
        let chat = self.chat(session)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        // Let the offline conversation and its empty initial plan arrive.
        try await Task.sleep(for: .milliseconds(250))
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: chat.view))
        let scrim = try XCTUnwrap(chat.view.subviews.compactMap { $0 as? HeaderScrimView }.first { $0.edge == .top })
        XCTAssertFalse(scrim.isUserInteractionEnabled)
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            XCTAssertEqual(scrim.ground.resolvedColor(with: traits), chat.view.backgroundColor?.resolvedColor(with: traits))
        }
        let input = try XCTUnwrap(find(AgentInputCardView.self, in: chat.view))
        XCTAssertEqual(transcript.list.viewportInsets.top, Double(chat.view.bounds.height - input.frame.minY + ChatScreenLayout.Metrics.listGap), accuracy: 1)
        XCTAssertEqual(transcript.list.viewportInsets.bottom, Double(chat.view.safeAreaInsets.top), accuracy: 1)
        transcript.apply([ChatRowPlan(id: "short", size: CGSize(width: chat.view.bounds.width, height: 60), items: [])])
        try await until { transcript.list.loadedItemView(at: 0) != nil }
        let short = try XCTUnwrap(transcript.list.loadedItemView(at: 0))
        XCTAssertEqual(short.convert(short.bounds, to: chat.view).maxY, input.frame.minY - ChatScreenLayout.Metrics.listGap, accuracy: 1,
                       "a short conversation must rest above the composer")
        let plans = (0..<40).map { ChatRowPlan(id: "row-\($0)", size: CGSize(width: chat.view.bounds.width, height: 80), items: []) }
        transcript.apply(plans)
        try await until { transcript.list.loadedItemView(at: 0) != nil }
        XCTAssertTrue(chat.sendFollowsNewest)
        XCTAssertEqual(scrim.presence, 1)

        transcript.list.scrollToTop(animated: false)
        try await until { transcript.distanceFromOldest < 1 }
        XCTAssertEqual(scrim.presence, 0)

        transcript.list.scrollTo(.init(index: 15), transition: .none)
        try await until { transcript.distanceFromNewest > 200 }
        XCTAssertFalse(chat.sendFollowsNewest, "a send in history read the unused scroll view's offset")

        transcript.list.scrollTo(.init(index: 0, pointOffset: -50), transition: .none)
        try await until { (30...80).contains(transcript.distanceFromNewest) }
        XCTAssertFalse(transcript.followsNewest, "the 24pt reading threshold differs from the 80pt send threshold")
        XCTAssertTrue(chat.sendFollowsNewest, "a send near the end should follow it")
        transcript.scrollToNewest(animated: false)
        try await until { abs(transcript.distanceFromNewest) < 1 }
        XCTAssertTrue(chat.sendFollowsNewest)
    }

    func testAnAppendTargetsTheIncomingNewestRowAboveTheComposer() async throws {
        let (_, session) = try await self.session()
        let chat = self.chat(session)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(250))
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: chat.view))
        let input = try XCTUnwrap(find(AgentInputCardView.self, in: chat.view))
        let plans = (0..<40).map { ChatRowPlan(id: "row-\($0)", size: CGSize(width: chat.view.bounds.width, height: 80), items: []) }
        transcript.apply(plans)
        try await until { transcript.list.loadedItemView(at: 0) != nil }
        transcript.scrollToNewest(animated: false)
        try await until { abs(transcript.distanceFromNewest) < 1 }
        let old = try XCTUnwrap(transcript.list.loadedItemView(at: 0))
        let oldY = old.convert(old.bounds, to: chat.view).minY
        transcript.apply(plans + [ChatRowPlan(id: "sent", size: CGSize(width: chat.view.bounds.width, height: 60), items: [])])
        try await until { (transcript.list.loadedItemView(at: 0) as? AgentChatRowView)?.row.plan.id == "sent" }
        let sent = try XCTUnwrap(transcript.list.loadedItemView(at: 0))
        XCTAssertEqual(sent.convert(sent.bounds, to: chat.view).maxY, input.frame.minY - ChatScreenLayout.Metrics.listGap, accuracy: 1)
        XCTAssertEqual(old.convert(old.bounds, to: chat.view).minY, oldY - 60, accuracy: 1,
                       "the previous newest moves only by the appended row's height")
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("transcript did not reach its requested position", file: file, line: line)
    }

    /// A preview keeps the scroll view whatever the setting says: its fade
    /// and its title are measured against that scroll's own offset.
    func testAPreviewKeepsTheScrollViewOnEitherRenderer() async throws {
        let (_, session) = try await self.session()
        let preview = chat(session, previewing: true)
        XCTAssertNil(find(UltraListView.self, in: preview.view), "a preview was given the list")
        XCTAssertNotNil(find(UIScrollView.self, in: preview.view))
        XCTAssertFalse(preview.view.subviews.compactMap { $0 as? HeaderScrimView }.contains { $0.edge == .top })
    }
}
#endif
