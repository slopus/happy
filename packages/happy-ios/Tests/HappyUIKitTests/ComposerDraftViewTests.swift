#if canImport(UIKit)
import Foundation
import GRDB
@testable import HappyCore
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

/// Counts the SQL statements run on the main thread.
private final class MainThreadSQL: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func reset() { lock.withLock { count = 0 } }
    func trace(_ event: Database.TraceEvent) {
        if Thread.isMainThread { lock.withLock { count += 1 } }
    }
}

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

/// The chat's composer over a real store: the draft comes and goes without
/// a statement on the main thread.
@MainActor
final class ComposerDraftViewTests: XCTestCase {
    private func session() -> SessionRecord {
        SessionRecord(
            id: "s", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(["flavor": .string("claude")]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true
        )
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testTheDraftLoadsAndSavesWithoutSQLOnTheMainThread() async throws {
        let sql = MainThreadSQL()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { sql.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        let record = session()
        try store.upsertSessions([record])
        try store.saveDraft(sessionId: "s", text: "unsent", at: 1)
        let account = try AccountSession(
            credentials: Credentials(token: "t", secret: Data(repeating: 1, count: 32)),
            store: store,
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: NoNetwork())
        )
        sql.reset()

        let composer = ChatComposerFactory.make(ChatComposerEnvironment(
            sessionId: "s", account: account, sender: account.sender, controls: account.actions
        ))
        composer.frame = CGRect(x: 0, y: 0, width: 393, height: 200)
        let card = try XCTUnwrap(composer.subviews.compactMap { $0 as? AgentInputCardView }.first)
        XCTAssertEqual(card.text, "", "nothing is read before the view exists")
        composer.update(ChatComposerState(session: ChatSessionState(record: record, settings: AccountSettings())))
        try await until { card.text == "unsent" }
        XCTAssertEqual(card.text, "unsent")

        // An edit waits for the debounce; leaving the window flushes it.
        card.setText("unsent!", selection: NSRange(location: 7, length: 0))
        composer.willMove(toWindow: nil)
        var saved: String?
        for _ in 0..<200 where saved != "unsent!" {
            saved = try await Task.detached { try store.draft(sessionId: "s")?.text }.value
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(saved, "unsent!")
        XCTAssertEqual(sql.value, 0)
    }
}
#endif
