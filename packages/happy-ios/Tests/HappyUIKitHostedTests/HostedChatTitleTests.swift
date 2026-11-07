#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct TitleNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct TitleNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct TitleUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// An open conversation is named as home names its row, as that changes:
/// a bot the agent renames is renamed in the open chat's bar at once, on a
/// computer whose home is its bootstrap (Happy Cloud) and not the spaces
/// document. It kept the old name until it was opened again.
@MainActor
final class HostedChatTitleTests: XCTestCase {
    private static func desktop(_ name: String) -> String {
        #"""
        {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],
         "bots":[{"id":"bot-cos","name":"\#(name)","status":"active","agent":{"id":"agent-cos","workspaceId":"w","status":"idle"}}],
         "surfaces":[]}
        """#
    }

    private func home(_ name: String) throws -> HomeSnapshot {
        var home = HomeSnapshot()
        home.loaded = true
        home.allRows = SidebarRows.make(try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.desktop(name).utf8)), settings: [:])
        home.rows = Rows.visible(home.allRows)
        return home
    }

    func testARenamedBotIsRenamedInItsOpenChat() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in TitleUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: TitleNoNetwork(), connector: TitleNoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"title","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        var first = await session.engine.snapshots().makeAsyncIterator()
        _ = await first.next()
        try await Task.sleep(for: .milliseconds(100))
        let before = try home("Chief of Staff")
        session.receive(home: before)
        let row = try XCTUnwrap(before.allRows.first { $0.agentId == "agent-cos" })

        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let navigation = UINavigationController(rootViewController: UIViewController())
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            original?.makeKey()
        }
        let chat = ChatViewController(session: session, agentId: "agent-cos", title: row.label, spaceId: row.spaceId, intro: nil)
        navigation.pushViewController(chat, animated: false)
        window.layoutIfNeeded()
        XCTAssertEqual(chat.title, "Chief of Staff")

        session.receive(home: try home("Morgan"))
        let end = ContinuousClock.now + .seconds(5)
        while chat.title != "Morgan", ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(chat.title, "Morgan", "the open chat kept the old name")
    }
}
#endif
