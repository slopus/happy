#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

private struct ReachNoComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.notConnectedToInternet)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.notConnectedToInternet)
    }
    func reset() async {}
    func close() async {}
}

/// A conversation held for a moment and let go of, never opened: what a
/// voice call's read or send does to one it doesn't follow
/// (`SessionCallTargets.borrowing`). Dropped at once, the next read or send
/// started it over, unread, and a send found nothing read to judge, so a
/// conversation never opened on this phone couldn't take a message by
/// voice. Reached for first, as a finger on its row reaches, it stays kept
/// and the next hold finds the same one.
@MainActor
final class HostedWarmChatsReachTests: XCTestCase {
    func testAConversationReachedForIsKeptAfterItsHoldIsLetGo() async throws {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "reach-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in ReachNoComputer() })
        await account.agentConnections.setForeground(false)
        let credentials = try JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"reach-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8))
        let computer = try await account.agentConnections.add(credentials, name: "Reach test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: AppContext(account: account, variant: .preview, version: "test")))
        defer { Session.forget(computer.id) }
        let warm = session.warm
        let before = warm.warmedCount

        let plain = warm.hold("held-only")
        warm.release(plain.chat, token: plain.token, opened: false)
        XCTAssertEqual(warm.warmedCount, before, "held and let go, never reached for: not kept")

        warm.intent("reached")
        let first = warm.hold("reached")
        warm.release(first.chat, token: first.token, opened: false)
        XCTAssertEqual(warm.warmedCount, before + 1, "reached for, then held and let go: kept")
        let again = warm.hold("reached")
        XCTAssertTrue(again.chat === first.chat, "the next hold finds the same conversation, not a new one")
        warm.release(again.chat, token: again.token, opened: false)
        try await account.agentConnections.remove(computer.id)
    }
}
#endif
