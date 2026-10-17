import Foundation
import GRDB
import XCTest
@testable import HappyStore

final class SessionDetailFailureTests: XCTestCase {
    func testObservationReadFailureIsDeliveredAndANewObservationCanRecover() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([SessionRecord(
            id: "session", seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, projectId: nil,
            metadataVersion: 0, metadataCipher: "fixture", metadata: nil,
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true
        )])
        // A damaged device-local composer row is not read by Home, but it
        // must produce a failure rather than an empty Details stream.
        try await store.writer.write { db in
            try db.execute(sql: "INSERT INTO composerState (sessionId, [values]) VALUES (?, ?)", arguments: ["session", "PRIVATE-invalid-json"])
        }
        let errors = AsyncStream<SessionDetailFailure>.makeStream()
        let errored = expectation(description: "Details observation delivers its read failure")
        let stream = store.sessionDetailSnapshots(sessionId: "session") {
            errors.continuation.yield($0)
            errored.fulfill()
        }
        let consume = Task { for await _ in stream {} }
        await fulfillment(of: [errored], timeout: 3)
        errors.continuation.finish()
        var iterator = errors.stream.makeAsyncIterator()
        let failure = await iterator.next()
        XCTAssertEqual(failure?.kind, .decoding)
        XCTAssertFalse(String(describing: failure).contains("PRIVATE"))
        try await store.writer.write { db in try db.execute(sql: "DELETE FROM composerState WHERE sessionId = ?", arguments: ["session"]) }
        let retry = store.sessionDetailSnapshots(sessionId: "session")
        let recovered = await withTaskGroup(of: SessionDetailSnapshot?.self) { group in
            group.addTask { var iterator = retry.makeAsyncIterator(); return await iterator.next() }
            group.addTask { try? await Task.sleep(for: .seconds(3)); return nil }
            let value = await group.next() ?? nil
            group.cancelAll()
            return value
        }
        XCTAssertEqual(recovered?.session?.id, "session")
        consume.cancel()
    }

    func testDatabaseFailuresRetainOnlyCategoryAndCode() {
        let raw = DatabaseError(resultCode: .SQLITE_CORRUPT, message: "PRIVATE-record", sql: "SELECT PRIVATE FROM secret")
        let failure = SessionDetailFailure(raw)
        XCTAssertEqual(failure, SessionDetailFailure(kind: .database, code: 11))
        XCTAssertFalse(String(describing: failure).contains("PRIVATE"))
        XCTAssertEqual(SessionDetailFailure(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "PRIVATE"))).kind, .decoding)
    }
}