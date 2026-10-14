import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private struct DraftMeasurementKey: Hashable, Sendable {
    let width: Double
    let fontSize: Double
}

final class MeasuredDraftMemoTests: XCTestCase {
    func testOnlyTheMatchingDraftHasAnEntryWithItsOriginalKeyType() throws {
        let memo = MeasuredDraftMemo()
        let key = DraftMeasurementKey(width: 320, fontSize: 16)
        XCTAssertNil(memo.entry(for: "draft"))
        memo.keep("draft", key: key, height: 80)
        let entry = try XCTUnwrap(memo.entry(for: "draft"))
        XCTAssertEqual(entry.text, "draft")
        XCTAssertEqual(entry.key as? DraftMeasurementKey, key)
        XCTAssertEqual(entry.height, 80)
        XCTAssertNil(memo.entry(for: "different draft"))
    }

    func testNewMeasurementAndReplacementTextDiscardTheOldEntry() throws {
        let memo = MeasuredDraftMemo()
        memo.keep("draft", key: DraftMeasurementKey(width: 320, fontSize: 16), height: 80)
        let newKey = DraftMeasurementKey(width: 280, fontSize: 20)
        memo.keep("draft", key: newKey, height: 120)
        let measuredAgain = try XCTUnwrap(memo.entry(for: "draft"))
        XCTAssertEqual(measuredAgain.key as? DraftMeasurementKey, newKey)
        XCTAssertEqual(measuredAgain.height, 120)
        memo.keep("replacement", key: newKey, height: 160)
        XCTAssertNil(memo.entry(for: "draft"))
        XCTAssertEqual(memo.entry(for: "replacement")?.height, 160)
    }

    func testClosePermanentlyDropsTextAndRejectsLaterMeasurements() {
        let memo = MeasuredDraftMemo()
        memo.keep("private draft", key: "key", height: 80)
        memo.close()
        memo.close()
        XCTAssertTrue(memo.isClosed)
        XCTAssertNil(memo.entry(for: "private draft"))
        memo.keep("private draft", key: "late key", height: 120)
        memo.keep("another private draft", key: "late key", height: 160)
        XCTAssertNil(memo.entry(for: "private draft"))
        XCTAssertNil(memo.entry(for: "another private draft"))
    }
}

@MainActor
final class AccountDraftMemoLifecycleTests: XCTestCase {
    private func account() async throws -> AccountSession {
        try await Task.detached {
            try AccountSession(
                credentials: Credentials(token: "same-account", secret: Data(repeating: 9, count: 32)),
                store: LocalStore.inMemory(),
                dependencies: .init(serverURL: URL(string: "https://test.invalid")!, clientID: "ios/test",
                                    transport: FakeHTTP(), connector: FakeConnector())
            )
        }.value
    }

    func testStoppingOneSessionClosesItsMemoAndNeverSeedsAnotherWithTheSameDraft() async throws {
        let first = try await account(), next = try await account()
        XCTAssertEqual(first.keys.anonID, next.keys.anonID)
        XCTAssertFalse(first.newSessionDraftHeight === next.newSessionDraftHeight)
        let key = DraftMeasurementKey(width: 320, fontSize: 16)
        first.newSessionDraftHeight.keep("same private draft", key: key, height: 80)
        XCTAssertNil(next.newSessionDraftHeight.entry(for: "same private draft"))
        next.newSessionDraftHeight.keep("same private draft", key: key, height: 120)
        await first.stop()
        XCTAssertTrue(first.newSessionDraftHeight.isClosed)
        XCTAssertNil(first.newSessionDraftHeight.entry(for: "same private draft"))
        first.newSessionDraftHeight.keep("same private draft", key: key, height: 160)
        XCTAssertNil(first.newSessionDraftHeight.entry(for: "same private draft"))
        XCTAssertFalse(next.newSessionDraftHeight.isClosed)
        XCTAssertEqual(next.newSessionDraftHeight.entry(for: "same private draft")?.height, 120)
        await next.stop()
        XCTAssertTrue(next.newSessionDraftHeight.isClosed)
        XCTAssertNil(next.newSessionDraftHeight.entry(for: "same private draft"))
        let restarted = try await account()
        XCTAssertFalse(restarted.newSessionDraftHeight.isClosed)
        XCTAssertNil(restarted.newSessionDraftHeight.entry(for: "same private draft"))
        await restarted.stop()
    }
}