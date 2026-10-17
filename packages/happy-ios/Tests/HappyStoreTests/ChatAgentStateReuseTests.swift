import Foundation
import GRDB
import HappyWire
import XCTest
@testable import HappyStore

final class ChatAgentStateReuseTests: XCTestCase {
    private func record(_ id: String = "s", version: Int = 1, cipher: String = "encrypted", state: JSONValue? = .string("cached")) -> SessionRecord {
        var record = makeSession(id, agentStateVersion: version)
        record.agentStateCipher = cipher
        record.agentState = state
        return record
    }

    func testCurrentPayloadIsReusedWithoutDecodingAgain() {
        let state = JSONValue.object(["completedRequests": .string(String(repeating: "x", count: 1_000_000))])
        let cached = record(state: state)
        var reads = 0
        let value = LocalStore.chatAgentState(sessionId: "s", version: 1, cipher: "encrypted", cached: cached) {
            reads += 1
            return .null
        }
        XCTAssertEqual(value, state)
        XCTAssertEqual(reads, 0, "opening a chat must not decode the already-decoded megabyte payload again")
    }

    func testAnyIdentityMismatchOrMissingPayloadReadsTransactionState() {
        let candidates: [SessionRecord?] = [
            nil, record("another-session"), record(version: 0), record(cipher: "another-account-cipher"), record(state: nil)
        ]
        for cached in candidates {
            var reads = 0
            let value = LocalStore.chatAgentState(sessionId: "s", version: 1, cipher: "encrypted", cached: cached) {
                reads += 1
                return .string("transaction")
            }
            XCTAssertEqual(value, .string("transaction"))
            XCTAssertEqual(reads, 1)
        }
    }

    func testVersionAndCipherChangeAndDeletionUseTheTransaction() throws {
        let store = try LocalStore.inMemory()
        let cached = record()
        try store.upsertSessions([cached])
        _ = try store.applySessionUpdate(id: "s", metadata: VersionedPayload(version: 2, cipher: "meta", value: .object([
            "client": .object(["id": .string("new-client")])
        ])), agentState: VersionedPayload(version: 2, cipher: "new-cipher", value: .string("fresh")), projectId: nil)
        let changed = try store.writer.read { db in
            try LocalStore.fetchChatChange(db, sessionId: "s", cachedSession: cached)
        }
        XCTAssertEqual(changed.session?.agentState, .string("fresh"))
        XCTAssertEqual(changed.session?.agentStateVersion, 2)
        XCTAssertEqual(changed.session?.metadata["client"]?["id"], .string("new-client"))
        try store.deleteSession(id: "s")
        let deleted = try store.writer.read { db in
            try LocalStore.fetchChatChange(db, sessionId: "s", cachedSession: cached)
        }
        XCTAssertNil(deleted.session, "a cached record never resurrects a deleted session")
    }

    func testColdStoresAndAccountsWithTheSameSessionIDRemainIndependent() throws {
        let first = try LocalStore.inMemory()
        let second = try LocalStore.inMemory()
        try first.upsertSessions([record(state: .string("first account"))])
        try second.upsertSessions([record(cipher: "second-cipher", state: .string("second account"))])
        XCTAssertEqual(try first.chatPage(sessionId: "s").change.session?.agentState, .string("first account"))
        XCTAssertEqual(try second.chatPage(sessionId: "s").change.session?.agentState, .string("second account"))
    }

    func testObservationDeliversNewStateWithAHomeCacheThenAfterThatCacheStops() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([record()])
        var home = store.homeSnapshots().makeAsyncIterator()
        let initialHome = await home.next()
        XCTAssertEqual(initialHome?.sessions.first?.agentState, .string("cached"))
        let changes = store.chatChanges(sessionId: "s")
        var iterator = changes.makeAsyncIterator()
        let initial = try await iterator.next()
        XCTAssertEqual(initial?.session?.agentState, .string("cached"))
        _ = try store.applySessionUpdate(id: "s", metadata: nil,
            agentState: VersionedPayload(version: 2, cipher: "second", value: .string("second")), projectId: nil)
        let updated = try await iterator.next()
        XCTAssertEqual(updated?.session?.agentStateVersion, 2)
        XCTAssertEqual(updated?.session?.agentState, .string("second"))
        // Direct fetch above proves deterministic stale-cache behavior;
        // this exercises the real producer on both sides of cache teardown.
        await store.homeHub.stop()
        XCTAssertNil(store.latestHomeSnapshot)
        _ = try store.applySessionUpdate(id: "s", metadata: nil,
            agentState: VersionedPayload(version: 3, cipher: "third", value: .string("third")), projectId: nil)
        let withoutCache = try await iterator.next()
        XCTAssertEqual(withoutCache?.session?.agentStateVersion, 3)
        XCTAssertEqual(withoutCache?.session?.agentState, .string("third"))
        // Cancelling a task consuming this stream releases the observation.
        let consumer = Task { for try await _ in changes {} }
        consumer.cancel()
        _ = await consumer.result
    }
}