import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

/// Leaving and archiving a task go to its machine alone, over fake
/// transports: the server never archives or deletes a task, and its
/// machine's refusals are shown in its own words.
final class TaskActionsTests: XCTestCase {
    var fixture: ServerFixture!
    var http: FakeHTTP!
    var store: LocalStore!
    var engine: SyncEngine!
    var rpc: FakeRPC!
    var actions: SessionActions!
    var details: SessionDetailActions!

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        store = try LocalStore.inMemory()
        engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        rpc = FakeRPC()
        actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: rpc, now: { 500 })
        let machines = MachineActions(api: testAPI(http), store: store, sync: engine, rpc: rpc, metadataTransport: SessionDetailActionsTests.NoMetadata())
        details = SessionDetailActions(sessions: actions, machines: machines, store: store, sync: engine, metadataTransport: SessionDetailActionsTests.NoMetadata())
    }

    override func tearDown() async throws {
        await engine.stop()
    }

    @discardableResult
    private func storeTask(canArchive: Bool = false, archived: Bool = false, task: Bool = true) throws -> SessionRecord {
        var record = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("t", updatedAt: 1))
        var metadata: [String: JSONValue] = [
            "client": .object(["id": .string("rig")]),
            "capabilities": .object(["rpcMethods": .array([.string("killSession"), .string("leaveTask")])]),
        ]
        if task { metadata["task"] = .object(["id": .string("task1"), "name": .string("Launch"), "canArchive": .bool(canArchive)]) }
        if archived { metadata["lifecycleState"] = .string("archived") }
        record.metadata = .object(metadata)
        try store.upsertSessions([record])
        return try XCTUnwrap(try store.session(id: "t"))
    }

    private func answer(_ value: JSONValue) {
        let key = fixture.dataKey
        rpc.answer = { _ in RPCCallResult(ok: true, result: try RecordCipher(key: key).encrypt(value)) }
    }

    private var methods: [String] { rpc.calls.map(\.method) }

    private func archiving() throws -> Bool? { try store.session(id: "t")?.archiving }

    // MARK: Leave

    func testLeavingCallsLeaveTaskAndNothingElse() async throws {
        try storeTask(canArchive: true)
        answer(.object(["success": .bool(true)]))
        try await actions.leaveTask(sessionId: "t")
        XCTAssertEqual(methods, ["t:leaveTask"], "never killSession")
        XCTAssertEqual(RecordCipher(key: fixture.dataKey).decrypt(base64: rpc.calls[0].params), .object([:]))
        XCTAssertTrue(http.requests.isEmpty, "no server archive, no delete")
        XCTAssertEqual(try archiving(), true, "out of the list at once")
    }

    func testAnOlderHappyAgentSaysItCannotLeave() async throws {
        try storeTask()
        answer(.object(["error": .string("Method not found")]))
        do {
            try await actions.leaveTask(sessionId: "t")
            XCTFail("expected an error")
        } catch let error as SessionActionError {
            XCTAssertEqual(error, .failed(SessionActions.cannotLeaveTasks))
        }
        XCTAssertEqual(methods, ["t:leaveTask"])
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertEqual(try archiving(), false, "back in the list")
    }

    func testARefusedLeaveShowsTheMachinesWords() async throws {
        let record = try storeTask()
        answer(.object(["error": .string("This task is not available to this connection.")]))
        do {
            try await details.leaveTask(record)
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, "This task is not available to this connection.")
        }
        XCTAssertEqual(try archiving(), false)
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testAnUnreachableMachineCantBeLeftAndNothingFallsBack() async throws {
        let record = try storeTask()
        do {
            try await actions.leaveTask(sessionId: "t")
            XCTFail("expected an error")
        } catch let error as SessionActionError {
            XCTAssertEqual(error, .taskNeedsMachine)
        }
        do {
            try await details.leaveTask(record)
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, SessionDetailActions.taskLeaveMessage)
        }
        XCTAssertEqual(methods, ["t:leaveTask", "t:leaveTask"])
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertEqual(try archiving(), false)
    }

    func testOnlyATaskCanBeLeft() async throws {
        try storeTask(task: false)
        do {
            try await actions.leaveTask(sessionId: "t")
            XCTFail("expected an error")
        } catch let error as SessionActionError {
            XCTAssertEqual(error, .unknownSession)
        }
        XCTAssertTrue(rpc.calls.isEmpty)
    }

    // MARK: Archive

    func testTheOwnerArchivesThroughTheMachine() async throws {
        try storeTask(canArchive: true)
        answer(.object(["success": .bool(true)]))
        try await actions.archive(sessionId: "t")
        XCTAssertEqual(methods, ["t:killSession"])
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertEqual(try archiving(), true)
    }

    func testAForbiddenArchiveShowsTheMachinesWordsAndPutsTheRowBack() async throws {
        let refusal = "Only the task's owner or the team owner can archive this task."
        let record = try storeTask(canArchive: true)
        answer(.object(["error": .string(refusal)]))
        do {
            try await actions.archive(sessionId: "t")
            XCTFail("expected an error")
        } catch let error as SessionActionError {
            XCTAssertEqual(error, .failed(refusal))
        }
        do {
            try await details.archive(record, confirmWorktreeCleanup: { XCTFail("a task has no worktree to clean"); return false })
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, refusal)
        }
        XCTAssertEqual(methods, ["t:killSession", "t:killSession"])
        XCTAssertTrue(http.requests.isEmpty, "never archived on the server instead")
        XCTAssertEqual(try archiving(), false)
    }

    func testAnUnreachableMachineKeepsTheTask() async throws {
        let record = try storeTask(canArchive: true)
        do {
            try await details.archive(record, confirmWorktreeCleanup: { false })
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, SessionDetailActions.taskArchiveMessage)
        }
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertEqual(try archiving(), false)
    }

    /// Another session's machine that answers `{ error }` is still
    /// unreachable to it, and falls back to the server as before.
    func testOnlyATasksRefusalIsShown() async throws {
        try storeTask(task: false)
        answer(.object(["error": .string("nope")]))
        http.onRaw("POST /v1/sessions/t/archive", #"{"success":true}"#)
        try await actions.archive(sessionId: "t")
        XCTAssertEqual(http.requests("POST /v1/sessions/t/archive").count, 1)
    }

    // MARK: Never deleted

    func testATaskIsNeverDeletedLiveOrArchived() async throws {
        for archived in [false, true] {
            let record = try storeTask(canArchive: true, archived: archived)
            do {
                try await actions.delete(sessionId: "t")
                XCTFail("expected an error")
            } catch let error as SessionActionError {
                XCTAssertEqual(error, .taskNeedsMachine)
            }
            do {
                try await details.delete(record)
                XCTFail("expected an error")
            } catch let failure as SessionDetailActions.Failure {
                XCTAssertEqual(failure.message, SessionDetailActions.taskDeleteMessage)
            }
        }
        XCTAssertTrue(rpc.calls.isEmpty)
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertNotNil(try store.session(id: "t"))
    }
}
