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

@MainActor
private final class Screen: ChatComposerDelegate {
    var restores: [Int] = []
    var invalidations = 0

    func composerDidInvalidateHeight(_ composer: any ChatComposerView) { invalidations += 1 }
    func composerDidChangeFocus(_ composer: any ChatComposerView) {}
    func composer(_ composer: any ChatComposerView, didSend localId: String) {}
    func composerDidRestore(_ composer: any ChatComposerView, generation: Int) { restores.append(generation) }
}

/// The chat's composer reports itself restored once its opening draft is
/// read and measured off the main thread, so the chat can keep it hidden
/// until its first frame is its last (CM1).
@MainActor
final class ComposerRestoreTests: XCTestCase {
    private func session(_ id: String) -> SessionRecord {
        SessionRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(["flavor": .string("claude")]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true
        )
    }

    private func account(drafts: [String: String]) throws -> AccountSession {
        let store = try LocalStore(writer: DatabaseQueue())
        try store.upsertSessions(drafts.keys.sorted().map(session))
        for (id, text) in drafts {
            try store.saveDraft(sessionId: id, text: text, at: 1)
        }
        return try AccountSession(
            credentials: Credentials(token: "t", secret: Data(repeating: 1, count: 32)),
            store: store,
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: OfflineTransport())
        )
    }

    /// The chat's composer as the chat makes it, with the production
    /// deadline.
    private func composer(_ sessionId: String, _ account: AccountSession, storage: (any ComposerStorage)? = nil) -> any ChatComposerView {
        ChatComposerFactory.make(ChatComposerEnvironment(
            sessionId: sessionId, account: account, sender: account.sender, controls: account.actions, draftStorage: storage
        ))
    }

    /// One whose deadline can't run out within the test: if it restores,
    /// its draft was read and measured, however slow the machine.
    private func measuredComposer(_ sessionId: String, _ account: AccountSession) -> SessionComposerView {
        SessionComposerView(
            environment: ChatComposerEnvironment(sessionId: sessionId, account: account, sender: account.sender, controls: account.actions),
            restoreTimeout: .seconds(3600)
        )
    }

    private func card(_ composer: any ChatComposerView) throws -> AgentInputCardView {
        try XCTUnwrap(composer.subviews.compactMap { $0 as? AgentInputCardView }.first)
    }

    /// Up to 10 seconds: a first run on a cold simulator is slow.
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<2000 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testARestoredDraftIsMeasuredBeforeItShows() async throws {
        let screen = Screen()
        let composer = measuredComposer("s", try account(drafts: ["s": "one\ntwo\nthree"]))
        composer.composerDelegate = screen
        // The chat lays out at once, the dock hidden.
        let guess = composer.composerHeight(fitting: 393)
        XCTAssertFalse(composer.isRestored)
        try await until { composer.isRestored }
        XCTAssertEqual(screen.restores, [0])
        XCTAssertEqual(try card(composer).text, "one\ntwo\nthree")
        let shown = composer.composerHeight(fitting: 393)
        XCTAssertGreaterThan(shown, guess, "three lines")
        composer.frame = CGRect(x: 0, y: 0, width: 393, height: shown)
        composer.layoutIfNeeded()
        let shownCard = try card(composer)
        XCTAssertTrue(shownCard.isTextMeasured(fitting: shownCard.bounds.width), "measured, not the deadline")
        // Nothing moves after it shows.
        let invalidations = screen.invalidations
        await shownCard.textMeasured()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(composer.composerHeight(fitting: 393), shown)
        XCTAssertEqual(screen.invalidations, invalidations)
        XCTAssertEqual(screen.restores, [0], "once")
    }

    func testARestoreHeldAcrossARetargetIsTheNewChats() async throws {
        let screen = Screen()
        let account = try account(drafts: ["s": "old\nold\nold\nold", "t": "new"])
        let composer = measuredComposer("s", account)
        composer.composerDelegate = screen
        let guess = composer.composerHeight(fitting: 393)
        // The chat became another before its draft was read.
        composer.retarget(ChatComposerEnvironment(sessionId: "t", account: account, sender: account.sender, controls: account.actions))
        XCTAssertEqual(composer.restoreGeneration, 1)
        try await until { composer.isRestored }
        XCTAssertEqual(screen.restores, [1], "the old chat's restore never reaches the screen")
        XCTAssertEqual(try card(composer).text, "new")
        XCTAssertEqual(composer.composerHeight(fitting: 393), guess, "one line, never the old draft's four")
    }

    /// The production deadline, unchanged.
    func testAStalledReadShowsAtTheDeadline() async throws {
        XCTAssertEqual(ChatComposerRestore.timeout, .milliseconds(300))
        let screen = Screen()
        let made = ContinuousClock.now
        let composer = composer("s", try account(drafts: [:]), storage: StalledStorage())
        composer.composerDelegate = screen
        let guess = composer.composerHeight(fitting: 393)
        try await Task.sleep(for: .milliseconds(100))
        // Not early (checked only while the clock is clearly short of it).
        if made.duration(to: .now) < .milliseconds(250) {
            XCTAssertFalse(composer.isRestored)
        }
        try await until { composer.isRestored }
        XCTAssertGreaterThanOrEqual(made.duration(to: .now), .milliseconds(300))
        XCTAssertEqual(screen.restores, [0])
        XCTAssertEqual(composer.composerHeight(fitting: 393), guess, "the height known: nothing measured on main")
    }

    func testFocusShowsItAtOnce() throws {
        let screen = Screen()
        let composer = composer("s", try account(drafts: [:]), storage: StalledStorage())
        composer.composerDelegate = screen
        _ = composer.composerHeight(fitting: 393)
        composer.focus()
        XCTAssertTrue(composer.isRestored)
        XCTAssertEqual(screen.restores, [0])
    }

    func testARestoreReachedWhileTheScreenLaysOutIsAnnouncedAfter() async throws {
        let screen = Screen()
        let composer = measuredComposer("s", try account(drafts: [:]))
        composer.composerDelegate = screen
        // The (empty) draft is read before the screen asks.
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(composer.isRestored)
        _ = composer.composerHeight(fitting: 393)
        XCTAssertTrue(composer.isRestored, "readable right after the height")
        XCTAssertEqual(screen.restores, [], "not inside the screen's layout")
        try await until { !screen.restores.isEmpty }
        XCTAssertEqual(screen.restores, [0])
    }
}
#endif
