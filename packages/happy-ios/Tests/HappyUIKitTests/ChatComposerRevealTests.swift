#if canImport(UIKit)
import Foundation
import GRDB
@testable import HappyCore
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct OfflineTransport: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

/// A store whose read never answers.
private struct StalledStorage: ComposerStorage {
    func composerValue(sessionId: String) async throws -> ComposerStoreValue {
        try await Task.sleep(for: .seconds(3600))
        throw CancellationError()
    }

    func saveDraft(sessionId: String, text: String) async throws {}

    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        AsyncThrowingStream { _ in }
    }
}

/// The chat as far as the reveal goes: it passes the composer's restore on.
@MainActor
private final class Screen: ChatComposerDelegate {
    var reveal: ChatComposerReveal?
    var restores: [Int] = []
    var sends: [String] = []

    func composerDidInvalidateHeight(_ composer: any ChatComposerView) {}
    func composerDidChangeFocus(_ composer: any ChatComposerView) {}
    func composer(_ composer: any ChatComposerView, didSend localId: String) { sends.append(localId) }
    func composerDidRestore(_ composer: any ChatComposerView, generation: Int) {
        restores.append(generation)
        reveal?.restored(generation: generation)
    }
}

/// The chat keeps its composer hidden until its draft is restored, catches
/// the taps meant for it meanwhile without sending, and shows it at once,
/// unanimated, in the frame it is restored in (CM3).
@MainActor
final class ChatComposerRevealTests: XCTestCase {
    private let width: CGFloat = 393

    private func session(_ id: String) -> SessionRecord {
        SessionRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(["flavor": .string("claude")]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true
        )
    }

