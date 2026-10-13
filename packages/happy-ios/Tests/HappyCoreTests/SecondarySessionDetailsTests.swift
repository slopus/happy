import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private func session(
    _ id: String = "session-0123456789abcdef",
    active: Bool = false,
    updatedAt: Int64 = 1,
    metadata: [String: JSONValue]? = [:],
    agentState: JSONValue? = nil
) -> SessionRecord {
    SessionRecord(
        id: id, seq: 7, createdAt: 1, updatedAt: updatedAt, active: active, activeAt: 1, projectId: nil,
        metadataVersion: 1, metadataCipher: "c", metadata: metadata.map(JSONValue.object),
        agentStateVersion: 0, agentStateCipher: nil, agentState: agentState, dataKeyCipher: "k", decryptable: true
    )
}

private func machine(
    _ id: String = "m1",
    active: Bool = true,
    activeAt: Int64 = 5,
    metadata: [String: JSONValue]? = [:],
    daemonState: JSONValue? = nil
) -> MachineRecord {
    MachineRecord(
        id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: activeAt,
        metadataVersion: 3, metadataCipher: "c", metadata: metadata.map(JSONValue.object),
        daemonStateVersion: 2, daemonStateCipher: nil, daemonState: daemonState, dataKeyCipher: "k", decryptable: true
    )
}

private let resumable: [String: JSONValue] = ["resumeSupport": .object(["rpcAvailable": .bool(true)])]

/// utils/sessionUtils.ts, resumeCommand.ts, versionUtils.ts and info.tsx's
/// formatters.
final class SessionDetailsFormattingTests: XCTestCase {
    func testPathRelativeToHome() {
        XCTAssertEqual(SessionDetails.pathRelativeToHome("/Users/ada/code", homeDir: "/Users/ada"), "~/code")
        XCTAssertEqual(SessionDetails.pathRelativeToHome("/Users/ada/code", homeDir: "/Users/ada/"), "~/code")
        XCTAssertEqual(SessionDetails.pathRelativeToHome("/Users/ada", homeDir: "/Users/ada"), "~")
        // A plain prefix match, as happy-app does it.
        XCTAssertEqual(SessionDetails.pathRelativeToHome("/Users/adam/x", homeDir: "/Users/ada"), "~/m/x")
        XCTAssertEqual(SessionDetails.pathRelativeToHome("/srv/x", homeDir: "/Users/ada"), "/srv/x")
        XCTAssertEqual(SessionDetails.pathRelativeToHome("/srv/x", homeDir: nil), "/srv/x")
    }

    func testOSPlatform() {
        XCTAssertEqual(SessionDetails.osPlatform("darwin"), "macOS")
        XCTAssertEqual(SessionDetails.osPlatform("Win32"), "Windows")
        XCTAssertEqual(SessionDetails.osPlatform("plan9"), "plan9")
        XCTAssertEqual(SessionDetails.osPlatform(nil), "")
    }

    func testVersions() {
        XCTAssertTrue(SessionDetails.isVersionSupported("0.10.0"))
        XCTAssertTrue(SessionDetails.isVersionSupported("0.10.0-1"), "prerelease suffix is dropped")
        XCTAssertTrue(SessionDetails.isVersionSupported("1.2"))
        XCTAssertFalse(SessionDetails.isVersionSupported("0.9.12"))
        XCTAssertFalse(SessionDetails.isVersionSupported(nil))
        XCTAssertEqual(SessionDetails.compareVersions("1.0", "1.0.0"), 0)
        XCTAssertEqual(SessionDetails.compareVersions("x.1", "0.1"), 0, "NaN is neither less nor greater")
    }

    func testShortId() {
        XCTAssertEqual(SessionDetails.shortId("abcdefgh12345678ijklmnop"), "abcdefgh...ijklmnop")
        XCTAssertEqual(SessionDetails.shortId("abc"), "abc...abc")
    }

