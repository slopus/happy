import Foundation
import GRDB
import XCTest
@testable import HappyStore
import HappyWire

func makeSession(
    _ id: String,
    seq: Int = 0,
    updatedAt: Int64 = 100,
    metadataVersion: Int = 1,
    metadata: JSONValue? = .object(["path": .string("/a")]),
    agentStateVersion: Int = 0,
    decryptable: Bool = true
) -> SessionRecord {
    SessionRecord(
        id: id, seq: seq, createdAt: 1, updatedAt: updatedAt, active: true, activeAt: updatedAt,
        projectId: nil, metadataVersion: metadataVersion, metadataCipher: "cipher-\(metadataVersion)", metadata: metadata,
        agentStateVersion: agentStateVersion, agentStateCipher: nil, agentState: nil,
        dataKeyCipher: decryptable ? "wrapped" : nil, decryptable: decryptable
    )
}

func makeMessage(_ sessionId: String, seq: Int, localId: String? = nil) -> MessageRecord {
    MessageRecord(
        id: "\(sessionId)-m\(seq)", sessionId: sessionId, seq: seq, localId: localId,
        createdAt: Int64(1000 + seq), updatedAt: Int64(1000 + seq), contentCipher: "c\(seq)", content: .object(["n": .number(Double(seq))])
    )
}

final class LocalStoreTests: XCTestCase {
    var store: LocalStore!

    override func setUpWithError() throws {
        store = try LocalStore.inMemory()
    }

    func testSessionUpsertOnlyMovesVersionsForward() throws {
        try store.upsertSessions([makeSession("s", updatedAt: 100, metadataVersion: 3, metadata: .string("v3"))])
        // An older snapshot (e.g. a delayed page) must not roll metadata back.
        try store.upsertSessions([makeSession("s", updatedAt: 90, metadataVersion: 2, metadata: .string("v2"))])
        var session = try XCTUnwrap(try store.session(id: "s"))
        XCTAssertEqual(session.metadata, .string("v3"))
        XCTAssertEqual(session.updatedAt, 100)

        try store.upsertSessions([makeSession("s", seq: 4, updatedAt: 120, metadataVersion: 4, metadata: .string("v4"))])
        session = try XCTUnwrap(try store.session(id: "s"))
        XCTAssertEqual(session.metadata, .string("v4"))
        XCTAssertEqual(session.metadataCipher, "cipher-4")
        XCTAssertEqual(session.seq, 4)
        XCTAssertEqual(session.syncedMessageSeq, 0, "a list fetch never claims messages were synced")
    }

    func testSessionUpdateAppliesNewerFieldsIndependently() throws {
        try store.upsertSessions([makeSession("s", metadataVersion: 5, agentStateVersion: 5)])
        let applied = try store.applySessionUpdate(
            id: "s",
            metadata: VersionedPayload(version: 4, cipher: "old", value: .string("old")),
            agentState: VersionedPayload(version: 6, cipher: "new", value: .string("new")),
            projectId: .some("p1")
        )
        XCTAssertTrue(applied)
        let session = try XCTUnwrap(try store.session(id: "s"))
        XCTAssertEqual(session.metadataVersion, 5)
        XCTAssertEqual(session.agentState, .string("new"))
        XCTAssertEqual(session.projectId, "p1")
        XCTAssertFalse(try store.applySessionUpdate(id: "missing", metadata: nil, agentState: nil, projectId: nil))
    }

    func testLiveMessagesAdvanceCursorOnlyWhenContiguous() throws {
        try store.upsertSessions([makeSession("s")])
        XCTAssertEqual(try store.applyLiveMessage(makeMessage("s", seq: 1)), .applied)
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 1)

        XCTAssertEqual(try store.applyLiveMessage(makeMessage("s", seq: 3)), .gap)
        var session = try XCTUnwrap(try store.session(id: "s"))
        XCTAssertEqual(session.syncedMessageSeq, 1, "the gap at seq 2 must be filled by a delta fetch")
        XCTAssertEqual(session.seq, 3)
        XCTAssertTrue(session.hasUnsyncedMessages)

