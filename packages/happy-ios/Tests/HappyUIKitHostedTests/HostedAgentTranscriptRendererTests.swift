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

/// The agents' chat transcript on UltraList, and that the UI tests can find
/// it.
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
        let chat = ChatViewController(session: session, agentId: "renderer", title: "Chat", spaceId: nil, intro: nil, previewing: previewing)
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

    /// The transcript is the list, and it carries the identifier the UI
    /// tests look for.
    func testTheChatOpensOnUltraListAndKeepsTheTranscriptIdentifier() async throws {
        let (_, session) = try await self.session()
        let chat = self.chat(session)
        let list = try XCTUnwrap(find(UltraListView.self, in: chat.view), "no UltraList in the chat")
        XCTAssertEqual(list.accessibilityIdentifier, "transcript")
        XCTAssertNotNil(chat.view.subviews.compactMap { $0 as? HeaderScrimView }.first { $0.edge == .top })
        XCTAssertNil(find(UIScrollView.self, in: chat.view)?.accessibilityIdentifier,
                     "a scroll view also claimed to be the transcript")
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
        XCTAssertEqual(transcript.list.viewportInsets.bottom, Double(chat.view.bounds.height - input.frame.minY + ChatScreenLayout.Metrics.listGap), accuracy: 1)
        XCTAssertEqual(transcript.list.viewportInsets.top, Double(chat.view.safeAreaInsets.top), accuracy: 1)
        transcript.apply([ChatRowPlan(id: "short", size: CGSize(width: chat.view.bounds.width, height: 60), items: [])])
        try await until { transcript.list.newestLoadedView != nil }
        let short = try XCTUnwrap(transcript.list.newestLoadedView)
        XCTAssertEqual(short.convert(short.bounds, to: chat.view).maxY, input.frame.minY - ChatScreenLayout.Metrics.listGap, accuracy: 1,
                       "a short conversation must rest above the composer")
        let plans = (0..<40).map { ChatRowPlan(id: "row-\($0)", size: CGSize(width: chat.view.bounds.width, height: 80), items: []) }
        transcript.apply(plans)
        try await until { transcript.list.newestLoadedView != nil }
        XCTAssertTrue(chat.sendFlies)
        XCTAssertEqual(scrim.presence, 1)

        transcript.list.scrollToTop(animated: false)
        try await until { transcript.distanceFromOldest < 1 }
        XCTAssertEqual(scrim.presence, 0)

        transcript.list.scrollTo(.init(index: 15), transition: .none)
        try await until { transcript.distanceFromNewest > 200 }
        XCTAssertFalse(chat.sendFlies, "a send in history read the unused scroll view's offset")

        transcript.scroll(toDistanceFromNewest: 50)
        try await until { (30...80).contains(transcript.distanceFromNewest) }
        XCTAssertFalse(transcript.followsNewest)
        XCTAssertFalse(chat.sendFlies, "past Telegram's 20pt a send scrolls rather than flies")
        transcript.scrollToNewest(animated: false)
        try await until { abs(transcript.distanceFromNewest) < 1 }
        XCTAssertTrue(chat.sendFlies)
    }

    func testAnAppendIsFollowedByTwoLinesAtMost() async throws {
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
        try await until { transcript.list.newestLoadedView != nil }
        transcript.scrollToNewest(animated: false)
        try await until { abs(transcript.distanceFromNewest) < 1 }
        let old = try XCTUnwrap(transcript.list.newestLoadedView)
        let oldY = old.convert(old.bounds, to: chat.view).minY
        transcript.apply(plans + [ChatRowPlan(id: "sent", size: CGSize(width: chat.view.bounds.width, height: 60), items: [])])
        try await until { (transcript.list.newestLoadedView as? AgentChatRowView)?.row.plan.id == "sent" }
        let sent = try XCTUnwrap(transcript.list.newestLoadedView)
        // A row arriving at the foot is followed as growth is, by two
        // lines at most; the rest of it waits below the fold.
        let budget = ChatFollow.budget(body: ChatTextStyles.text, scale: chat.traitCollection.textEnvironment?.scale ?? .standard)
        XCTAssertEqual(sent.convert(sent.bounds, to: chat.view).maxY, input.frame.minY - ChatScreenLayout.Metrics.listGap + 60 - budget, accuracy: 1)
        XCTAssertEqual(old.convert(old.bounds, to: chat.view).minY, oldY - budget, accuracy: 1,
                       "the previous newest moves only by the budget")
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("transcript did not reach its requested position", file: file, line: line)
    }

    /// A preview draws on the same list, untouchable and without the
    /// header scrim.
    func testAPreviewDrawsOnTheUntouchableList() async throws {
        let (_, session) = try await self.session()
        let preview = chat(session, previewing: true)
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: preview.view), "a preview has no list")
        XCTAssertFalse(transcript.isUserInteractionEnabled)
        XCTAssertTrue(transcript.showsNewestFromItsStart)
        XCTAssertNil(find(UIScrollView.self, in: preview.view)?.accessibilityIdentifier)
        XCTAssertFalse(preview.view.subviews.compactMap { $0 as? HeaderScrimView }.contains { $0.edge == .top })
    }

    /// Showing the newest row from its start, as a preview does: a row
    /// taller than the room puts its start at the top, and the room's foot
    /// partway down it.
    func testTheNewestRowCanShowFromItsStart() async throws {
        let transcript = AgentChatUltraList(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        transcript.showsNewestFromItsStart = true
        let host = UIViewController()
        host.view.addSubview(transcript)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: host)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        transcript.setViewport(frame: CGRect(origin: .zero, size: transcript.bounds.size), insets: UIEdgeInsets(top: 50, left: 0, bottom: 100, right: 0))
        let tall = transcript.viewportHeight + 300
        transcript.apply([ChatRowPlan(id: "older", size: CGSize(width: 393, height: 80), items: []),
                          ChatRowPlan(id: "tall", size: CGSize(width: 393, height: tall), items: [])])
        try await until { transcript.list.newestLoadedView != nil && abs(transcript.distanceFromNewest - 300) < 1 }
        XCTAssertEqual(transcript.distanceFromOldest, 80, accuracy: 1)
        let row = try XCTUnwrap(transcript.list.newestLoadedView)
        XCTAssertEqual(row.convert(row.bounds, to: transcript).minY, 50, accuracy: 1, "the newest row's start sits at the top inset")

        // A shorter newest row rests on the composer as ever.
        transcript.apply([ChatRowPlan(id: "older", size: CGSize(width: 393, height: 80), items: []),
                          ChatRowPlan(id: "short", size: CGSize(width: 393, height: 120), items: [])])
        try await until { abs(transcript.distanceFromNewest) < 1 }
    }
}
#endif