    func testResumeCommand() {
        XCTAssertEqual(
            SessionDetails.resumeCommand(.object(["path": .string("/w/it's"), "claudeSessionId": .string("c1")])),
            "cd '/w/it'\\''s' && happy claude --resume c1"
        )
        XCTAssertEqual(
            SessionDetails.resumeCommand(.object(["os": .string("win32"), "path": .string("C:\\a'b"), "flavor": .string("codex"), "codexThreadId": .string("t1")])),
            "Set-Location -LiteralPath 'C:\\a''b'; happy codex --resume t1"
        )
        XCTAssertEqual(SessionDetails.resumeCommand(.object(["claudeSessionId": .string("c1")])), "happy claude --resume c1")
        XCTAssertNil(SessionDetails.resumeCommand(.object(["client": .object(["id": .string("rig")]), "claudeSessionId": .string("c1")])))
        XCTAssertNil(SessionDetails.resumeCommand(.object(["capabilities": .object(["resume": .bool(false)]), "claudeSessionId": .string("c1")])))
        XCTAssertNil(SessionDetails.resumeCommand(.object(["flavor": .string("codex")])))
    }

    func testSandbox() {
        XCTAssertEqual(SessionDetails.sandbox(nil, homeDir: nil), "Disabled")
        XCTAssertEqual(SessionDetails.sandbox(.null, homeDir: nil), "Disabled")
        XCTAssertEqual(SessionDetails.sandbox(.string("strict"), homeDir: nil), "strict")
        XCTAssertEqual(SessionDetails.sandbox(.object(["enabled": .bool(false)]), homeDir: nil), "Disabled")
        XCTAssertEqual(SessionDetails.sandbox(.object([
            "enabled": .bool(true),
            "sessionIsolation": .string("strict"),
            "networkMode": .string("none"),
            "workspaceRoot": .string("/Users/ada/w"),
        ]), homeDir: "/Users/ada"), "Enabled | isolation=strict | network=none | workspace=~/w")
    }

    func testDangerouslySkipPermissions() {
        XCTAssertEqual(SessionDetails.dangerouslySkipPermissions(.bool(false), flavor: nil, permissionMode: "yolo", sandbox: nil), "Disabled")
        XCTAssertEqual(SessionDetails.dangerouslySkipPermissions(nil, flavor: nil, permissionMode: "bypassPermissions", sandbox: nil), "Enabled")
        XCTAssertEqual(SessionDetails.dangerouslySkipPermissions(nil, flavor: "claude", permissionMode: nil, sandbox: .object(["enabled": .bool(true)])), "Enabled")
        XCTAssertEqual(SessionDetails.dangerouslySkipPermissions(nil, flavor: "codex", permissionMode: nil, sandbox: .object(["enabled": .bool(true)])), "Unknown")
    }

    func testAIProvider() {
        XCTAssertEqual(SessionDetails.aiProvider(.object([:])), "Claude")
        XCTAssertEqual(SessionDetails.aiProvider(.object(["flavor": .string("openai")])), "Codex")
        XCTAssertEqual(SessionDetails.aiProvider(.object(["flavor": .string("gemini")])), "Gemini")
        XCTAssertEqual(SessionDetails.aiProvider(.object(["flavor": .string("agy")])), "agy")
        XCTAssertEqual(SessionDetails.aiProvider(.object([
            "client": .object(["id": .string("rig")]),
            "provider": .object(["id": .string("anthropic"), "name": .string("Anthropic")]),
        ])), "Anthropic")
    }

    func testRigIdentityModelFromTheModelList() {
        let metadata: JSONValue = .object([
            "client": .object(["id": .string("rig"), "name": .string("Happy Agent"), "version": .string("2.1")]),
            "currentModelProviderId": .string("p"),
            "currentModelCode": .string("m"),
            "models": .array([.object(["providerId": .string("p"), "id": .string("m"), "name": .string("Model M"), "providerName": .string("Prov")])]),
        ])
        let identity = RigIdentity(metadata)
        XCTAssertEqual(identity?.clientName, "Happy Agent")
        XCTAssertEqual(identity?.clientVersion, "2.1")
        XCTAssertEqual(identity?.providerName, "Prov")
        XCTAssertEqual(identity?.modelName, "Model M")
        XCTAssertNil(RigIdentity(.object([:])))
    }

