#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A computer with a task the person may archive, one they may only
/// leave, a bot, and the Chief of Staff; archival answers by version.
private actor PutAwayDaemon: AgentTransport {
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":"alex","name":"Alex"},"userSettings":[],
     "projects":[],"workspaces":[],
     "bots":[
       {"id":"cos","name":"Chief of Staff","status":"active","systemKey":"chief_of_staff","agent":{"id":"cos-agent","workspaceId":"c","status":"idle"}},
       {"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}],
     "tasks":[
       {"id":"mine","name":"Ship the release notes","ownerUserId":"alex","canArchive":true,"agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}},
       {"id":"adas","name":"Fix the login redirect","ownerUserId":"ada","canArchive":false,"agent":{"id":"adas-agent","workspaceId":"w2","status":"idle"}}],
     "taskMemberships":[{"taskId":"mine"},{"taskId":"adas"}],
     "surfaces":[]}
    """#

    private(set) var requested: [String] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requested.append("\(method) \(path)")
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, headers: ["content-type": "application/json"], body: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"): return ok(Self.fixture)
        case ("GET", "/v0/tasks/mine"): return ok(#"{"task":{"id":"mine","version":"7"}}"#)
        case ("POST", "/v0/tasks/mine/archive"): return ok(#"{"task":{"id":"mine","status":"archived","version":"8"}}"#)
        default: return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }

    func reset() async {}
    func close() async { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

private struct PutAwayOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct PutAwayNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A held task or bot, and its profile, offer to put it away as desktop
/// does: a task is left, and archived when the computer says the person
/// may; a bot is archived; the Chief of Staff offers nothing. Archiving
/// takes the row off home at once and asks the computer.
@MainActor
final class HostedPutAwayTests: XCTestCase {
    private func session(_ daemon: PutAwayDaemon) async throws -> Session {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: PutAwayOffline(), connector: PutAwayNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"put-away","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
            withExtendedLifetime(controller) {}
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        await session.engine.start()
        return session
    }

    private func rows(_ session: Session, until test: @escaping ([Row]) -> Bool) async throws -> [Row] {
        let snapshots = await session.engine.snapshots()
        let found = Task { () -> [Row]? in
            for await snapshot in snapshots where test(snapshot.rows) { return snapshot.rows }
            return nil
        }
        let timeout = Task { try await Task.sleep(for: .seconds(5)); found.cancel() }
        defer { timeout.cancel() }
        let rows = await found.value
        return try XCTUnwrap(rows, "home's rows never settled")
    }

    func testTasksAndBotsArePutAwayAndTheChiefOfStaffIsNot() async throws {
        let daemon = PutAwayDaemon()
        let session = try await session(daemon)
        let rows = try await rows(session) { $0.contains { $0.id == "task:mine" } }
        func acts(_ id: String) -> [String] {
            rows.first { $0.id == id }.map { PuttingAway.acts($0, session: session).map(\.id) } ?? ["missing \(id)"]
        }
        XCTAssertEqual(acts("task:mine"), ["leave-task", "archive-task"])
        XCTAssertEqual(acts("task:adas"), ["leave-task"])
        XCTAssertEqual(acts("bot:research"), ["archive-bot"])
        XCTAssertEqual(acts("bot:cos"), [])

        // The task's profile offers the same, the Chief of Staff's nothing.
        func profile(_ agentId: String) async throws -> SessionDetailViewController {
            let detail = SessionDetailViewController(session: session, agentId: agentId, title: "", spaceId: nil)
            let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: detail))
            addTeardownBlock { @MainActor in window.isHidden = true }
            window.layoutIfNeeded()
            return detail
        }
        func card(_ detail: SessionDetailViewController) -> UIView? {
            detail.view.layoutIfNeeded()
            return Self.find(in: detail.view) { $0.accessibilityIdentifier == "profile-section:put-away" }
        }
        let mine = try await profile("mine-agent")
        let deadline = Date().addingTimeInterval(5)
        while card(mine) == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNotNil(card(mine), "the task's profile offers to put it away")
        let cos = try await profile("cos-agent")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(card(cos), "the Chief of Staff's profile offers nothing")

        // Archived: gone from home at once, and the computer is asked.
        let archive = try XCTUnwrap(rows.first { $0.id == "task:mine" }.flatMap { PuttingAway.acts($0, session: session).last })
        archive.run()
        _ = try await self.rows(session) { !$0.contains { $0.id == "task:mine" } }
        let asked = Date().addingTimeInterval(5)
        while !(await daemon.requested.contains("POST /v0/tasks/mine/archive")), Date() < asked { try await Task.sleep(for: .milliseconds(20)) }
        let requested = await daemon.requested
        XCTAssertTrue(requested.contains("POST /v0/tasks/mine/archive"), "\(requested)")
    }

    private static func find(in view: UIView, where test: (UIView) -> Bool) -> UIView? {
        if test(view) { return view }
        for child in view.subviews { if let found = find(in: child, where: test) { return found } }
        return nil
    }
}
#endif
