import Foundation
import XCTest
@testable import HappyStore
import HappyWire

/// The v3 outbox columns and composer drafts.
final class OutboxStoreTests: XCTestCase {
    var store: LocalStore!

    override func setUpWithError() throws {
        store = try LocalStore.inMemory()
    }

    func testAQueuedItemStartsReadyToSend() throws {
        try store.enqueue(OutboxRecord(localId: "l1", kind: .message, sessionId: "s", payload: .object([:]), createdAt: 1))
        let item = try XCTUnwrap(try store.pendingOutbox().first)
        XCTAssertEqual(item.state, .queued)
        XCTAssertEqual(item.nextAttemptAt, 0)
        XCTAssertNil(item.dependsOn)
    }

    func testDraftsAreSavedAndEmptyTextDeletesThem() throws {
        try store.saveDraft(sessionId: "s", text: "hello", at: 5)
        XCTAssertEqual(try store.draft(sessionId: "s"), DraftRecord(sessionId: "s", text: "hello", updatedAt: 5))
        try store.saveDraft(sessionId: "s", text: "", at: 6)
        XCTAssertNil(try store.draft(sessionId: "s"))
    }
}