    func testActivity() {
        let activity = SessionDetails.activity(.object(["activity": .object([
            "subagents": .object(["running": .number(1), "queued": .number(2)]),
            "workflows": .object(["running": .number(0)]),
            "processes": .object(["running": .number(3)]),
            "tasks": .object(["pending": .number(4), "inProgress": .number(5)]),
        ])]))
        XCTAssertEqual(activity.subagents, "1 running · 2 queued")
        XCTAssertNil(activity.workflows)
        XCTAssertEqual(activity.processes, "3 running")
        XCTAssertEqual(activity.tasks, "5 in progress · 4 pending")
    }

    func testCompactCount() {
        XCTAssertEqual(SessionDetails.compactCount(999), "999")
        XCTAssertEqual(SessionDetails.compactCount(1_000), "1k")
        XCTAssertEqual(SessionDetails.compactCount(1_250), "1.3k")
        XCTAssertEqual(SessionDetails.compactCount(4_949), "4.9k")
        XCTAssertEqual(SessionDetails.compactCount(12_500), "13k")
        XCTAssertEqual(SessionDetails.compactCount(-3), "0")
    }

    func testPrettyJSONMatchesStringify() {
        let value: JSONValue = .object(["b": .array([.number(1), .bool(true)]), "a": .string("x\n\"y\""), "e": .object([:])])
        XCTAssertEqual(SessionDetails.prettyJSON(value), """
        {
          "a": "x\\n\\"y\\"",
          "b": [
            1,
            true
          ],
          "e": {}
        }
        """)
    }

    func testMetadataClipboard() {
        XCTAssertEqual(SessionDetails.metadataClipboard(.object(["a": .number(1)]), withLogs: true), "=== Session Metadata ===\n{\n  \"a\": 1\n}")
    }

    func testLocaleDateTime() {
        let text = SessionDetails.localeDateTime(0, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
        XCTAssertTrue(text.contains("1/1/1970"), text)
        XCTAssertTrue(text.contains("12:00:00"), text)
    }
}

/// useSessionQuickActions.ts `getResumeAvailability`, `canFork` and
/// sessionFork.ts.
final class SessionDetailsQuickActionTests: XCTestCase {
    private let claude: [String: JSONValue] = ["machineId": .string("m1"), "path": .string("/w"), "claudeSessionId": .string("c1")]