        // Replays are harmless.
        XCTAssertEqual(try store.applyLiveMessage(makeMessage("s", seq: 1)), .applied)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [1, 3])

        XCTAssertEqual(try store.applyLiveMessage(makeMessage("nope", seq: 1)), .unknownSession)

        try store.applyMessagePage(sessionId: "s", messages: [makeMessage("s", seq: 2), makeMessage("s", seq: 3)], syncedThrough: 3)
        session = try XCTUnwrap(try store.session(id: "s"))
        XCTAssertEqual(session.syncedMessageSeq, 3)
        XCTAssertFalse(session.hasUnsyncedMessages)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.seq), [1, 2, 3])
    }

    func testMessagePagingReadsNewestPageInAscendingOrder() throws {
        try store.upsertSessions([makeSession("s")])
        try store.applyMessagePage(sessionId: "s", messages: (1...10).map { makeMessage("s", seq: $0) })
        XCTAssertEqual(try store.messages(sessionId: "s", limit: 3).map(\.seq), [8, 9, 10])
        XCTAssertEqual(try store.messages(sessionId: "s", limit: 3, beforeSeq: 8).map(\.seq), [5, 6, 7])
    }

    func testSyncedThroughCoversBurnedSeqs() throws {
        try store.upsertSessions([makeSession("s", seq: 5)])
        try store.applyMessagePage(sessionId: "s", messages: [makeMessage("s", seq: 1), makeMessage("s", seq: 3)], syncedThrough: 5)
        XCTAssertEqual(try store.session(id: "s")?.syncedMessageSeq, 5)
        XCTAssertEqual(try store.sessionsNeedingMessageSync().count, 0)
    }

    func testSessionsNeedingMessageSyncSkipsUndecryptable() throws {
        try store.upsertSessions([
            makeSession("a", seq: 2, updatedAt: 10),
            makeSession("b", seq: 2, updatedAt: 20),
            makeSession("legacy", seq: 9, updatedAt: 30, decryptable: false),
            makeSession("done", seq: 0, updatedAt: 40),
        ])
        XCTAssertEqual(try store.sessionsNeedingMessageSync().map(\.id), ["b", "a"])
    }

    func testDeletingASessionDeletesItsMessages() throws {
        try store.upsertSessions([makeSession("s")])
        try store.applyMessagePage(sessionId: "s", messages: [makeMessage("s", seq: 1)])
        try store.deleteSession(id: "s")
        XCTAssertNil(try store.session(id: "s"))
        let count = try store.writer.read { db in try MessageRecord.fetchCount(db) }
        XCTAssertEqual(count, 0)
    }

    func testReconciliationKeepsSessionsNewerThanTheCutoff() throws {
        try store.upsertSessions([
            makeSession("kept", updatedAt: 10),
            makeSession("gone", updatedAt: 10),
            makeSession("arrived-during-pass", updatedAt: 99),
        ])
        let removed = try store.retainSessions(ids: ["kept"], updatedAtOrBefore: 50)
        XCTAssertEqual(removed, 1)
        XCTAssertEqual(Set(try store.sessions().map(\.id)), ["kept", "arrived-during-pass"])
    }

    func testOutboxEntryIsClearedWhenItsMessageArrives() throws {
        try store.upsertSessions([makeSession("s")])
        try store.enqueue(OutboxRecord(localId: "L1", kind: .message, sessionId: "s", payload: .string("hi"), createdAt: 1))
        try store.enqueue(OutboxRecord(localId: "L1", kind: .message, sessionId: "s", payload: .string("dup"), createdAt: 2))
        XCTAssertEqual(try store.pendingOutbox().map(\.payload), [.string("hi")])

        try store.markOutboxFailed(localId: "L1", error: "offline")
        XCTAssertEqual(try store.pendingOutbox().first?.attempts, 1)

        _ = try store.applyLiveMessage(makeMessage("s", seq: 1, localId: "L1"))
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
    }

    func testMachinesReplaceRemovesMissingAndKeepsNewerState() throws {
        func machine(_ id: String, version: Int, activeAt: Int64) -> MachineRecord {
            MachineRecord(
                id: id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: activeAt,
                metadataVersion: version, metadataCipher: "c", metadata: .number(Double(version)),
                daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
            )
        }
        try store.replaceMachines([machine("a", version: 1, activeAt: 1), machine("b", version: 1, activeAt: 1)])
        XCTAssertTrue(try store.applyMachineUpdate(
            id: "a", metadata: VersionedPayload(version: 3, cipher: "c3", value: .number(3)), daemonState: nil, active: false, activeAt: 50
        ))
        try store.replaceMachines([machine("a", version: 2, activeAt: 10)])
        let machines = try store.machines()
        XCTAssertEqual(machines.map(\.id), ["a"])
        XCTAssertEqual(machines.first?.metadata, .number(3))
        XCTAssertEqual(machines.first?.activeAt, 50)
        XCTAssertEqual(machines.first?.active, false)
    }

    func testMachinesSnapshotKnowsWhetherMachinesWereFetched() throws {
        func machine(_ id: String, createdAt: Int64) -> MachineRecord {
            MachineRecord(
                id: id, seq: 0, createdAt: createdAt, updatedAt: 1, active: false, activeAt: 1,
                metadataVersion: 1, metadataCipher: "c", metadata: nil,
                daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
            )
        }
        // An empty, never-fetched store is "not known", not "no machines".
        XCTAssertEqual(try store.machinesSnapshot(), MachinesSnapshot(synced: false, machines: []))

        try store.replaceMachines([machine("old", createdAt: 1), machine("new", createdAt: 5)])
        try store.setCursor(.machinesLastSync, 10)
        let snapshot = try store.machinesSnapshot()
        XCTAssertTrue(snapshot.synced)
        XCTAssertEqual(snapshot.machines.map(\.id), ["new", "old"], "newest first, like useAllMachines")

        try store.eraseAll()
        XCTAssertFalse(try store.machinesSnapshot().synced)
    }

    func testAccountSettingsKeepHighestVersion() throws {
        XCTAssertTrue(try store.applyAccountSettings(AccountSettingsRecord(version: 2, cipher: "c2", settings: .string("two"))))
        XCTAssertFalse(try store.applyAccountSettings(AccountSettingsRecord(version: 1, cipher: "c1", settings: .string("one"))))
        XCTAssertEqual(try store.accountSettings()?.settings, .string("two"))
    }

    func testCursorsAndErase() throws {
        XCTAssertNil(try store.cursor(.sessionsChangedSince))
        try store.setCursor(.sessionsChangedSince, 42)
        XCTAssertEqual(try store.cursor(.sessionsChangedSince), 42)
        try store.upsertSessions([makeSession("s")])
        try store.eraseAll()
        XCTAssertNil(try store.cursor(.sessionsChangedSince))
        XCTAssertTrue(try store.sessions().isEmpty)
    }

    func testOnDiskStoreReopensWithData() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("happy-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("store.sqlite")
        do {
            let first = try LocalStore.open(at: url)
            try first.upsertSessions([makeSession("persisted")])
        }
        let reopened = try LocalStore.open(at: url)
        XCTAssertEqual(try reopened.sessions().map(\.id), ["persisted"])
    }
}