    private func account(_ store: LocalStore, drafts: [String: String] = [:]) throws -> AccountSession {
        try store.upsertSessions(["s", "t"].map(session))
        for (id, text) in drafts {
            try store.saveDraft(sessionId: id, text: text, at: 1)
        }
        return try AccountSession(
            credentials: Credentials(token: "t", secret: Data(repeating: 1, count: 32)),
            store: store,
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: OfflineTransport())
        )
    }

    /// A composer whose draft is never read: only a focus, a send or the
    /// deadline restores it.
    private func stalledComposer(_ account: AccountSession, timeout: Duration = .seconds(3600)) -> SessionComposerView {
        SessionComposerView(
            environment: ChatComposerEnvironment(
                sessionId: "s", account: account, sender: account.sender, controls: account.actions, draftStorage: StalledStorage()
            ),
            restoreTimeout: timeout
        )
    }

    /// The dock as the chat builds it: the composer, then the catcher over it.
    private func dock(_ composer: SessionComposerView, _ reveal: ChatComposerReveal) -> ChatDockView {
        let dock = ChatDockView(frame: CGRect(x: 0, y: 0, width: width, height: 400))
        dock.addSubview(composer)
        dock.addSubview(reveal.catcher)
        let frame = CGRect(x: 0, y: 200, width: width, height: composer.composerHeight(fitting: width))
        reveal.heightRead()
        composer.setLayoutFrame(frame)
        reveal.layout(composerFrame: frame)
        dock.layoutIfNeeded()
        return dock
    }

    private func card(_ composer: SessionComposerView) throws -> AgentInputCardView {
        try XCTUnwrap(composer.subviews.compactMap { $0 as? AgentInputCardView }.first)
    }

    /// Up to 10 seconds: a first run on a cold simulator is slow.
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<2000 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testOnlyTheComposerIsHiddenAndTheCatcherTakesItsTouches() throws {
        let composer = stalledComposer(try account(LocalStore(writer: DatabaseQueue())))
        let reveal = ChatComposerReveal(composer: composer)
        let dock = dock(composer, reveal)
        XCTAssertEqual(composer.alpha, 0)
        XCTAssertEqual(reveal.catcher.alpha, 1, "a hidden view takes no touches; the catcher does")
        XCTAssertFalse(reveal.isRevealed)
        XCTAssertTrue(dock.hitTest(CGPoint(x: width / 2, y: composer.frame.midY), with: nil) === reveal.catcher)
        // Send's corner too.
        XCTAssertTrue(dock.hitTest(CGPoint(x: composer.frame.maxX - 20, y: composer.frame.maxY - 20), with: nil) === reveal.catcher)
        // Above the composer is not the catcher's.
        XCTAssertFalse(dock.hitTest(CGPoint(x: width / 2, y: 100), with: nil) === reveal.catcher)
    }

    func testTheListBehindTakesItsTouchesWhileTheComposerIsHidden() throws {
        let composer = stalledComposer(try account(LocalStore(writer: DatabaseQueue())))
        let reveal = ChatComposerReveal(composer: composer)
        // The chat: the list under the dock, as the screen stacks them.
        let screen = UIView(frame: CGRect(x: 0, y: 0, width: width, height: 852))
        let list = UIScrollView(frame: screen.bounds)
        list.contentSize = CGSize(width: width, height: 2000)
        screen.addSubview(list)
        let dock = dock(composer, reveal)
        dock.frame.origin.y = 852 - dock.bounds.height
        screen.addSubview(dock)
        XCTAssertEqual(composer.alpha, 0)
        XCTAssertTrue(screen.hitTest(CGPoint(x: width / 2, y: 200), with: nil) === list)
        XCTAssertTrue(list.isScrollEnabled && list.isUserInteractionEnabled && list.alpha == 1)
        let overComposer = dock.convert(CGPoint(x: width / 2, y: composer.frame.midY), to: screen)
        XCTAssertTrue(screen.hitTest(overComposer, with: nil) === reveal.catcher)
    }

    func testATapOnTheHiddenComposerFocusesItAndSendsNothing() async throws {
        let store = try LocalStore(writer: DatabaseQueue())
        let screen = Screen()
        let composer = stalledComposer(try account(store))
        composer.composerDelegate = screen
        let reveal = ChatComposerReveal(composer: composer)
        screen.reveal = reveal
        let dock = dock(composer, reveal)
        try card(composer).setText("not to be sent", selection: NSRange(location: 14, length: 0))

        // Where Send is drawn.
        let point = CGPoint(x: composer.frame.maxX - 20, y: composer.frame.maxY - 20)
        let hit = try XCTUnwrap(dock.hitTest(point, with: nil) as? UIControl)
        XCTAssertTrue(hit === reveal.catcher)
        hit.sendActions(for: .touchUpInside)

        XCTAssertTrue(composer.isRestored, "focus restores it")
        XCTAssertTrue(reveal.isRevealed)
        XCTAssertEqual(composer.alpha, 1)
        XCTAssertNil(reveal.catcher.superview, "the catcher is gone")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(screen.sends, [])
        XCTAssertEqual(try card(composer).text, "not to be sent")
        let outbox = try await Task.detached { try store.pendingOutbox() }.value
        XCTAssertTrue(outbox.isEmpty, "nothing reached the outbox")
    }

    func testTheDeadlineShowsIt() async throws {
        let screen = Screen()
        let composer = stalledComposer(try account(LocalStore(writer: DatabaseQueue())), timeout: .milliseconds(50))
        composer.composerDelegate = screen
        let reveal = ChatComposerReveal(composer: composer)
        screen.reveal = reveal
        _ = dock(composer, reveal)
        XCTAssertFalse(reveal.isRevealed)
        try await until { reveal.isRevealed }
        XCTAssertEqual(screen.restores, [0])
        XCTAssertEqual(composer.alpha, 1)
        XCTAssertNil(reveal.catcher.superview)
    }

    func testAnEarlierChatsReportDoesntShowIt() throws {
        let account = try account(LocalStore(writer: DatabaseQueue()))
        let screen = Screen()
        let composer = stalledComposer(account)
        composer.composerDelegate = screen
        let reveal = ChatComposerReveal(composer: composer)
        screen.reveal = reveal
        _ = dock(composer, reveal)
        composer.retarget(ChatComposerEnvironment(
            sessionId: "t", account: account, sender: account.sender, controls: account.actions, draftStorage: StalledStorage()
        ))
        XCTAssertEqual(composer.restoreGeneration, 1)
        // The chat before the retarget, reported late.
        reveal.restored(generation: 0)
        XCTAssertFalse(reveal.isRevealed)
        XCTAssertEqual(composer.alpha, 0)
        composer.focus()
        XCTAssertEqual(screen.restores, [1])
        XCTAssertTrue(reveal.isRevealed)
    }

    func testARestoreReachedWhileTheChatLaysOutShowsInThatPass() async throws {
        let screen = Screen()
        let account = try account(LocalStore(writer: DatabaseQueue()))
        let composer = SessionComposerView(
            environment: ChatComposerEnvironment(sessionId: "s", account: account, sender: account.sender, controls: account.actions),
            restoreTimeout: .seconds(3600)
        )
        composer.composerDelegate = screen
        let reveal = ChatComposerReveal(composer: composer)
        screen.reveal = reveal
        // The (empty) draft is read before the chat asks for the height.
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(composer.isRestored)
        _ = composer.composerHeight(fitting: width)
        reveal.heightRead()
        XCTAssertTrue(reveal.isRevealed, "in the layout that read the height")
        XCTAssertEqual(screen.restores, [], "before the composer's own report")
        try await until { !screen.restores.isEmpty }
        XCTAssertEqual(screen.restores, [0])
        XCTAssertTrue(reveal.isRevealed)
    }

    func testOnceShownTouchesReachTheComposer() throws {
        let screen = Screen()
        let composer = stalledComposer(try account(LocalStore(writer: DatabaseQueue())))
        composer.composerDelegate = screen
        let reveal = ChatComposerReveal(composer: composer)
        screen.reveal = reveal
        let dock = dock(composer, reveal)
        composer.focus()
        XCTAssertTrue(reveal.isRevealed)
        let hit = dock.hitTest(CGPoint(x: width / 2, y: composer.frame.midY), with: nil)
        XCTAssertTrue(hit?.isDescendant(of: composer) == true, "the composer's own, not the catcher: \(String(describing: hit))")
        // Laid out again, the catcher stays gone.
        reveal.layout(composerFrame: composer.frame)
        XCTAssertNil(reveal.catcher.superview)
    }

    func testAComposerAlreadyRestoredShowsAtOnce() throws {
        let composer = stalledComposer(try account(LocalStore(writer: DatabaseQueue())))
        _ = composer.composerHeight(fitting: width)
        composer.focus()
        let reveal = ChatComposerReveal(composer: composer)
        XCTAssertTrue(reveal.isRevealed)
        XCTAssertEqual(composer.alpha, 1)
    }
}
#endif
