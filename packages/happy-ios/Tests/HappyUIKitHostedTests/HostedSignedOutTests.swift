#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
import UIKit
import XCTest
@testable import HappyUI

private struct Offline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct Unreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// A Happy Cloud server whose session ended: home shows only the way back
/// in, nothing of the server, and nothing of it is kept.
@MainActor
final class HostedSignedOutTests: XCTestCase {
    func testAnEndedSessionLeavesOnlyTheSignInButton() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: Offline(), connector: NoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let method = HappyCloud.method(server: HappyCloud.server(named: "signed-out-test"))
        let record = ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "r1", clientId: "happy"), userId: "u1")
        let server = try await controller.agentConnections.addServer(try AgentOrigin(HappyCloud.server(named: "signed-out-test")), signIn: record,
                                                                     access: OAuthAccess(token: "a1", expiresAt: nil), name: "signed-out-test")
        addTeardownBlock { @MainActor in
            Session.forget(server.id)
            try? await controller.agentConnections.remove(server.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: server.id)
        let navigation = UINavigationController(rootViewController: home)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        XCTAssertFalse(home.showsSignedOut)
        XCTAssertNotNil(Session.session(for: server.id, context: context))

        let credential = try XCTUnwrap(controller.agentConnections.credential(for: server.id))
        await controller.agentConnections.authorization(credential, for: server.id).signInRequired()
        let deadline = Date().addingTimeInterval(5)
        while !home.showsSignedOut, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(home.showsSignedOut, "home still shows the server")
        window.layoutIfNeeded()

        let signedOut = try XCTUnwrap(home.view.subviews.compactMap { $0 as? ServerSignedOutView }.first)
        XCTAssertEqual(signedOut.frame, home.view.bounds, "the sign-in screen doesn't cover home")
        XCTAssertEqual(signedOut.button.configuration?.title, "Sign In")
        XCTAssertTrue(home.toolbarItems?.isEmpty ?? true, "search, compose or the microphone still show")
        XCTAssertNil(home.navigationItem.searchController)
        XCTAssertTrue(home.children.allSatisfy { $0.view.isHidden }, "the list still shows under it")
        XCTAssertNil(Session.session(for: server.id, context: context), "the server is still read")
        XCTAssertNil(controller.agentConnections.credential(for: server.id)?.signIn?.grant.refreshToken)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = "signed-out"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
#endif
