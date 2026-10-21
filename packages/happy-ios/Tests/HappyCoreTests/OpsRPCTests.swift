import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

actor FakeMetadataTransport: MetadataUpdateTransport {
    var calls: [(String, JSONValue)] = []
    let replies: [JSONValue]
    let onFirstCall: @Sendable () async throws -> Void
    init(_ replies: [JSONValue], onFirstCall: @escaping @Sendable () async throws -> Void = {}) {
        self.replies = replies
        self.onFirstCall = onFirstCall
    }
    func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue {
        calls.append((event, payload))
        if calls.count == 1 { try await onFirstCall() }
        return replies[min(calls.count - 1, replies.count - 1)]
    }
}

final class OpsRPCTests: XCTestCase {
    var fixture: ServerFixture!
    var http: FakeHTTP!
    var store: LocalStore!
    var sync: SyncEngine!
    var rpc: FakeRPC!
    var sessions: SessionActions!
    var machines: MachineActions!

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        store = try LocalStore.inMemory()
        sync = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, now: { 500 })
        rpc = FakeRPC()
        sessions = SessionActions(api: testAPI(http), store: store, sync: sync, rpc: rpc, now: { 500 })
        machines = MachineActions(api: testAPI(http), store: store, sync: sync, rpc: rpc, metadataTransport: FakeMetadataTransport([.null]))
        var record = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", seq: 7, updatedAt: 1))
        record.metadata = .object(["machineId": .string("m"), "path": .string("/repo"), "unknown": .array([.number(7)]), "modelMode": .string("old")])
        try store.upsertSessions([record])
        // Machine key differs from the session key: pins the RPC encryption scope.
        let machineKey = Data(repeating: 21, count: 32)
        try store.upsertMachine(MachineRecord(
            id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadataVersion: 1,
            metadataCipher: "", metadata: .object(["host": .string("host")]), daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil,
            dataKeyCipher: Base64.encode(try fixture.keys.wrapDataKey(machineKey)), decryptable: true
        ))
    }

    override func tearDown() async throws { await sync.stop() }

    func answer(_ value: JSONValue, machine: Bool = false) {
        let key = machine ? Data(repeating: 21, count: 32) : fixture.dataKey
        rpc.answer = { _ in RPCCallResult(ok: true, result: try RecordCipher(key: key).encrypt(value)) }
    }

    func assertLast(_ method: String, _ params: JSONValue, machine: Bool = false, file: StaticString = #filePath, line: UInt = #line) throws {
        let call = try XCTUnwrap(rpc.calls.last, file: file, line: line)
        XCTAssertEqual(call.method, method, file: file, line: line)
        let key = machine ? Data(repeating: 21, count: 32) : fixture.dataKey
        XCTAssertEqual(RecordCipher(key: key).decrypt(base64: call.params), params, file: file, line: line)
        if machine { XCTAssertNil(RecordCipher(key: fixture.dataKey).decrypt(base64: call.params)) }
    }

    func testSwitchAndGoalPayloads() async throws {
        answer(.bool(true))
        let changed = try await sessions.sessionSwitch(sessionId: "s", to: .remote)
        XCTAssertTrue(changed)
        try assertLast("s:switch", .object(["to": .string("remote")]))
        answer(.null)
        try await sessions.sessionGoalAction(sessionId: "s", action: .clear)
        try assertLast("s:goal-action", .object(["action": .string("clear")]))
        try await sessions.sessionGoalAction(sessionId: "s", action: .edit, objective: "")
        try assertLast("s:goal-action", .object(["action": .string("edit"), "objective": .string("")]))
    }

    func testBashPayloadAndOfflineResult() async throws {
        answer(.object(["success": .bool(true), "stdout": .string("out"), "stderr": .string(""), "exitCode": .number(0)]))
        let response = try await sessions.sessionBash(sessionId: "s", request: SessionBashRequest(command: "pwd", cwd: "/repo", timeout: 10000))
        XCTAssertEqual(response.stdout, "out")
        try assertLast("s:bash", .object(["command": .string("pwd"), "cwd": .string("/repo"), "timeout": .number(10000)]))
        rpc.answer = { _ in RPCCallResult(ok: false, error: "offline") }
        let failed = try await sessions.sessionBash(sessionId: "s", request: SessionBashRequest(command: "pwd"))
        XCTAssertEqual(failed.exitCode, -1)
        XCTAssertEqual(failed.error, "offline")
    }

    func testReadAndWritePreserveBase64AndHashPresence() async throws {
        answer(.object(["success": .bool(true), "content": .string("AAEC/w==")]))
        let file = try await sessions.sessionReadFile(sessionId: "s", path: "space path")
        XCTAssertEqual(file.content, "AAEC/w==")
        try assertLast("s:readFile", .object(["path": .string("space path")]))
        answer(.object(["success": .bool(true), "hash": .string("hash")]))
        _ = try await sessions.sessionWriteFile(sessionId: "s", path: "a", content: "AAEC/w==")
        try assertLast("s:writeFile", .object(["path": .string("a"), "content": .string("AAEC/w==")]))
        _ = try await sessions.sessionWriteFile(sessionId: "s", path: "a", content: "", expectedHash: .null)
        try assertLast("s:writeFile", .object(["path": .string("a"), "content": .string(""), "expectedHash": .null]))
        _ = try await sessions.sessionWriteFile(sessionId: "s", path: "a", content: "", expectedHash: .string("old"))
        try assertLast("s:writeFile", .object(["path": .string("a"), "content": .string(""), "expectedHash": .string("old")]))
    }

    func testDirectoryTreeAndSearchPayloads() async throws {
        answer(.object(["success": .bool(true), "entries": .array([.object(["name": .string("x"), "type": .string("other"), "size": .number(8), "modified": .number(9)])])]))
        let directory = try await sessions.sessionListDirectory(sessionId: "s", path: ".")
        XCTAssertEqual(directory.entries?.first?.type, .other)
        try assertLast("s:listDirectory", .object(["path": .string(".")]))
        answer(.object(["success": .bool(true), "tree": .object(["name": .string("root"), "path": .string("/repo"), "type": .string("directory"), "children": .array([])])]))
        let tree = try await sessions.sessionGetDirectoryTree(sessionId: "s", path: "/repo", maxDepth: 3)
        XCTAssertEqual(tree.tree?.children, [])
        try assertLast("s:getDirectoryTree", .object(["path": .string("/repo"), "maxDepth": .number(3)]))
        answer(.object(["success": .bool(true), "exitCode": .number(1), "stdout": .string("")]))
        _ = try await sessions.sessionRipgrep(sessionId: "s", args: ["--files", "a b"], cwd: "/repo")
        try assertLast("s:ripgrep", .object(["args": .array([.string("--files"), .string("a b")]), "cwd": .string("/repo")]))
    }

    func testKillAndAvatarValidation() async throws {
        answer(.object(["success": .bool(true), "message": .string("stopped")]))
        let result = try await sessions.sessionKill(sessionId: "s")
        XCTAssertEqual(result.message, "stopped")
        try assertLast("s:killSession", .object([:]))
        try await sessions.sessionSetAvatar(sessionId: "s", picture: SessionAvatarPicture(ref: "ref", size: 99, mimeType: .webp))
        try assertLast("s:setAvatar", .object(["ref": .string("ref"), "size": .number(99), "mimeType": .string("image/webp")]))
        answer(.object(["success": .bool(false), "error": .string("bad picture")]))
        do {
            try await sessions.sessionSetAvatar(sessionId: "s", picture: SessionAvatarPicture(ref: "ref", size: 99, mimeType: .png))
            XCTFail("should reject failed acknowledgement")
        } catch { XCTAssertEqual(error as? SessionActionError, .failed("bad picture")) }
    }

    func testPermissionsCommunicationsAndAbortExactPayloads() async throws {
        answer(.null)
        try await sessions.allow(
            sessionId: "s", permissionId: "p", mode: "plan", allowedTools: ["Bash"], decision: .approvedForSession,
            updatedInput: .object(["command": .string("pwd")])
        )
        try assertLast("s:permission", .object([
            "id": .string("p"), "approved": .bool(true), "mode": .string("plan"), "allowTools": .array([.string("Bash")]),
            "decision": .string("approved_for_session"), "updatedInput": .object(["command": .string("pwd")]),
        ]))
        try await sessions.deny(sessionId: "s", permissionId: "p", decision: .abort)
        try assertLast("s:permission", .object(["id": .string("p"), "approved": .bool(false), "decision": .string("abort")]))
        try await sessions.answerQuestion(sessionId: "s", id: "q", answers: .object(["q1": .string("yes")]), kind: "input")
        try assertLast("s:communication", .object(["id": .string("q"), "kind": .string("input"), "status": .string("answered"), "answers": .object(["q1": .string("yes")])]))
        try await sessions.cancelQuestion(sessionId: "s", id: "q")
        try assertLast("s:communication", .object(["id": .string("q"), "kind": .string("form"), "status": .string("cancelled")]))
        try await sessions.abort(sessionId: "s")
        try assertLast("s:abort", .object(["reason": .string(SessionActions.abortReason)]))
    }

    func testRigCapabilitiesRefuseUnadvertisedCalls() async throws {
        var session = try XCTUnwrap(store.session(id: "s"))
        session.metadata = .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "capabilities": .object(["shell": .bool(true), "rpcMethods": .array([])]),
        ])
        session.metadataVersion += 1
        try store.upsertSessions([session])
        let result = try await sessions.sessionBash(sessionId: "s", request: SessionBashRequest(command: "pwd"))
        XCTAssertFalse(result.success)
        XCTAssertTrue(rpc.calls.isEmpty)
        do {
            try await sessions.abort(sessionId: "s")
            XCTFail("must refuse")
        } catch {}
        session.metadata = .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "capabilities": .object(["abort": .bool(true), "rpcMethods": .array([.string("abort")])]),
        ])
        session.metadataVersion += 1
        try store.upsertSessions([session])
        answer(.null)
        try await sessions.abort(sessionId: "s")
        try assertLast("s:abort", .object([:]))
    }

    func testFlavorSpawnOmitsRigFieldsAndPreservesLineage() async throws {
        answer(.object(["type": .string("success"), "sessionId": .string("new")]), machine: true)
        var options = SpawnSessionOptions(machineId: "m", directory: "/repo", agent: "claude")
        options.token = "t"
        options.permissionMode = "auto"
        options.modelMode = "model"
        options.effortLevel = "high"
        options.resumeClaudeSessionId = "backend"
        options.parentSessionId = "s"
        options.forkedFromMessageId = "msg"
        options.isSideChat = false
        options.providerId = "should omit"
        let result = await machines.machineSpawnNewSession(options: options)
        XCTAssertEqual(result, .success(sessionId: "new"))
        try assertLast("m:spawn-happy-session", .object([
            "type": .string("spawn-in-directory"), "directory": .string("/repo"), "approvedNewDirectoryCreation": .bool(false),
            "agent": .string("claude"), "token": .string("t"), "permissionMode": .string("auto"), "modelMode": .string("model"),
            "effortLevel": .string("high"), "resumeClaudeSessionId": .string("backend"), "parentSessionId": .string("s"),
            "forkedFromMessageId": .string("msg"), "isSideChat": .bool(false),
        ]), machine: true)
    }

    func testRigSpawnCatalogAndPendingResult() async throws {
        var options = SpawnSessionOptions(machineId: "m", directory: "/repo", agent: "rig")
        let refused = await machines.machineSpawnNewSession(options: options)
        XCTAssertEqual(refused, .error(errorMessage: "Rig session creation requires a client request ID"))
        XCTAssertTrue(rpc.calls.isEmpty)
        options.clientRequestId = "request"
        options.permissionMode = "ask"
        options.providerId = "provider"
        options.modelId = "model"
        options.effortLevel = "high"
        options.token = "omit"
        answer(.object(["type": .string("pending"), "clientRequestId": .string("request"), "retryAfterMs": .number(250)]), machine: true)
        let pending = await machines.machineSpawnNewSession(options: options)
        XCTAssertEqual(pending, .pending(clientRequestId: "request", retryAfterMs: 250))
        try assertLast("m:spawn-happy-session", .object([
            "type": .string("spawn-in-directory"), "directory": .string("/repo"), "approvedNewDirectoryCreation": .bool(false),
            "agent": .string("rig"), "clientRequestId": .string("request"), "permissionMode": .string("ask"),
            "providerId": .string("provider"), "modelId": .string("model"), "effort": .string("high"),
        ]), machine: true)
        options.happyAgentTarget = .object(["type": .string("project"), "projectId": .string("project")])
        options.effort = "low"
        _ = await machines.machineSpawnNewSession(options: options)
        try assertLast("m:spawn-happy-session", .object([
            "type": .string("happy-agent-spawn"), "clientRequestId": .string("request"), "target": options.happyAgentTarget!,
            "agentConfiguration": .object([
                "type": .string("happy-agent"), "permissionMode": .string("ask"), "providerId": .string("provider"),
                "modelId": .string("model"), "effort": .string("low"),
            ]),
        ]), machine: true)
    }

    func testSpawnNormalizationDirectoryAndErrors() {
        XCTAssertEqual(
            MachineActions.normalizeSpawnSessionResult(.object([
                "type": .string("requestToApproveDirectoryCreation"), "directory": .string("/new"),
            ])), .requestToApproveDirectoryCreation(directory: "/new")
        )
        XCTAssertEqual(
            MachineActions.normalizeSpawnSessionResult(.object(["type": .string("error"), "message": .string("legacy refusal")])),
            .error(errorMessage: "legacy refusal")
        )
        XCTAssertEqual(
            MachineActions.normalizeSpawnSessionResult(.object(["type": .string("error"), "errorMessage": .string("")])),
            .error(errorMessage: "Failed to spawn session")
        )
        XCTAssertEqual(MachineActions.normalizeSpawnSessionResult(.null), .error(errorMessage: "The machine answered with something Happy could not read."))
    }

    func testResumeFallbackOnlySendsDataKeyToOwningMachine() async throws {
        answer(.object(["type": .string("success"), "sessionId": .string("s")]), machine: true)
        _ = await machines.machineResumeSession(machineId: "m", sessionId: "s", model: "model", permissionMode: "auto")
        let call = try XCTUnwrap(rpc.calls.last)
        let params = try XCTUnwrap(RecordCipher(key: Data(repeating: 21, count: 32)).decrypt(base64: call.params))
        XCTAssertEqual(call.method, "m:resume-happy-session")
        XCTAssertEqual(params, .object([
            "sessionId": .string("s"), "model": .string("model"), "permissionMode": .string("auto"), "fallbackReason": .string("ok"),
            "fallback": .object([
                "metadata": try XCTUnwrap(store.session(id: "s")?.metadata), "metadataVersion": .number(1),
                "agentStateVersion": .number(0), "seq": .number(7), "encryptionKey": .string(fixture.dataKey.base64EncodedString()),
                "encryptionVariant": .string("dataKey"),
            ]),
        ]))
        var record = try XCTUnwrap(store.session(id: "s"))
        record.metadata = .object(["machineId": .string("other")])
        record.metadataVersion += 1
        try store.upsertSessions([record])
        _ = await machines.machineResumeSession(machineId: "m", sessionId: "s")
        try assertLast("m:resume-happy-session", .object(["sessionId": .string("s"), "fallbackReason": .string("client-session-machine-mismatch")]), machine: true)
        _ = await machines.machineResumeSession(machineId: "m", sessionId: "missing")
        try assertLast("m:resume-happy-session", .object(["sessionId": .string("missing"), "fallbackReason": .string("client-has-no-session-row")]), machine: true)
        var legacy = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("legacy", updatedAt: 1, withKey: false))
        legacy.metadata = .object(["machineId": .string("m")])
        try store.upsertSessions([legacy])
        _ = await machines.machineResumeSession(machineId: "m", sessionId: "legacy")
        try assertLast("m:resume-happy-session", .object(["sessionId": .string("legacy"), "fallbackReason": .string("client-has-no-data-key")]), machine: true)
    }

    func testMachineStopBashAndDelete() async throws {
        answer(.object(["message": .string("stopped")]), machine: true)
        let stopped = await machines.machineStopSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(stopped.success)
        try assertLast("m:stop-session", .object(["sessionId": .string("s")]), machine: true)
        _ = try await machines.machineStopDaemon(machineId: "m")
        try assertLast("m:stop-daemon", .object([:]), machine: true)
        answer(.object(["success": .bool(true), "stdout": .string("out"), "stderr": .string(""), "exitCode": .number(0)]), machine: true)
        _ = try await machines.machineBash(machineId: "m", command: "pwd", cwd: "/repo")
        try assertLast("m:bash", .object(["command": .string("pwd"), "cwd": .string("/repo")]), machine: true)
        http.onRaw("DELETE /v1/machines/m", #"{"success":true}"#)
        let deleted = await machines.machineDelete(machineId: "m")
        XCTAssertTrue(deleted.success)
        XCTAssertNil(try store.machine(id: "m"))
        XCTAssertNotNil(try store.session(id: "s"))
    }

    func testForkAndRewindMethodPayloads() async throws {
        let claude = ClaudeForkSessionOptions(machineId: "m", directory: "/repo", claudeSessionId: "claude")
        answer(.object(["type": .string("success"), "newClaudeSessionId": .string("copy")]), machine: true)
        _ = await machines.claudeForkSession(options: claude)
        try assertLast("m:claude-fork-session", .object(["directory": .string("/repo"), "claudeSessionId": .string("claude")]), machine: true)
        _ = await machines.claudeDuplicateSession(options: claude, cutAfterUuid: "cut")
        try assertLast("m:claude-duplicate-session", .object(["directory": .string("/repo"), "claudeSessionId": .string("claude"), "cutAfterUuid": .string("cut")]), machine: true)
        answer(.object(["type": .string("success"), "points": .array([.object(["uuid": .string("cut"), "text": .string("hello"), "timestamp": .number(7)])])]), machine: true)
        let rewind = await machines.claudeListRewindPoints(options: claude)
        if case .success(let points) = rewind { XCTAssertEqual(points.first?.uuid, "cut") } else { XCTFail("points") }
        try assertLast("m:claude-list-rewind-points", .object(["directory": .string("/repo"), "claudeSessionId": .string("claude")]), machine: true)
        let codex = CodexForkThreadOptions(machineId: "m", directory: "/repo", codexThreadId: "thread")
        answer(.object(["type": .string("success"), "newCodexThreadId": .string("copy")]), machine: true)
        _ = await machines.codexForkThread(options: codex)
        try assertLast("m:codex-fork-thread", .object(["directory": .string("/repo"), "codexThreadId": .string("thread")]), machine: true)
        _ = await machines.codexDuplicateThread(options: codex, cutAfterItemId: "cut")
        try assertLast("m:codex-duplicate-thread", .object(["directory": .string("/repo"), "codexThreadId": .string("thread"), "cutAfterItemId": .string("cut")]), machine: true)
        answer(.object(["type": .string("success"), "points": .array([.object(["itemId": .string("cut"), "text": .string("hello"), "timestamp": .number(8)])])]), machine: true)
        _ = await machines.codexListRewindPoints(options: codex)
        try assertLast("m:codex-list-rewind-points", .object(["directory": .string("/repo"), "codexThreadId": .string("thread")]), machine: true)
    }

    func testSideChatAndDuplicateSpawnLineage() async throws {
        let key = Data(repeating: 21, count: 32)
        rpc.answer = { method in
            let response: JSONValue = method.hasSuffix("spawn-happy-session")
                ? .object(["type": .string("success"), "sessionId": .string("new")])
                : .object(["type": .string("success"), "newClaudeSessionId": .string("copy"), "newCodexThreadId": .string("copy")])
            return RPCCallResult(ok: true, result: try RecordCipher(key: key).encrypt(response))
        }
        http.onRaw("GET /v2/sessions", #"{"sessions":[],"hasNext":false}"#)
        let source = ForkSource.claude(sessionId: "s", options: ClaudeForkSessionOptions(machineId: "m", directory: "/repo", claudeSessionId: "backend"))
        _ = await machines.spawnSideChat(source: source)
        try assertLast("m:spawn-happy-session", .object([
            "type": .string("spawn-in-directory"), "directory": .string("/repo"), "approvedNewDirectoryCreation": .bool(false),
            "agent": .string("claude"), "resumeClaudeSessionId": .string("copy"), "parentSessionId": .string("s"),
            "isSideChat": .bool(true),
        ]), machine: true)
        let codex = ForkSource.codex(sessionId: "s", options: CodexForkThreadOptions(machineId: "m", directory: "/repo", codexThreadId: "thread"))
        _ = await machines.forkAndSpawn(source: codex, options: ForkOptions(cutAfterItemId: "cut", forkedFromMessageId: "msg"))
        try assertLast("m:spawn-happy-session", .object([
            "type": .string("spawn-in-directory"), "directory": .string("/repo"), "approvedNewDirectoryCreation": .bool(false),
            "agent": .string("codex"), "resumeCodexThreadId": .string("copy"), "parentSessionId": .string("s"),
            "forkedFromMessageId": .string("msg"),
        ]), machine: true)
        XCTAssertTrue(rpc.calls.contains { $0.method == "m:codex-duplicate-thread" })
        XCTAssertEqual(http.requests("GET /v2/sessions").count, 2)
    }

    func testSessionModeRetryPreservesUnknownFieldsAndClearsWithNull() async throws {
        let latest: JSONValue = .object(["machineId": .string("m"), "unknown": .array([.number(99)]), "modelMode": .string("remote")])
        let final = JSONValue.object(latest.objectValue!.merging(["modelMode": .null, "permissionMode": .string("auto")]) { _, v in v })
        let transport = FakeMetadataTransport([
            .object(["result": .string("version-mismatch"), "version": .number(2), "metadata": .string(fixture.seal(latest))]),
            .object(["result": .string("success"), "version": .number(3), "metadata": .string(fixture.seal(final))]),
        ])
        try await sessions.sessionSetAgentModes(sessionId: "s", patch: SessionAgentModesPatch(permissionMode: .string("auto"), modelMode: .null), transport: transport)
        let calls = await transport.calls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].0, "update-metadata")
        XCTAssertEqual(calls[0].1["sid"], .string("s"))
        XCTAssertEqual(calls[1].1["expectedVersion"], .number(2))
        let sealed = try XCTUnwrap(calls[1].1["metadata"]?.stringValue)
        XCTAssertEqual(RecordCipher(key: fixture.dataKey).decrypt(base64: sealed), final)
        XCTAssertEqual(try store.session(id: "s")?.metadata, final)
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .null)
    }

    func testMachineMetadataRetryKeepsOnlyIntendedDisplayName() async throws {
        let cipher = RecordCipher(key: Data(repeating: 21, count: 32))
        let latest: JSONValue = .object(["host": .string("new-host"), "unknown": .number(9), "displayName": .string("old")])
        let final: JSONValue = .object(["host": .string("new-host"), "unknown": .number(9), "displayName": .string("name")])
        let transport = FakeMetadataTransport([
            .object(["result": .string("version-mismatch"), "version": .number(4), "metadata": .string(try cipher.encrypt(latest))]),
            .object(["result": .string("success"), "version": .number(5), "metadata": .string(try cipher.encrypt(final))]),
        ])
        let actions = MachineActions(api: testAPI(http), store: store, sync: sync, rpc: rpc, metadataTransport: transport)
        let result = try await actions.machineUpdateMetadata(machineId: "m", metadata: .object(["host": .string("stale"), "displayName": .string("name")]), expectedVersion: 1)
        XCTAssertEqual(result.version, 5)
        let calls = await transport.calls
        XCTAssertEqual(calls[0].0, "machine-update-metadata")
        XCTAssertEqual(calls[0].1["machineId"], .string("m"))
        XCTAssertEqual(calls[1].1["expectedVersion"], .number(4))
        XCTAssertEqual(cipher.decrypt(base64: try XCTUnwrap(calls[1].1["metadata"]?.stringValue)), final)
        XCTAssertEqual(try store.machine(id: "m")?.metadata, final)
    }

    func testRigModePatchWritesWholeDraftAndAdoptsNewerRemoteStamp() async throws {
        var session = try XCTUnwrap(store.session(id: "s"))
        let metadata: JSONValue = .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1), "unknown": .number(9),
            "draft": .object([
                "text": .string("old"), "providerId": .string("p"), "modelId": .string("old"), "effort": .string("high"),
                "permissionMode": .string("ask"), "serviceTier": .string("fast"),
            ]),
            "draftUpdatedAt": .number(10),
            "models": .array([.object([
                "providerId": .string("p"), "id": .string("new"), "thinkingLevels": .array([.string("low")]),
                "defaultThinkingLevel": .string("low"), "serviceTiers": .array([]),
            ])]),
        ])
        session.metadata = metadata
        session.metadataVersion = 2
        try store.upsertSessions([session])
        try store.saveDraft(sessionId: "s", text: "new text", at: 20)
        let draft: JSONValue = .object([
            "text": .string("new text"), "providerId": .string("p"), "modelId": .string("new"), "effort": .string("low"),
            "serviceTier": .null, "permissionMode": .string("auto"),
        ])
        var final = metadata.objectValue!
        final["draft"] = draft
        final["draftUpdatedAt"] = .number(500)
        let transport = FakeMetadataTransport([.object(["result": .string("success"), "version": .number(3), "metadata": .string(fixture.seal(.object(final)))])])
        try await sessions.sessionSetAgentModes(
            sessionId: "s", patch: SessionAgentModesPatch(permissionMode: .string("auto"), modelMode: .string("p:new"), effortLevel: .null),
            transport: transport
        )
        let calls = await transport.calls
        XCTAssertEqual(calls[0].1["expectedVersion"], .number(2))
        XCTAssertEqual(RecordCipher(key: fixture.dataKey).decrypt(base64: try XCTUnwrap(calls[0].1["metadata"]?.stringValue)), .object(final))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["effortLevel"], .string("low"))
        var remote = final
        remote["draftUpdatedAt"] = .number(900)
        remote["draft"] = .object([
            "text": .string("remote text"), "providerId": .string("p"), "modelId": .string("remote"), "effort": .string("medium"),
            "serviceTier": .null, "permissionMode": .string("ask"),
        ])
        let conflict = FakeMetadataTransport([.object(["result": .string("version-mismatch"), "version": .number(4), "metadata": .string(fixture.seal(.object(remote)))])])
        try await sessions.sessionSetAgentModes(sessionId: "s", patch: SessionAgentModesPatch(permissionMode: .string("local")), transport: conflict)
        let conflicts = await conflict.calls
        XCTAssertEqual(conflicts.count, 1)
        XCTAssertEqual(try store.session(id: "s")?.metadata, .object(remote))
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("p:remote"))
    }

    func testConflictDropsModeReplacedByANewerLocalAction() async throws {
        let store = self.store!
        let latest: JSONValue = .object(["modelMode": .string("remote"), "unknown": .number(99)])
        let transport = FakeMetadataTransport([
            .object(["result": .string("version-mismatch"), "version": .number(2), "metadata": .string(fixture.seal(latest))]),
        ], onFirstCall: {
            try store.saveComposerState(ComposerStateRecord(sessionId: "s", values: .object(["modelMode": .null])))
        })
        try await sessions.sessionSetAgentModes(sessionId: "s", patch: SessionAgentModesPatch(modelMode: .string("first pick")), transport: transport)
        let calls = await transport.calls
        XCTAssertEqual(calls.count, 1, "old pick must not be replayed")
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .null)
        XCTAssertTrue(sync.modePushes.pending(sessionId: "s").isEmpty)
    }

    func testMetadataRetriesAreBoundedAndFailureKeepsOptimisticPick() async throws {
        let conflict: JSONValue = .object([
            "result": .string("version-mismatch"), "version": .number(2),
            "metadata": .string(fixture.seal(.object(["modelMode": .string("remote")]))),
        ])
        let transport = FakeMetadataTransport([conflict])
        do {
            try await sessions.sessionSetAgentModes(sessionId: "s", patch: SessionAgentModesPatch(modelMode: .string("local")), transport: transport)
            XCTFail("must stop after three attempts")
        } catch { XCTAssertEqual(error as? SessionOpsError, .versionConflicts) }
        let calls = await transport.calls
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(try store.composerState(sessionId: "s").values["modelMode"], .string("local"))
        XCTAssertTrue(sync.modePushes.pending(sessionId: "s").isEmpty)
    }
}
