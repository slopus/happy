import Foundation
import GRDB
import XCTest
import HappyWire
@testable import HappyStore

final class ChatHistoryStoreTests: XCTestCase {
    private func seed(_ store: LocalStore, seq: Int = 10) throws {
        try store.upsertSessions([SessionRecord(
            id: "s", seq: seq, createdAt: 1, updatedAt: 11, active: false, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "", metadata: .object([:]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: nil, decryptable: true
        )])
    }

    private func message(_ seq: Int, localId: String? = nil) -> MessageRecord {
        MessageRecord(id: "m\(seq)", sessionId: "s", seq: seq, localId: localId,
                      createdAt: Int64(seq) * 1000, updatedAt: Int64(seq) * 1000,
                      contentCipher: "cipher\(seq)", content: .object(["text": .string("token \(seq)")]))
    }

    func testBackwardPagesReuseEchoJoinWithoutMovingThePrefix() throws {
        let store = try LocalStore.inMemory()
        try seed(store)
        try store.applyMessagePage(sessionId: "s", messages: [message(1)])
        try store.enqueue(OutboxRecord(localId: "local9", kind: .message, sessionId: "s",
                                       payload: .object(["text": .string("pending")]), createdAt: 9000))
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(9, localId: "local9"), message(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        XCTAssertNil(try store.outbox(localId: "local9"), "backward pages use the same echo/outbox join")
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 1)
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(7), message(8)],
                                       hasMore: true, page: .older(beforeSeq: 9))
        try store.applyChatHistoryPage(sessionId: "s", messages: [], hasMore: false, page: .older(beforeSeq: 7))
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [1, 7, 8, 9, 10])
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 1)
        XCTAssertEqual(try store.session(id: "s")?.updatedAt, 11, "history leaves the wire activity timestamp authoritative")
        XCTAssertEqual(try store.chatHistoryCoverage(sessionId: "s")?.hasMore, false)
    }

    func testForwardPrefixBridgesSparseTailWithoutInferringCoverageFromRowCounts() throws {
        let store = try LocalStore.inMemory()
        try seed(store, seq: 1000)
        try store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 100)
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(990), message(1000)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 1000))
        XCTAssertEqual(try store.chatHistoryCoverage(sessionId: "s")?.hasMore, true)
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 100)
        // The forward API may report a burned sequence range. Only that API
        // is allowed to move this prefix to the tail's boundary.
        try store.applyMessagePage(sessionId: "s", messages: [], syncedThrough: 989)
        XCTAssertEqual(try store.chatHistoryCoverage(sessionId: "s")?.hasMore, false)
        XCTAssertEqual(try store.messages(sessionId: "s").count, 2)
    }

    func testDisjointNewestWindowReplacesCoverageAndOverlapPreservesExhaustion() throws {
        let store = try LocalStore.inMemory()
        try seed(store, seq: 0)
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(9), message(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(19), message(20)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 20))
        XCTAssertEqual(try store.chatHistoryCoverage(sessionId: "s")?.marker?.oldestRawSeq, 19,
                       "cached rows at 9/10 do not claim the missing interval")
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(17), message(18)],
                                       hasMore: true, page: .older(beforeSeq: 19))
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(9), message(10)],
                                       hasMore: false, page: .older(beforeSeq: 17))
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(20), message(21)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 21))
        let coverage = try store.chatHistoryCoverage(sessionId: "s")
        XCTAssertEqual(coverage?.marker?.oldestRawSeq, 9)
        XCTAssertEqual(coverage?.marker?.newestRawSeq, 21)
        XCTAssertEqual(coverage?.hasMore, false)
        XCTAssertEqual(coverage?.seq, 21, "a higher observed server seq can inform forward recovery")
        XCTAssertEqual(coverage?.syncedMessageSeq, 0, "the synchronized prefix remains untouched")
    }

    func testInvalidAndStalePagesCannotInsertRowsOrChangeTheMarker() throws {
        let store = try LocalStore.inMemory()
        try seed(store)
        try store.applyChatHistoryPage(sessionId: "s", messages: [message(9), message(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        let before = try store.chatHistoryCoverage(sessionId: "s")
        XCTAssertThrowsError(try store.applyChatHistoryPage(sessionId: "s", messages: [message(7)],
                                                           hasMore: true, page: .older(beforeSeq: 8)))
        XCTAssertThrowsError(try store.applyChatHistoryPage(sessionId: "s", messages: [],
                                                           hasMore: true, page: .newest(checkedThroughSeq: 20)))
        XCTAssertEqual(try store.chatHistoryCoverage(sessionId: "s"), before)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [9, 10])
    }

    func testEmptyNewestCompletionSurvivesReopenAndCascadesOnDelete() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("chat-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("history.sqlite")
        do {
            let store = try LocalStore.open(at: url)
            try seed(store)
            try store.applyChatHistoryPage(sessionId: "s", messages: [], hasMore: false,
                                           page: .newest(checkedThroughSeq: 10))
        }
        let reopened = try LocalStore.open(at: url)
        let coverage = try reopened.chatHistoryCoverage(sessionId: "s")
        XCTAssertEqual(coverage?.marker?.newestLoaded, true)
        XCTAssertEqual(coverage?.hasMore, false)
        XCTAssertEqual(coverage?.syncedMessageSeq, 0)
        XCTAssertEqual(try reopened.chatPage(sessionId: "s").change.session?.newestHistoryLoaded, true)
        try reopened.deleteSession(id: "s")
        XCTAssertNil(try reopened.chatHistoryCoverage(sessionId: "s"))
        XCTAssertEqual(try reopened.writer.read { db in try ChatHistoryMarker.fetchCount(db) }, 0)
    }
}