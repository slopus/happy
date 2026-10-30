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
///
/// These read what was let go of — the follow, the observers, the warmed
/// conversations, the monitor's handler — rather than the flag that says
/// it happened.
@MainActor
final class HostedSessionLifetimeTests: XCTestCase {
    /// Holds the last reference so it can be let go of away from the main
    /// thread, which a `@MainActor` class cannot be handed across directly.
    private final class Holder: @unchecked Sendable {
        private var value: AnyObject?
        init(_ value: AnyObject) { self.value = value }
        /// Releases, and says whether that happened off the main thread.
        func release() -> Bool {
            value = nil
            return !Thread.isMainThread
        }
    }

    private func makeAccount() -> AccountController {
        AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "lifetime-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in LifetimeNoComputer() })
    }

    private func credentials(device: String) throws -> AgentConnectionCredentials {
        try JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"lifetime-test","port":1,"deviceID":"\#(device)","deviceToken":"test"}"#.utf8))
    }

    /// Everything a live session holds.
    private func assertLive(_ session: Session, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNotNil(session.following, "\(message): the snapshots are followed", file: file, line: line)
        XCTAssertFalse(session.warm.stopped, message, file: file, line: line)
        XCTAssertTrue(session.warm.listensToPath, "\(message): the path monitor can call in", file: file, line: line)
        XCTAssertGreaterThan(session.warm.watchedCount, 0, "\(message): notifications are watched for", file: file, line: line)
    }

    /// And nothing of it after it is stopped.
    private func assertLetGo(_ session: Session, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(session.following, "\(message): the follow is let go of", file: file, line: line)
        XCTAssertEqual(session.watchedCount, 0, "\(message): the session watches for nothing", file: file, line: line)
        XCTAssertEqual(session.warm.watchedCount, 0, "\(message): the notifications are removed", file: file, line: line)
        XCTAssertEqual(session.warm.warmedCount, 0, "\(message): no conversation is still held", file: file, line: line)
        XCTAssertFalse(session.warm.listensToPath, "\(message): the path monitor cannot call in", file: file, line: line)
        XCTAssertTrue(session.warm.stopped, message, file: file, line: line)
    }

    /// Disconnecting a computer lets go of what its session held, and the
    /// next session for the same computer is a new one.
    func testForgettingAComputerLetsGoOfWhatItsSessionHeld() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Forget test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        assertLive(session, "a session for a watched computer")
        // The same computer gives the same session while it is watched.
        XCTAssertTrue(Session.session(for: computer.id, context: context) === session)

        Session.forget(computer.id)
        assertLetGo(session, "a forgotten computer's session")

        let second = try XCTUnwrap(Session.session(for: computer.id, context: context))
        XCTAssertFalse(second === session, "a forgotten session is not handed out again")
        assertLive(second, "the session made after forgetting")
        Session.forget(computer.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// The replacement seam: re-pairing the same device keeps its ID but
    /// drops its engine (`AgentConnections.add`), so the next
    /// `Session.session(for:)` finds a cached session on a dead engine.
    /// That old session used to be dropped from the dictionary with its
    /// monitor and its observers still running.
    func testASessionReplacedByANewEngineIsLetGoOfRatherThanDropped() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let device = UUID().uuidString
        let computer = try await account.agentConnections.add(credentials(device: device), name: "Replace test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let first = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let engine = first.engine
        assertLive(first, "the session before its engine is replaced")

        // The same device again: the same ID, a new engine behind it.
        let again = try await account.agentConnections.add(credentials(device: device), name: "Replace test")
        XCTAssertEqual(again.id, computer.id, "re-pairing the same device keeps its ID")
        let second = try XCTUnwrap(Session.session(for: computer.id, context: context))
        try XCTSkipIf(second === first, "this build reused the engine, so there is no replacement here to test")

        XCTAssertFalse(second.engine === engine, "the replacement is on a new engine")
        assertLetGo(first, "the session whose engine was replaced")
        assertLive(second, "the session on the new engine")
        Session.forget(computer.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// Stopping twice is not an error, and a screen still holding the
    /// session goes on answering, just without hearing anything.
    func testStoppingASessionTwiceDoesNothingTheSecondTime() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Twice test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))

        session.stop()
        assertLetGo(session, "a stopped session")
        session.stop()
        session.warm.stop()
        assertLetGo(session, "a session stopped three times over")
        // Still answerable, just not listening.
        _ = session.snapshot
        let watch = session.watch { _ in }
        watch.invalidate()

        Session.forget(computer.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// With no deinit left, the last reference going is an ordinary release
    /// wherever it happens — and the object really is freed, which is the
    /// half a flag cannot say. On 26.3 this release is the case that used
    /// to abort.
    func testAForgottenSessionIsFreedWhenLetGoOfOffTheMainThread() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Release test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        weak var freed: Session?
        let holder: Holder
        do {
            let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
            freed = session
            // Out of the dictionary, so the holder has the last reference.
            Session.forget(computer.id)
            holder = Holder(session)
        }
        XCTAssertNotNil(freed, "the holder still has it")
        let releasedOffMain = await Task.detached { holder.release() }.value
        XCTAssertTrue(releasedOffMain, "the last release ran off the main thread")
        // That release was on another thread; give the runtime the turn it
        // needs to finish before reading.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(freed, "a stopped session is freed once nothing holds it")
        try await account.agentConnections.remove(computer.id)
    }
}
#endif