    func testResumeAvailability() {
        XCTAssertEqual(SessionDetails.resumeAvailability(session(active: true, metadata: claude), machine: machine(metadata: resumable)), .hidden, "connected")
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: ["client": .object(["id": .string("rig")])]), machine: nil), .hidden)
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: [:]), machine: nil), .missingMachine)
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: ["machineId": .string("m1")]), machine: nil), .missingBackendId)
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: claude), machine: nil), .sameMachineOnly)
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: claude), machine: machine(active: false, metadata: resumable)), .machineOffline)
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: claude), machine: machine()), .hidden, "an older daemon")
        XCTAssertEqual(SessionDetails.resumeAvailability(session(metadata: claude), machine: machine(metadata: resumable)), .available)
    }

    func testForkSource() {
        XCTAssertEqual(SessionDetails.forkSource(session("s", metadata: claude)), .claude(
            sessionId: "s", options: ClaudeForkSessionOptions(machineId: "m1", directory: "/w", claudeSessionId: "c1")
        ))
        var codex = claude
        codex["flavor"] = .string("codex")
        XCTAssertNil(SessionDetails.forkSource(session(metadata: codex)), "codex needs its thread")
        codex["codexThreadId"] = .string("t1")
        XCTAssertEqual(SessionDetails.forkSource(session("s", metadata: codex)), .codex(
            sessionId: "s", options: CodexForkThreadOptions(machineId: "m1", directory: "/w", codexThreadId: "t1")
        ))
        XCTAssertNil(SessionDetails.forkSource(session(metadata: ["machineId": .string(" "), "path": .string("/w"), "claudeSessionId": .string("c")])))
    }

    func testCanForkNeedsTheExperimentAndAnOnlineMachine() {
        let on = AccountSettings(SettingsSnapshot(synced: AccountSettingsRecord(version: 1, cipher: nil, settings: .object(["expResumeSession": .bool(true)]))))
        let off = AccountSettings(SettingsSnapshot(synced: AccountSettingsRecord(version: 1, cipher: nil, settings: .object(["expResumeSession": .bool(false)]))))
        XCTAssertTrue(SessionDetails.canFork(session(metadata: claude), machine: machine(), settings: on))
        XCTAssertFalse(SessionDetails.canFork(session(metadata: claude), machine: machine(), settings: off))
        XCTAssertFalse(SessionDetails.canFork(session(metadata: claude), machine: machine(active: false), settings: on))
        XCTAssertFalse(SessionDetails.canFork(session(metadata: claude), machine: nil, settings: on))
    }

    func testGitPresentation() {
        let rig = SessionDetails.gitPresentation(.object([
            "client": .object(["id": .string("rig")]),
            "git": .object(["changedFiles": .number(3), "insertions": .number(10), "deletions": .number(0), "countsExact": .bool(false)]),
        ]), status: nil)
        XCTAssertEqual(rig.changedFileCount, 3)
        XCTAssertEqual(rig.changes, SessionDetails.LineChanges(insertions: 10, deletions: 0, approximate: true))

        var status = GitStatus(lastUpdatedAt: 1)
        let file = { (path: String, staged: Bool, added: Int, removed: Int) in
            GitFileStatus(fileName: path, filePath: "", fullPath: path, status: .modified, isStaged: staged, linesAdded: added, linesRemoved: removed)
        }
        status.stagedFiles = [file("a", true, 2, 1)]
        status.unstagedFiles = [file("a", false, 3, 0), file("b", false, 0, 0)]
        let legacy = SessionDetails.gitPresentation(.object([:]), status: status)
        XCTAssertEqual(legacy.changedFileCount, 2, "a file staged and unstaged counts once")
        XCTAssertEqual(legacy.changes, SessionDetails.LineChanges(insertions: 5, deletions: 1, approximate: false))

        XCTAssertFalse(SessionDetails.gitPresentation(.object([:]), status: nil).hasAccessory)
        XCTAssertNil(SessionDetails.gitPresentation(.object([:]), status: GitStatus()).changes)
    }
}

/// info.tsx's row decisions.
final class SessionInfoModelTests: XCTestCase {
    private let settings = AccountSettings(SettingsSnapshot())

    func testMetadataRows() {
        let model = SessionInfoModel(session: session(metadata: [
            "host": .string("mac"),
            "path": .string("/Users/ada/w"),
            "homeDir": .string("/Users/ada"),
            "version": .string("0.9.0"),
            "os": .string("darwin"),
            "hostPid": .number(4242),
            "happyHomeDir": .string("/Users/ada/.happy"),
        ]), machine: nil, settings: settings, gitStatus: nil, permissionMode: nil)
        let metadata = try! XCTUnwrap(model.metadata)
        XCTAssertTrue(model.cliOutdated)
        XCTAssertEqual(metadata.path, "~/w")
        XCTAssertEqual(metadata.cliVersion, "0.9.0")
        XCTAssertEqual(metadata.operatingSystem, "macOS")
        XCTAssertEqual(metadata.processId, "4242")
        XCTAssertEqual(metadata.happyHome, "~/.happy")
        XCTAssertEqual(metadata.sandbox, "Disabled")
        XCTAssertEqual(metadata.dangerouslySkipPermissions, "Unknown")
        XCTAssertNil(metadata.client)
        XCTAssertNil(model.agentState)
    }

