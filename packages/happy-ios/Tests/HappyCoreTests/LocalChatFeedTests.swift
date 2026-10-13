import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

final class LocalChatFeedTests: XCTestCase {
    @MainActor
    func testFirstSnapshotComesFromDiskBeforeAnyNetwork() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession(seq: 1)])
        try store.applyMessagePage(
            sessionId: "s", messages: [ChatRecords.stored(ChatRecords.user("u"), seq: 1)])
        let received = expectation(description: "disk snapshot")
        let task = Task {
            for await snapshot in LocalChatFeed(store: store).snapshots(sessionId: "s") {
                XCTAssertEqual(snapshot.messages.count, 1)
                XCTAssertTrue(snapshot.isLoaded)
                received.fulfill()
                break
            }
        }
        await fulfillment(of: [received], timeout: 2)
        task.cancel()
    }

    func testOutboxMessagesAppearPendingWithDeliveryAndDiscardRemovesThem() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        var state = FeedState(sessionId: "s")
        for delivery in [OutboxRecord.State.queued, .sending, .failed] {
            try store.removeFromOutbox(localId: "local")
            try store.enqueue(
                OutboxRecord(
                    localId: "local", kind: .message, sessionId: "s", payload: ChatRecords.user("local").raw,
                    createdAt: 100, lastError: "failed", state: delivery))
            let snapshot = state.apply(try store.chatPage(sessionId: "s", afterRowId: state.lastRowId))
            XCTAssertTrue(try ChatRecords.userRow(snapshot.messages).pending)
            switch delivery {
            case .queued: XCTAssertEqual(snapshot.delivery["local"], .queued)
            case .sending: XCTAssertEqual(snapshot.delivery["local"], .sending)
            case .failed: XCTAssertEqual(snapshot.delivery["local"], .failed("failed"))
            }
        }
        try store.removeFromOutbox(localId: "local")
        let snapshot = state.apply(try store.chatPage(sessionId: "s", afterRowId: state.lastRowId))
        XCTAssertTrue(snapshot.messages.isEmpty)
        XCTAssertTrue(snapshot.delivery.isEmpty)
    }

    func testServerEchoReplacesOutboxAndReceiptSettlesAtRunOrderPosition() throws {
        let store = try LocalStore.inMemory()
        let metadata = ChatRecords.json(
            #"{"client":{"id":"rig"},"rigMetadataVersion":1,"capabilities":{"messageReceipts":true}}"#)
        try store.upsertSessions([ChatRecords.storeSession(metadata: metadata)])
        try store.enqueue(
            OutboxRecord(
                localId: "local", kind: .message, sessionId: "s", payload: ChatRecords.user("local").raw,
                createdAt: 100))
        var state = FeedState(sessionId: "s")
        _ = state.apply(try store.chatPage(sessionId: "s"))
        try store.applyMessagePage(
            sessionId: "s",
            messages: [
                ChatRecords.stored(ChatRecords.user("server", localId: "local", expects: true), seq: 1),
                ChatRecords.stored(ChatRecords.receipt("r", ref: "server"), seq: 2),
            ])
        let snapshot = state.apply(try store.chatPage(sessionId: "s", afterRowId: state.lastRowId))
        XCTAssertEqual(snapshot.messages.count, 1)
        XCTAssertTrue(snapshot.delivery.isEmpty)
        let row = try ChatRecords.userRow(snapshot.messages)
        XCTAssertFalse(row.pending)
        XCTAssertEqual(row.sortAt, 500)
        XCTAssertEqual(row.id, "local")
    }

    func testMissingReceiptCapabilityDoesNotHoldStoredUserMessage() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        try store.applyMessagePage(
            sessionId: "s", messages: [ChatRecords.stored(ChatRecords.user("u", expects: true), seq: 1)])
        var state = FeedState(sessionId: "s")
        XCTAssertFalse(
            try ChatRecords.userRow(state.apply(try store.chatPage(sessionId: "s")).messages).pending)
    }

    func testInsertionCursorDoesNotLoseLateMessagesWithLowerSequence() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        _ = try store.applyLiveMessage(ChatRecords.stored(ChatRecords.text("later", at: 300), seq: 3))
        var state = FeedState(sessionId: "s")
        _ = state.apply(try store.chatPage(sessionId: "s"))
        let cursor = state.lastRowId
        try store.applyMessagePage(
            sessionId: "s", messages: [ChatRecords.stored(ChatRecords.text("earlier", at: 100), seq: 1)])
        let page = try store.chatPage(sessionId: "s", afterRowId: cursor)
        XCTAssertEqual(page.records.map(\.seq), [1])
        XCTAssertEqual(state.apply(page).messages.map(\.id), ["earlier:0", "later:0"])
    }

    func testAppendedRecordAndPermissionOnlyUpdateDoNotRereduceThousandsOfMessages() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let history = (1...5000).map {
            ChatRecords.stored(ChatRecords.text("m\($0)", at: Int64($0)), seq: $0)
        }
        try store.applyMessagePage(sessionId: "s", messages: history)
        var state = FeedState(sessionId: "s")
        _ = state.apply(try store.chatPage(sessionId: "s"))
        XCTAssertEqual(state.normalizedRecordCount, 5000)
        XCTAssertEqual(state.reducer.processedRecordCount, 5000)
        try store.applyMessagePage(
            sessionId: "s", messages: [ChatRecords.stored(ChatRecords.text("new", at: 5001), seq: 5001)])
        let delta = try store.chatPage(sessionId: "s", afterRowId: state.lastRowId)
        XCTAssertEqual(delta.records.count, 1)
        _ = state.apply(delta)
        XCTAssertEqual(state.normalizedRecordCount, 5001)
        XCTAssertEqual(state.reducer.processedRecordCount, 5001)
        try store.enqueue(
            OutboxRecord(
                localId: "l", kind: .message, sessionId: "s", payload: ChatRecords.user("l").raw,
                createdAt: 50))
        let pending = state.apply(try store.chatPage(sessionId: "s", afterRowId: state.lastRowId))
        XCTAssertEqual(pending.messages.last?.id, "l")
        XCTAssertEqual(pending.messages.count, 5002)
        XCTAssertEqual(state.normalizedRecordCount, 5001)
        _ = try store.applySessionUpdate(
            id: "s", metadata: nil,
            agentState: VersionedPayload(version: 2, cipher: "c", value: ChatRecords.permissionState()),
            projectId: nil)
        let permissionDelta = try store.chatPage(sessionId: "s", afterRowId: state.lastRowId)
        XCTAssertTrue(permissionDelta.records.isEmpty)
        XCTAssertEqual(state.apply(permissionDelta).messages.count, 5003)
        XCTAssertEqual(state.normalizedRecordCount, 5001)
        XCTAssertEqual(state.reducer.processedRecordCount, 5001)
    }

    @MainActor
    func testStreamObservesOutboxWritesAfterInitialSnapshot() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let initial = expectation(description: "initial"), updated = expectation(description: "outbox update")
        let task = Task {
            var first = true
            for await snapshot in LocalChatFeed(store: store).snapshots(sessionId: "s") {
                if first {
                    first = false
                    initial.fulfill()
                }
                if snapshot.delivery["l"] == .queued {
                    updated.fulfill()
                    break
                }
            }
        }
        await fulfillment(of: [initial], timeout: 2)
        try store.enqueue(
            OutboxRecord(
                localId: "l", kind: .message, sessionId: "s", payload: ChatRecords.user("l").raw,
                createdAt: 100))
        await fulfillment(of: [updated], timeout: 2)
        task.cancel()
    }

    @MainActor
    func testActivityAndUnrelatedMetadataUpdatesEmitNoNewSnapshot() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let initial = expectation(description: "initial")
        let churn = expectation(description: "no activity snapshot")
        churn.isInverted = true
        let task = Task {
            var first = true
            for await _ in LocalChatFeed(store: store).snapshots(sessionId: "s") {
                if first {
                    first = false
                    initial.fulfill()
                } else {
                    churn.fulfill()
                }
            }
        }
        await fulfillment(of: [initial], timeout: 2)
        let before = try store.chatPage(sessionId: "s").change
        try store.applySessionActivity(id: "s", active: true, activeAt: 200, thinking: true)
        _ = try store.applySessionUpdate(
            id: "s",
            metadata: VersionedPayload(
                version: 2, cipher: "c", value: .object(["path": .string("/different")])),
            agentState: nil, projectId: nil
        )
        XCTAssertEqual(try store.chatPage(sessionId: "s").change, before)
        // A higher permission version with the same contents also produces
        // no visible chat change, even though the projection changes.
        _ = try store.applySessionUpdate(
            id: "s", metadata: nil,
            agentState: VersionedPayload(version: 2, cipher: "new", value: nil),
            projectId: nil
        )
        await fulfillment(of: [churn], timeout: 0.2)
        task.cancel()
    }
}
