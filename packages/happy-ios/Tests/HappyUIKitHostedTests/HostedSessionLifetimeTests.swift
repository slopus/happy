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

    // MARK: Signing out from Manage Accounts

    /// The switcher's Manage Accounts screen, in a window so it can present
    /// its confirmation.
    private func manageAccounts(_ context: AppContext) async throws -> (CombinedAccountsViewController, UIWindow) {
        let screen = CombinedAccountsViewController(context: context)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: screen))
        window.layoutIfNeeded()
        return (screen, window)
    }

    private func summary(_ id: String, in account: AccountController) throws -> AccountSummary {
        try XCTUnwrap(account.accounts.first { $0.id == id }, "\(id) is not listed")
    }

    /// Disconnecting a computer from Manage Accounts lets go of its session,
    /// which it never used to: the session stayed in the dictionary with its
    /// monitor and observers running, out of reach.
    func testDisconnectingAComputerFromManageAccountsLetsGoOfItsSession() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Manage test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        assertLive(session, "before the disconnect")
        let (screen, window) = try await manageAccounts(context)
        defer { window.isHidden = true }

        await screen.signOut(try summary(computer.id, in: account))
        XCTAssertFalse(account.agentConnections.accounts.contains { $0.id == computer.id }, "the computer is gone")
        assertLetGo(session, "a computer disconnected from Manage Accounts")
        XCTAssertNil(Session.session(for: computer.id, context: context), "and nothing makes it a new one")
    }

    /// Cancelling the confirmation removes nothing, so nothing is let go of.
    func testCancellingTheDisconnectLeavesTheSessionRunning() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Cancel test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let (screen, window) = try await manageAccounts(context)
        defer { window.isHidden = true }

        screen.remove(try summary(computer.id, in: account))
        let asked = try await until { screen.presentedViewController is UIAlertController }
        XCTAssertTrue(asked, "no confirmation")
        let alert = try XCTUnwrap(screen.presentedViewController as? UIAlertController)
        // While it asks, nothing has happened yet.
        assertLive(session, "while the confirmation is up")
        try cancel(alert)
        let answered = try await until { screen.presentedViewController == nil }
        XCTAssertTrue(answered, "the confirmation stayed")
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertTrue(account.agentConnections.accounts.contains { $0.id == computer.id }, "the computer is still paired")
        assertLive(session, "after cancelling")
        XCTAssertTrue(Session.session(for: computer.id, context: context) === session, "and it is the same session")
        Session.forget(computer.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// Two computers: disconnecting one leaves the other's session exactly
    /// as it was — the same object, still live — not merely some session.
    func testDisconnectingOneComputerLeavesTheOthersSessionAlone() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let gone = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Going")
        let kept = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Staying")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let goneSession = try XCTUnwrap(Session.session(for: gone.id, context: context))
        let keptSession = try XCTUnwrap(Session.session(for: kept.id, context: context))
        let (screen, window) = try await manageAccounts(context)
        defer { window.isHidden = true }

        await screen.signOut(try summary(gone.id, in: account))
        assertLetGo(goneSession, "the computer that was disconnected")
        XCTAssertTrue(Session.session(for: kept.id, context: context) === keptSession, "the other computer's session is the same object")
        assertLive(keptSession, "the other computer's session")
        Session.forget(kept.id)
        try await account.agentConnections.remove(kept.id)
    }

    /// A removal that fails removes nothing, so nothing is let go of. The
    /// account layer refuses a second operation while one is running, which
    /// is a real failure to reach without faking one.
    func testADisconnectThatFailsLeavesTheSessionRunning() async throws {
        let account = makeAccount()
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Fail test")
        let other = try await account.agentConnections.add(credentials(device: UUID().uuidString), name: "Busy test")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let (screen, window) = try await manageAccounts(context)
        defer { window.isHidden = true }

        // Another removal under way: it holds the account layer until its
        // first await, so the next one is refused.
        let running = Task { try await account.signOut(accountID: other.id) }
        await Task.yield()
        await screen.signOut(try summary(computer.id, in: account))
        _ = try? await running.value

        XCTAssertTrue(screen.presentedViewController is UIAlertController, "the failure is said, not swallowed")
        screen.presentedViewController?.dismiss(animated: false)
        XCTAssertTrue(account.agentConnections.accounts.contains { $0.id == computer.id }, "the computer is still paired")
        assertLive(session, "after a removal that failed")
        Session.forget(computer.id)
        Session.forget(other.id)
        try await account.agentConnections.remove(computer.id)
    }

    /// Resolves the alert as its Cancel button would. `UIAlertAction` keeps
    /// its handler private, so a test reaches it by key; a test only.
    private func cancel(_ alert: UIAlertController) throws {
        let action = try XCTUnwrap(alert.actions.first { $0.style == .cancel }, "no Cancel")
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        let handler = try XCTUnwrap(action.value(forKey: "handler") as AnyObject?, "Cancel has no handler")
        alert.dismiss(animated: false) {
            unsafeBitCast(handler, to: Handler.self)(action)
        }
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { return false }
            try await Task.sleep(for: .milliseconds(20))
        }
        return true
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