    func testHappyAgentHidesSandboxAndAgentState() {
        let model = SessionInfoModel(session: session(
            metadata: ["client": .object(["id": .string("rig"), "version": .string("3")]), "path": .string("/w")],
            agentState: .object(["controlledByUser": .bool(true)])
        ), machine: nil, settings: settings, gitStatus: nil, permissionMode: nil)
        XCTAssertNil(model.metadata?.sandbox)
        XCTAssertNil(model.metadata?.dangerouslySkipPermissions)
        XCTAssertEqual(model.metadata?.client, "Rig 3")
        XCTAssertNil(model.agentState)
    }

    func testAgentStateAndConnection() {
        let model = SessionInfoModel(session: session(
            active: true,
            metadata: ["claudeSessionId": .string("c1")],
            agentState: .object(["controlledByUser": .bool(false), "requests": .object(["r1": .object([:]), "r2": .object([:])])])
        ), machine: nil, settings: settings, gitStatus: nil, permissionMode: "bypassPermissions")
        XCTAssertTrue(model.isConnected)
        XCTAssertNil(model.resumeCommand, "only offered while disconnected")
        XCTAssertEqual(model.agentState, SessionInfoModel.AgentState(controlledByUser: false, pendingRequests: 2))
        XCTAssertEqual(model.metadata?.dangerouslySkipPermissions, "Enabled")
    }

    func testNoMetadataNoGroup() {
        let model = SessionInfoModel(session: session(metadata: nil), machine: nil, settings: settings, gitStatus: nil, permissionMode: nil)
        XCTAssertNil(model.metadata)
        XCTAssertNil(model.machineId)
        XCTAssertFalse(model.cliOutdated)
        XCTAssertEqual(model.resume, .missingMachine)
    }
}

/// machine/[id].tsx.
final class MachineDetailsModelTests: XCTestCase {
    func testNamesAndDaemon() {
        let model = MachineDetailsModel(machine: machine(
            metadata: ["displayName": .string(""), "host": .string("mac.local"), "homeDir": .string("/Users/ada")],
            daemonState: .object(["pid": .number(0), "httpPort": .number(8080), "startedWithCliVersion": .string("1.2.3")])
        ), sessions: [])
        XCTAssertEqual(model.name, "mac.local")
        XCTAssertEqual(model.displayName, "")
        XCTAssertNil(model.daemon?.pid, "a zero pid is falsy and hidden")
        XCTAssertEqual(model.daemon?.httpPort, "8080")
        XCTAssertEqual(model.daemon?.cliVersion, "1.2.3")
        XCTAssertEqual(model.homeDirectory, "/Users/ada")
        XCTAssertEqual(model.lastSeen, 5)
        XCTAssertNil(model.cliAvailability)

        let bare = MachineDetailsModel(machine: machine("m9", activeAt: 0, metadata: nil), sessions: [])
        XCTAssertEqual(bare.name, "unknown machine")
        XCTAssertEqual(bare.host, "m9")
        XCTAssertNil(bare.lastSeen)
        XCTAssertNil(bare.daemon)
    }

    func testCLIAvailability() {
        let model = MachineDetailsModel(machine: machine(metadata: ["cliAvailability": .object([
            "claude": .bool(true), "codex": .bool(false), "gemini": .bool(false), "openclaw": .bool(true), "detectedAt": .number(9),
        ])]), sessions: [])
        XCTAssertEqual(model.cliAvailability, .init(claude: true, codex: false, gemini: false, openclaw: true, rig: nil, detectedAt: 9))
    }

    func testRecentSessionsNewestUpdateFirstWithoutSideChats() {
        var sessions: [SessionRecord] = (0..<7).map { index in
            session("s\(index)", updatedAt: Int64(index), metadata: ["machineId": .string("m1"), "path": .string("/w/\(index)")])
        }
        sessions.append(session("side", updatedAt: 100, metadata: ["machineId": .string("m1"), "isSideChat": .bool(true)]))
        sessions.append(session("other", updatedAt: 100, metadata: ["machineId": .string("m2")]))
        sessions.append(session("bare", updatedAt: 50, metadata: nil))
        let model = MachineDetailsModel(machine: machine(), sessions: sessions)
        XCTAssertEqual(model.recentSessions.map(\.id), ["s6", "s5", "s4", "s3", "s2"])
        XCTAssertEqual(model.recentSessions.first?.subtitle, "/w/6")
    }

