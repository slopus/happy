#if canImport(UIKit)
import Foundation
import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct NoRelay: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A Happy Cloud server that can go away (a restart, a drain) while the
/// phone has its network, and whose home can come slowly: two tasks, and
/// Old notes' one chat.
private actor FlakyCloudServer: AgentTransport {
    static let home = #"""
    {"cursor":"c1","profile":{"userId":"u1"},"userSettings":[],"projects":[],"workspaces":[],"bots":[],
     "tasks":[{"id":"ship","name":"Ship the cache","agent":{"id":"ship-agent","workspaceId":"one","status":"idle"}},
       {"id":"old","name":"Old notes","agent":{"id":"old-agent","workspaceId":"two","status":"idle"}}],
     "taskMemberships":[{"taskId":"ship"},{"taskId":"old"}],"surfaces":[]}
    """#
    static let run: JSONValue = .object([
        "id": .string("r1"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
        "messages": .array([
            .object(["id": .string("u1"), "role": .string("user"), "createdAt": .number(1), "metadata": .object([:]),
                     "content": .array([.object(["type": .string("text"), "text": .string("What did we decide?")])])]),
            .object(["id": .string("m1"), "role": .string("agent"), "createdAt": .number(2), "metadata": .object([:]),
                     "content": .array([.object(["type": .string("text"), "text": .string("SQLite, one local file.")])])]),
        ]),
    ])

    private var online = true
    private var holding = false
    private var held: [CheckedContinuation<Void, Never>] = []
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    /// Away, the server answers nothing and its open stream drops.
    func set(online: Bool) {
        self.online = online
        if !online { streams.forEach { $0.finish(throwing: URLError(.networkConnectionLost)) }; streams.removeAll() }
    }

    /// Home's read waits until `release`.
    func hold() { holding = true }
    func release() { holding = false; held.forEach { $0.resume() }; held.removeAll() }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.cannotConnectToHost) }
        let value: JSONValue
        if path == "/v0/bootstrap/desktop" {
            if holding { await withCheckedContinuation { held.append($0) } }
            guard online else { throw URLError(.networkConnectionLost) }
            return .init(status: 200, body: Data(Self.home.utf8))
        } else if path.contains("/agents/old-agent/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([Self.run])])
        } else if path.hasSuffix("/agents/old-agent/bootstrap") {
            value = .object(["agent": .object(["id": .string("old-agent"), "workspaceId": .string("two"), "status": .string("idle")]), "pending": .array([])])
        } else {
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.cannotConnectToHost) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func reset() {}
    func close() {}
}

/// A Happy Cloud server's link in its headers (docs/offline-first.md,
/// "The title while away"): "Updating…" while its home is read,
/// "Connecting…" while it is away and asked again, never offline with a
/// notice as a computer that didn't answer is; home's title and a chat's
/// subtitle say the same. Stills go to the repository's
/// `.context/cloud-link` when that folder's parent exists, and are
/// attached to the result either way, for a run on a phone.
@MainActor
final class HostedCloudLinkTests: XCTestCase {
    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("cloud-link")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        if let folder = Self.evidence { try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png")) }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func until(_ what: String, _ seconds: Double = 6, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    private static func subviews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + subviews(type, in: $0) }
    }

    /// What a chat's header says under its name.
    private func chatStatus(_ chat: UIViewController) -> String? {
        guard let header = chat.navigationItem.titleView else { return nil }
        return Self.subviews(UILabel.self, in: header).first { $0.accessibilityIdentifier == "chat-status" }?.text
    }

    func testACloudServersLinkSaysUpdatingThenConnectingNeverOffline() async throws {
        let server = FlakyCloudServer()
        defer { NetworkPath.shared.force(nil) }
        NetworkPath.shared.force(true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cloud-link-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(),
            agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoRelay(), connector: NoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let method = OAuthMethod(id: "jwt", name: "Happy Cloud", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        let connection = try await controller.agentConnections.addServer(
            try AgentOrigin("https://acme.\(HappyCloud.base)"),
            signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "refresh", clientId: "happy"), userId: "u1"),
            access: OAuthAccess(token: "access", expiresAt: nil), name: "Acme"
        )
        addTeardownBlock { @MainActor in Session.forget(connection.id) }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: connection.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        XCTAssertTrue(session.isCloud)
        let sidebar = try XCTUnwrap(Self.subviews(SidebarList.self, in: home.view).first)

        // The server answered the phone's check; its home comes slowly.
        session.receive(status: .connected)
        await server.hold()
        await session.engine.start()
        try await until("updating…") { home.headerState == .syncing }
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "1-cloud-home-updating")
        let catchingUp = ChatViewController(session: session, agentId: "old-agent", title: "Old notes", spaceId: nil, intro: nil)
        navigation.pushViewController(catchingUp, animated: false)
        try await until("the chat says updating…") { self.chatStatus(catchingUp) == "updating…" }
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "2-cloud-chat-updating")
        navigation.popViewController(animated: false)

        await server.release()
        try await until("live", 10) { session.home.live && home.headerState == .online }
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "3-cloud-home-online")

        // The server goes away while the phone has its network: on its way
        // back, connecting, and home lists no reason for it.
        await server.set(online: false)
        try await until("connecting…", 10) { home.headerState == .connecting }
        // Asked again and again meanwhile, it stays connecting.
        try await Task.sleep(for: .seconds(3))
        XCTAssertEqual(home.headerState, .connecting)
        XCTAssertTrue(session.home.reconnecting)
        XCTAssertNil(session.home.error)
        XCTAssertNil(sidebar.notice, "a server on its way back has no notice")
        capture(window, "4-cloud-home-connecting")
        let away = ChatViewController(session: session, agentId: "old-agent", title: "Old notes", spaceId: nil, intro: nil)
        navigation.pushViewController(away, animated: false)
        try await until("the chat says connecting…") { self.chatStatus(away) == "connecting…" }
        try await until("Old notes' answer") { away.plans.contains { $0.accessibilityLabel?.contains("SQLite, one local file.") == true } }
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "5-cloud-chat-connecting")
        navigation.popViewController(animated: false)

        // Back: live again.
        await server.set(online: true)
        try await until("live again", 15) { session.home.live && home.headerState == .online }
        XCTAssertFalse(session.home.reconnecting)
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "6-cloud-home-back")
        await session.engine.stop()
    }
}
#endif
