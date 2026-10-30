#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

private struct LifetimeNoComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.notConnectedToInternet)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.notConnectedToInternet)
    }
    func reset() async {}
    func close() async {}
}

/// A session stops when the computer stops being watched, not whenever the
/// last screen holding it is freed. `WarmChats` has no deinit to fall back
/// on: it keeps a path monitor and notification observers, and on the iOS
/// 26.3 runtime an `isolated deinit` aborts outright, so the teardown is
/// said out loud on the paths that own it.
@MainActor
final class HostedSessionLifetimeTests: XCTestCase {
    private func makeAccount() -> AccountController {
        AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "lifetime-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in LifetimeNoComputer() })
    }

    private func makeComputer(_ account: AccountController, name: String) async throws -> AgentConnection {
        try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"lifetime-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: name)
    }

    /// Disconnecting a computer stops what its session set going, and the
    /// next session for the same computer is a new one.
    func testForgettingAComputerStopsWhatItsSessionStarted() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await makeComputer(account, name: "Forget test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        XCTAssertFalse(session.warm.stopped)
        // The same computer gives the same session while it is watched.
        XCTAssertTrue(Session.session(for: computer.id, context: context) === session)

        Session.forget(computer.id)
        XCTAssertTrue(session.warm.stopped, "the chats read ahead, the path monitor and the observers are let go of")

        let second = try XCTUnwrap(Session.session(for: computer.id, context: context))
        XCTAssertFalse(second === session, "a forgotten session is not handed out again")
        XCTAssertFalse(second.warm.stopped)
        Session.forget(computer.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// Stopping twice is not an error, and a screen still holding the
    /// session simply stops hearing: nothing it calls aborts.
    func testStoppingASessionTwiceDoesNothingTheSecondTime() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await makeComputer(account, name: "Twice test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))

        session.stop()
        XCTAssertTrue(session.warm.stopped)
        session.stop()
        session.warm.stop()
        XCTAssertTrue(session.warm.stopped)
        // Still answerable, just not listening.
        _ = session.snapshot
        let watch = session.watch { _ in }
        watch.invalidate()

        Session.forget(computer.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// The last reference going is no longer what tears a session down, so
    /// letting one go after it is stopped is an ordinary release — which on
    /// 26.3 is the case that used to abort.
    func testLettingAStoppedSessionGoDoesNotAbort() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await makeComputer(account, name: "Release test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        weak var weakSession: Session?
        do {
            let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
            weakSession = session
            Session.forget(computer.id)
        }
        // Nothing of ours holds it now; whether the runtime has freed it
        // yet is its own business, so this only asserts it is reachable or
        // gone, never that freeing it went wrong.
        XCTAssertTrue(weakSession == nil || weakSession?.warm.stopped == true)
        try await account.agentConnections.remove(computer.id)
    }
}
#endif