    func testRenamedMetadataKeepsTheRest() {
        let metadata: JSONValue = .object(["host": .string("mac"), "displayName": .string("Old")])
        XCTAssertEqual(MachineDetailsModel.renamedMetadata(metadata, displayName: "  New  "), .object(["host": .string("mac"), "displayName": .string("New")]))
        XCTAssertEqual(MachineDetailsModel.renamedMetadata(metadata, displayName: " "), .object(["host": .string("mac")]))
    }
}

/// The flows behind the rows, over fake transports.
final class SessionDetailActionsTests: XCTestCase {
    var fixture: ServerFixture!
    var http: FakeHTTP!
    var store: LocalStore!
    var engine: SyncEngine!
    var rpc: FakeRPC!
    var actions: SessionDetailActions!
    var machines: MachineActions!

    struct NoMetadata: MetadataUpdateTransport {
        func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue { .null }
    }

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        store = try LocalStore.inMemory()
        engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        rpc = FakeRPC()
        let sessions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: rpc, now: { 500 })
        machines = MachineActions(api: testAPI(http), store: store, sync: engine, rpc: rpc, metadataTransport: NoMetadata())
        actions = SessionDetailActions(sessions: sessions, machines: machines, store: store, sync: engine, metadataTransport: NoMetadata())
    }

    override func tearDown() async throws {
        await engine.stop()
    }

    private func stored(_ id: String = "s", active: Bool = true, metadata: JSONValue? = nil) throws -> SessionRecord {
        var record = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session(id, updatedAt: 1))
        record.active = active
        if let metadata { record.metadata = metadata }
        try store.upsertSessions([record])
        return try XCTUnwrap(try store.session(id: id))
    }

    func testArchivingABotThatCantBeReachedSaysSo() async throws {
        let bot = try stored(metadata: .object(["bot": .object(["id": .string("b1")])]))
        do {
            try await actions.archive(bot, confirmWorktreeCleanup: { XCTFail("bots skip the worktree"); return false })
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, SessionDetailActions.botArchiveMessage)
        }
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testArchiveFallsBackToTheServer() async throws {
        let record = try stored()
        http.onRaw("POST /v1/sessions/s/archive", #"{"success":true}"#)
        try await actions.archive(record, confirmWorktreeCleanup: { false })
        XCTAssertEqual(http.requests("POST /v1/sessions/s/archive").count, 1)
    }

    func testDeletingABotIsRefusedWithoutAsking() async throws {
        let bot = try stored(metadata: .object(["bot": .object(["id": .string("b1")])]))
        do {
            try await actions.delete(bot)
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, SessionDetailActions.botDeleteMessage)
        }
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testDeleteRemovesTheSession() async throws {
        let record = try stored()
        http.onRaw("DELETE /v1/sessions/s", #"{"success":true}"#)
        try await actions.delete(record)
        XCTAssertNil(try store.session(id: "s"))
    }

    func testAFailedDeleteHasHappyAppsWords() async throws {
        let record = try stored()
        http.onRaw("DELETE /v1/sessions/s", "no", status: 500)
        do {
            try await actions.delete(record)
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, "Failed to delete session")
        }
    }

    func testResumeRefusesWithTheAvailabilityMessage() async throws {
        let messages = SessionDetailActions.ResumeMessages(
            missingMachine: "no machine", missingBackendId: "no id", sameMachineOnly: "same", machineOffline: "offline", unexpectedDirectoryPrompt: "dir"
        )
        let record = try stored(active: false, metadata: .object(["machineId": .string("m1")]))
        do {
            _ = try await actions.resume(record, machine: nil, settings: nil, composer: .object([:]), messages: messages)
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, "no id")
        }
    }

    func testForkWithoutASourceSaysMetadataIsMissing() async throws {
        let record = try stored(metadata: .object([:]))
        do {
            _ = try await actions.fork(record, canFork: true, messages: .init(missingMetadata: "missing", generic: "generic"))
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, "missing")
        }
    }

    func testDuplicateSheetWithoutASourceSaysMetadataIsMissing() async throws {
        let record = try stored(metadata: .object([:]))
        let points = await DuplicateSheetModel.loadPoints(record, machines: machines, missingMetadata: "missing")
        XCTAssertEqual(points, .failed("missing"))
        do {
            _ = try await DuplicateSheetModel.duplicate(
                record,
                after: .init(id: "u1", text: "hi", timestamp: 0),
                machines: machines,
                messages: .init(missingMetadata: "missing", generic: "generic")
            )
            XCTFail("expected an error")
        } catch let failure as SessionDetailActions.Failure {
            XCTAssertEqual(failure.message, "missing")
        }
        XCTAssertTrue(rpc.calls.isEmpty)
    }

    func testWorktreeCleanupIsNotOfferedOutsideAWorktree() async throws {
        await actions.maybeCleanupWorktree(sessionId: "s", path: "/w/repo", machineId: "m1") {
            XCTFail("not a worktree")
            return false
        }
        XCTAssertTrue(rpc.calls.isEmpty)
    }

    func testWorktreeCleanupIsNotOfferedWhileAnotherSessionUsesIt() async throws {
        let path = "/w/repo/.dev/worktree/feature"
        _ = try stored("other", metadata: .object(["path": .string(path)]))
        await actions.maybeCleanupWorktree(sessionId: "s", path: path, machineId: "m1") {
            XCTFail("in use")
            return false
        }
        XCTAssertTrue(rpc.calls.isEmpty)
    }

    func testRemoveWorktreeCommand() {
        let command = SessionDetails.removeWorktreeCommand("/w/repo/.dev/worktree/feature")
        XCTAssertEqual(command?.command, "git worktree remove /w/repo/.dev/worktree/feature --force")
        XCTAssertEqual(command?.cwd, "/w/repo")
        XCTAssertNil(SessionDetails.removeWorktreeCommand("/w/repo"))
    }
}

