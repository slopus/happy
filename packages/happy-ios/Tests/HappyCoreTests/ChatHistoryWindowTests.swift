import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

final class ChatHistoryWindowTests: XCTestCase {
    private func store(seq: Int = 10) throws -> LocalStore {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession(seq: seq)])
        return store
    }

    private func row(_ seq: Int) -> MessageRecord {
        ChatRecords.stored(ChatRecords.text("m\(seq)", at: Int64(seq) * 1000,
                                           text: "token \(seq)"), seq: seq)
    }

    private func texts(_ snapshot: ChatSnapshot?) -> [String] {
        snapshot?.messages.compactMap { if case .agentText(let row) = $0 { return row.text }; return nil } ?? []
    }

    private func next(_ stream: AsyncStream<ChatSnapshot>) async throws -> ChatSnapshot {
        let value = try await syncPerfNext(stream)
        return try XCTUnwrap(value)
    }

    func testPrefixIsClippedUntilItJoinsAndNewerSocketAndLocalRowsRemainVisible() async throws {
        let store = try store()
        try store.applyMessagePage(sessionId: "s", messages: [row(1), row(2)])
        try store.applyChatHistoryPage(sessionId: "s", messages: [row(9), row(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        try store.applyMessagePage(sessionId: "s", messages: [
            ChatRecords.stored(ChatRecords.user("local", at: 1), seq: 0)
        ])
        try store.enqueue(OutboxRecord(localId: "pending", kind: .message, sessionId: "s",
                                       payload: ChatRecords.user("pending", at: 20000).raw, createdAt: 20000))
        let stream = LocalChatFeed(store: store).snapshots(sessionId: "s")
        let tail = try await next(stream)
        XCTAssertEqual(texts(tail), ["token 9", "token 10"])
        XCTAssertEqual(tail.olderBoundary, 9)
        XCTAssertTrue(tail.hasMoreOlder)
        XCTAssertEqual(tail.windowEpoch, 0)
        XCTAssertEqual(tail.messages.filter { if case .userText = $0 { return true }; return false }.count, 2)
        XCTAssertEqual(try store.applyLiveMessage(row(15)), .gap)
        let live = try await next(stream)
        XCTAssertEqual(texts(live), ["token 9", "token 10", "token 15"], "upper gaps remain forward-sync owned")
        XCTAssertEqual(live.olderBoundary, 9)
        try store.applyMessagePage(sessionId: "s", messages: [row(3), row(4)], syncedThrough: 4)
        XCTAssertEqual(try store.chatPage(sessionId: "s").records.filter { $0.seq > 0 }.map(\.seq), [9, 10, 15])
        try store.applyMessagePage(sessionId: "s", messages: [row(5), row(6), row(7), row(8)], syncedThrough: 8)
        let joined = try await next(stream)
        XCTAssertEqual(texts(joined), (1...10).map { "token \($0)" } + ["token 15"])
        XCTAssertEqual(joined.olderBoundary, 1)
        XCTAssertFalse(joined.hasMoreOlder)
        XCTAssertEqual(joined.windowEpoch, 0, "joining a prefix only expands the window")
    }

    func testDisjointNewestDropsRenderedIslandAndOlderExpansionKeepsEpoch() async throws {
        let store = try store(seq: 20)
        try store.applyChatHistoryPage(sessionId: "s", messages: [row(9), row(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        let stream = LocalChatFeed(store: store).snapshots(sessionId: "s")
        let before = try await next(stream)
        XCTAssertEqual(texts(before), ["token 9", "token 10"])
        try store.applyChatHistoryPage(sessionId: "s", messages: [row(19), row(20)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 20))
        let refreshed = try await next(stream)
        XCTAssertEqual(texts(refreshed), ["token 19", "token 20"])
        XCTAssertEqual(refreshed.windowEpoch, before.windowEpoch + 1)
        XCTAssertEqual(refreshed.olderBoundary, 19)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [9, 10, 19, 20], "clipping preserves offline cache")
        try store.applyChatHistoryPage(sessionId: "s", messages: [row(17), row(18)],
                                       hasMore: true, page: .older(beforeSeq: 19))
        let older = try await next(stream)
        XCTAssertEqual(texts(older), ["token 17", "token 18", "token 19", "token 20"])
        XCTAssertEqual(older.olderBoundary, 17)
        XCTAssertEqual(older.windowEpoch, refreshed.windowEpoch)
        // The old cached island has a rowid below the current insertion
        // cursor. Once a server page covers it, the feed must include it.
        try store.applyChatHistoryPage(sessionId: "s", messages: [row(9), row(10), row(16)],
                                       hasMore: false, page: .older(beforeSeq: 17))
        let coveredIsland = try await next(stream)
        XCTAssertEqual(texts(coveredIsland), [9, 10, 16, 17, 18, 19, 20].map { "token \($0)" })
        XCTAssertEqual(coveredIsland.olderBoundary, 9)
        XCTAssertFalse(coveredIsland.hasMoreOlder)
        XCTAssertEqual(coveredIsland.windowEpoch, refreshed.windowEpoch)
    }

    func testInvisibleAndBurnedSequencesAdvanceTransactionalSnapshotBoundary() async throws {
        let store = try store()
        func hidden(_ seq: Int) -> MessageRecord {
            ChatRecords.stored(ChatRecords.agentEvent("h\(seq)", at: Int64(seq) * 1000,
                event: .object(["type": .string("message"), "message": .string("Turn started")])), seq: seq)
        }
        try store.applyChatHistoryPage(sessionId: "s", messages: [hidden(9), hidden(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        let stream = LocalChatFeed(store: store).snapshots(sessionId: "s")
        let first = try await next(stream)
        XCTAssertTrue(first.messages.isEmpty)
        XCTAssertTrue(first.isLoaded)
        XCTAssertTrue(first.hasMoreOlder)
        XCTAssertEqual(first.olderBoundary, 9)
        try store.applyChatHistoryPage(sessionId: "s", messages: [hidden(5), hidden(7)],
                                       hasMore: false, page: .older(beforeSeq: 9))
        let older = try await next(stream)
        XCTAssertTrue(older.messages.isEmpty)
        XCTAssertEqual(older.olderBoundary, 5)
        XCTAssertFalse(older.hasMoreOlder)
        XCTAssertEqual(older.windowEpoch, 0)
        XCTAssertNotEqual(ChatSnapshotFacts(first), ChatSnapshotFacts(older),
                          "an invisible page still delivers the new paging boundary to the screen")
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 0)
    }

    func testEmptyTailClipsStaleRowsButPreservesLaterLiveRowsAndCompletePrefixOffline() async throws {
        let store = try store()
        try store.applyChatHistoryPage(sessionId: "s", messages: [row(9), row(10)],
                                       hasMore: true, page: .newest(checkedThroughSeq: 10))
        let stream = LocalChatFeed(store: store).snapshots(sessionId: "s")
        _ = try await syncPerfNext(stream)
        try store.applyChatHistoryPage(sessionId: "s", messages: [],
                                       hasMore: false, page: .newest(checkedThroughSeq: 10))
        let empty = try await next(stream)
        XCTAssertTrue(empty.isLoaded)
        XCTAssertTrue(empty.messages.isEmpty)
        XCTAssertNil(empty.olderBoundary)
        XCTAssertFalse(empty.hasMoreOlder)
        XCTAssertEqual(empty.windowEpoch, 1)
        _ = try store.applyLiveMessage(row(11))
        let live = try await next(stream)
        XCTAssertEqual(texts(live), ["token 11"])
        XCTAssertEqual(live.windowEpoch, 1)
        try store.applyMessagePage(sessionId: "s", messages: [row(1)], syncedThrough: 11)
        let offline = try await next(LocalChatFeed(store: store).snapshots(sessionId: "s"))
        XCTAssertEqual(texts(offline), [1, 9, 10, 11].map { "token \($0)" })
        XCTAssertTrue(offline.isLoaded)
        XCTAssertFalse(offline.hasMoreOlder)
        let prefixOnly = try self.store(seq: 4)
        try prefixOnly.applyMessagePage(sessionId: "s", messages: [row(1), row(4)], syncedThrough: 4)
        let prefix = try await next(LocalChatFeed(store: prefixOnly).snapshots(sessionId: "s"))
        XCTAssertEqual(texts(prefix), ["token 1", "token 4"])
        XCTAssertTrue(prefix.isLoaded, "a legacy complete prefix still opens directly from disk")
    }

    func testActualOlderPageResetAndCompactionPreserveNewestUsageAndTodos() async throws {
        let store = try store(seq: 11)
        let rawUsage = ChatRecords.session("usage", at: 9000, turn: nil,
            event: .object(["t": .string("service"), "text": .string("")]),
            extra: ["usage": ChatRecords.json(#"{"input_tokens":12,"output_tokens":4,"context_window":200000}"#)])
        let todos = ChatRecords.json(#"[{"content":"Current task","status":"pending"}]"#)
        let rawResult = JSONValue.object([
            "role": .string("agent"), "content": .object([
                "type": .string("acp"), "provider": .string("gemini"), "data": .object([
                    "id": .string("todos"), "type": .string("tool-result"), "callId": .string("call"),
                    "output": .object(["newTodos": todos]), "isError": .bool(false),
                ]),
            ]),
        ])
        let newest = [
            ChatRecords.stored(ChatRecords.normalized("usage", raw: rawUsage), seq: 9),
            ChatRecords.stored(ChatRecords.call("todo", name: "TodoWrite", at: 10000), seq: 10),
            ChatRecords.stored(ChatRecords.normalized("todos", at: 11000, raw: rawResult), seq: 11),
        ]
        try store.applyChatHistoryPage(sessionId: "s", messages: newest,
                                       hasMore: true, page: .newest(checkedThroughSeq: 11))
        let stream = LocalChatFeed(store: store).snapshots(sessionId: "s")
        let first = try await next(stream)
        XCTAssertEqual(first.usage?.inputTokens, 12)
        XCTAssertEqual(first.todos, todos)
        let resets = ["Context was reset", "Compaction completed"].enumerated().map { index, event in
            ChatRecords.stored(ChatRecords.agentEvent("reset\(index)", at: Int64(index + 1) * 1000,
                event: .object(["type": .string("message"), "message": .string(event)])), seq: index + 1)
        }
        try store.applyChatHistoryPage(sessionId: "s", messages: resets,
                                       hasMore: false, page: .older(beforeSeq: 9))
        let older = try await next(stream)
        XCTAssertEqual(older.usage, first.usage)
        XCTAssertEqual(older.todos, todos)
        XCTAssertEqual(older.olderBoundary, 1)
        XCTAssertEqual(older.windowEpoch, first.windowEpoch)
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 0)
    }
}