/// components/DuplicateSheet.tsx's row text and `formatRelativeTime`.
final class DuplicateSheetModelTests: XCTestCase {
    func testPreviewCollapsesWhitespace() {
        XCTAssertEqual(DuplicateSheetModel.preview("  fix\n\n the   bug \t"), "fix the bug")
        XCTAssertEqual(DuplicateSheetModel.preview(" \n "), "")
    }

    func testPreviewCutsAt140() {
        let exact = String(repeating: "a", count: 140)
        XCTAssertEqual(DuplicateSheetModel.preview(exact), exact)
        XCTAssertEqual(DuplicateSheetModel.preview(exact + "b"), exact + "…")
        // Counted after collapsing, in UTF-16 units as `String.length` is.
        XCTAssertEqual(DuplicateSheetModel.preview(String(repeating: "a ", count: 80)), String(repeating: "a ", count: 70) + "…")
        XCTAssertEqual(DuplicateSheetModel.preview(String(repeating: "é", count: 141)), String(repeating: "é", count: 140) + "…")
    }

    func testAge() {
        let now = 10_000_000_000.0
        let minute = 60_000.0
        XCTAssertEqual(DuplicateSheetModel.age(of: now - minute + 1, now: now), .justNow)
        XCTAssertEqual(DuplicateSheetModel.age(of: now + minute, now: now), .justNow)
        XCTAssertEqual(DuplicateSheetModel.age(of: now - minute, now: now), .minutes(1))
        XCTAssertEqual(DuplicateSheetModel.age(of: now - 59 * minute - 59_999, now: now), .minutes(59))
        XCTAssertEqual(DuplicateSheetModel.age(of: now - 60 * minute, now: now), .hours(1))
        XCTAssertEqual(DuplicateSheetModel.age(of: now - (24 * 60 - 1) * minute, now: now), .hours(23))
        XCTAssertEqual(DuplicateSheetModel.age(of: now - 24 * 60 * minute, now: now), .days(1))
        XCTAssertEqual(DuplicateSheetModel.age(of: now - 49 * 60 * minute, now: now), .days(2))
    }
}
