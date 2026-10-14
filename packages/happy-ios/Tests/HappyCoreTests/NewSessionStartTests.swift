import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// After happy-app's sync/rigSessionCreation.test.ts.
final class RigSessionCreationTests: XCTestCase {
    static let rigMachine: JSONValue = .object([
        "host": .string("rig-host"),
        "homeDir": .string("/Users/rig"),
        "machineKind": .string("rig"),
        "rigOnly": .bool(true),
        "capabilities": .object(["newSession": .bool(true), "resume": .bool(false), "worktrees": .bool(false)]),
        "defaults": .object([
            "providerId": .string("codex"),
            "modelId": .string("shared-model"),
            "permissionMode": .string("auto"),
            "effort": .string("high"),
        ]),
        "models": .array([
            .object([
                "providerId": .string("codex"), "id": .string("shared-model"), "name": .string("GPT Shared"),
                "providerName": .string("OpenAI Codex"),
                "thinkingLevels": .array([.string("low"), .string("medium"), .string("high")]),
                "defaultThinkingLevel": .string("high"),
            ]),
            .object([
                "providerId": .string("claude"), "id": .string("shared-model"), "name": .string("Claude Shared"),
                "providerName": .string("Anthropic Claude"),
                "thinkingLevels": .array([.string("low"), .string("max")]),
                "defaultThinkingLevel": .string("max"),
            ]),
        ]),
        "operatingModes": .array([
            .object(["code": .string("auto"), "value": .string("Auto"), "description": .string("Safe default"), "kind": .string("safe-yolo")]),
            .object(["code": .string("read_only"), "value": .string("Read only"), "description": .string("No writes"), "kind": .string("read-only")]),
        ]),
    ])

    private func with(_ base: JSONValue, _ changes: [String: JSONValue?]) -> JSONValue {
        var object = base.objectValue ?? [:]
        for (key, value) in changes { object[key] = value }
        return .object(object)
    }

    func testProviderQualifiedOptionsAndModelDefaults() throws {
        let creation = try XCTUnwrap(RigSessionCreation(metadata: Self.rigMachine))
        XCTAssertEqual(creation.defaultModelKey, "codex:shared-model")
        XCTAssertEqual(creation.defaultPermissionMode, "auto")
        XCTAssertFalse(creation.supportsWorktrees)
        XCTAssertEqual(creation.models.map(\.key), ["codex:shared-model", "claude:shared-model"])
        XCTAssertEqual(creation.models.map(\.description), ["OpenAI Codex", "Anthropic Claude"])
        XCTAssertEqual(creation.permissionModes.map(\.semanticKind), ["safe-yolo", "read-only"])
        XCTAssertEqual(creation.efforts(forModel: "claude:shared-model"), ["low", "max"])
        XCTAssertEqual(creation.defaultEffort(forModel: "claude:shared-model"), "max")
        XCTAssertEqual(creation.efforts(forModel: "unknown"), ["low", "medium", "high"], "falls back to the default model")
    }

    func testOnlyHappyAgentMachinesThatStartSessions() {
        XCTAssertNil(RigSessionCreation(metadata: .object(["host": .string("cli-host")])))
        let noSessions = with(Self.rigMachine, ["capabilities": .object(["newSession": .bool(false)])])
        XCTAssertNil(RigSessionCreation(metadata: noSessions))
    }

    func testBotsOnlyWhenTheDaemonSaysSo() {
        XCTAssertEqual(RigSessionCreation(metadata: Self.rigMachine)?.supportsBots, false)
        let bots = with(Self.rigMachine, ["capabilities": .object(["newSession": .bool(true), "bots": .bool(true)])])
        XCTAssertEqual(RigSessionCreation(metadata: bots)?.supportsBots, true)
    }

    func testAstraLeadsWithoutChangingTheDefault() throws {
        for published in [true, false] {
            let metadata = with(Self.rigMachine, [
                "defaults": published ? .object(["providerId": .string("codex"), "modelId": .string("openai/gpt-5.6-sol")]) : nil,
                "models": .array([
                    .object(["providerId": .string("codex"), "id": .string("openai/gpt-5.6-sol"), "thinkingLevels": .array([.string("medium")])]),
                    .object(["providerId": .string("claude"), "id": .string("anthropic/opus-5"), "thinkingLevels": .array([.string("high")])]),
                    .object([
                        "providerId": .string("codex"), "id": .string("openai/gpt-6-astra"), "name": .string("GPT-6 Astra"),
                        "thinkingLevels": .array([.string("medium"), .string("high"), .string("ultra")]),
                        "defaultThinkingLevel": .string("high"),
                    ]),
                ]),
            ])
            let creation = try XCTUnwrap(RigSessionCreation(metadata: metadata))
            XCTAssertEqual(creation.models.map(\.key), ["codex:openai/gpt-6-astra", "codex:openai/gpt-5.6-sol", "claude:anthropic/opus-5"])
            XCTAssertEqual(creation.defaultModelKey, "codex:openai/gpt-5.6-sol")
            let config = try RigSpawnConfiguration(
                metadata: metadata, directory: "/Users/rig/project", clientRequestId: "astra-picker",
                modelKey: creation.models[0].key, permissionMode: nil, effort: nil
            )
            XCTAssertEqual(config.providerId, "codex")
            XCTAssertEqual(config.modelId, "openai/gpt-6-astra")
            XCTAssertEqual(config.effort, "high")
        }
    }

    func testTheExactSpawnPayload() throws {
        let config = try RigSpawnConfiguration(
            metadata: Self.rigMachine,
            directory: "/Users/rig/project",
            clientRequestId: "mobile-request-1",
            approvedNewDirectoryCreation: true,
            modelKey: "claude:shared-model",
            permissionMode: "read_only",
            effort: "max"
        )
        let options = config.options(machineId: "m1", target: .project(id: "p1"))
        XCTAssertEqual(options.machineId, "m1")
        XCTAssertEqual(options.agent, "rig")
        XCTAssertEqual(options.directory, "/Users/rig/project")
        XCTAssertEqual(options.clientRequestId, "mobile-request-1")
        XCTAssertTrue(options.approvedNewDirectoryCreation)
        XCTAssertEqual(options.providerId, "claude")
        XCTAssertEqual(options.modelId, "shared-model")
        XCTAssertEqual(options.permissionMode, "read_only")
        XCTAssertEqual(options.effort, "max")
        XCTAssertNil(options.modelMode, "no Happy CLI-only fields")
        XCTAssertEqual(options.happyAgentTarget, .object(["kind": .string("project"), "id": .string("p1")]))
    }

    func testAModelEffortPairOutsideTheCatalogIsRefused() {
        XCTAssertThrowsError(try RigSpawnConfiguration(
            metadata: Self.rigMachine, directory: "/Users/rig/project", clientRequestId: "r2",
            modelKey: "claude:shared-model", permissionMode: nil, effort: "high"
        )) { error in
            XCTAssertEqual(error as? RigSpawnConfiguration.Failure, .effortUnavailable)
            XCTAssertTrue(error.localizedDescription.contains("reasoning level is unavailable"))
        }
    }

    func testTheFallbackModeIsThePublishedFirst() {
        let metadata = with(Self.rigMachine, [
            "defaults": nil,
            "operatingModes": .array([
                .object(["code": .string("ask"), "value": .string("Default"), "kind": .string("default")]),
                .object(["code": .string("full_access"), "value": .string("Full access"), "kind": .string("yolo")]),
            ]),
        ])
        XCTAssertEqual(RigSessionCreation(metadata: metadata)?.defaultPermissionMode, "ask")
    }

    func testNoModesAndNoBackoff() {
        let creation = RigSessionCreation(metadata: with(Self.rigMachine, ["operatingModes": nil]))
        XCTAssertEqual(creation?.permissionModes, [])
        XCTAssertNil(creation?.defaultPermissionMode)
        XCTAssertNil(creation?.pendingRetryAfterMs)
        let published = with(Self.rigMachine, ["sessionCreation": .object(["pendingRetryAfterMs": .number(2000)])])
        XCTAssertEqual(RigSessionCreation(metadata: published)?.pendingRetryAfterMs, 2000)
    }

    func testPendingRetryDelayIsClamped() {
        XCTAssertEqual(RigSessionCreation.pendingRetryDelayMs(nil, published: nil), 1000)
        XCTAssertEqual(RigSessionCreation.pendingRetryDelayMs(nil, published: 2000), 2000)
        XCTAssertEqual(RigSessionCreation.pendingRetryDelayMs(0, published: nil), 250)
        XCTAssertEqual(RigSessionCreation.pendingRetryDelayMs(-5000, published: nil), 250)
        XCTAssertEqual(RigSessionCreation.pendingRetryDelayMs(60000, published: nil), 10000)
        XCTAssertEqual(RigSessionCreation.pendingRetryDelayMs(3000, published: 250), 3000)
    }

    /// sync/happyAgentSpawn.test.ts.
    func testCatalogTargets() throws {
        let workspaces = [(id: "workspace-1", path: "/project/workspace-1")]
        XCTAssertEqual(try HappyAgentSpawnTarget.resolve(projectId: "project-1", workspaceSelection: "__new__", workspaces: workspaces), .newWorkspace(projectId: "project-1"))
        XCTAssertEqual(try HappyAgentSpawnTarget.resolve(projectId: "project-1", workspaceSelection: "__none__", workspaces: workspaces), .project(id: "project-1"))
        XCTAssertEqual(try HappyAgentSpawnTarget.resolve(projectId: "project-1", workspaceSelection: "/project/workspace-1", workspaces: workspaces), .workspace(id: "workspace-1"))
        XCTAssertNil(try HappyAgentSpawnTarget.resolve(projectId: "  ", workspaceSelection: "__new__", workspaces: workspaces))
        XCTAssertThrowsError(try HappyAgentSpawnTarget.resolve(projectId: "project-1", workspaceSelection: "/project/missing", workspaces: workspaces))
    }
}

/// After hooks/useNewSessionDraft.test.ts and sync/persistence.ts.
@MainActor
final class NewSessionDraftTests: XCTestCase {
    func testTheDraftRoundTripsHappyAppsJSON() async throws {
        let json = #"{"input":"fix it","selectedMachineId":"m1","selectedPath":"~/happy","selectedProjectId":null,"agentType":"codex","pickedAgentType":"codex","permissionMode":"auto","modelMode":"gpt-6.1-sol","effortLevel":"high","sessionType":"worktree","worktreeKey":"/w/1","updatedAt":1700}"#
        let draft = try XCTUnwrap(NewSessionDraft(json: json, now: 5))
        XCTAssertEqual(draft, NewSessionDraft(
            input: "fix it", selectedMachineId: "m1", selectedPath: "~/happy", selectedProjectId: nil,
            agentType: .codex, pickedAgentType: .codex, permissionMode: "auto", modelMode: "gpt-6.1-sol",
            effortLevel: "high", sessionType: .worktree, worktreeKey: "/w/1", updatedAt: 1700
        ))
        XCTAssertEqual(NewSessionDraft(json: draft.json, now: 5), draft)
        XCTAssertEqual(draft.worktreeSelection, "/w/1")
    }

    func testAnOldOrOddDraftStillOpens() async throws {
        let draft = try XCTUnwrap(NewSessionDraft(json: #"{"agentType":"vim","sessionType":"other","input":3}"#, now: 42))
        XCTAssertEqual(draft.agentType, .claude)
        XCTAssertNil(draft.pickedAgentType)
        XCTAssertEqual(draft.sessionType, .simple)
        XCTAssertEqual(draft.input, "")
        XCTAssertEqual(draft.updatedAt, 42)
        XCTAssertEqual(draft.worktreeSelection, "__none__")
        XCTAssertNil(NewSessionDraft(json: "[]", now: 0))
        XCTAssertNil(NewSessionDraft(json: "nope", now: 0))
    }

    func testChoosingAPlaceClearsWhatBelongedToTheOldOne() async {
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        let store = NewSessionDraftStore(settings: settings, now: { 9 })
        store.setMachineId("m1")
        store.setPath("~/happy")
        store.selectWorktree("/w/1")
        XCTAssertEqual(store.draft.sessionType, .worktree)
        XCTAssertEqual(store.draft.worktreeKey, "/w/1")

        store.setProjectId("p1")
        XCTAssertNil(store.draft.selectedPath, "a project replaces the directory")
        XCTAssertNil(store.draft.worktreeKey)
        store.setPath("~/other")
        XCTAssertNil(store.draft.selectedProjectId, "and a directory replaces the project")

        store.renameMachineId("m2")
        XCTAssertEqual(store.draft.selectedPath, "~/other", "a rename keeps the place")
        store.setMachineId("m3")
        XCTAssertNil(store.draft.selectedPath, "another computer drops it")

        store.selectWorktree("__new__")
        XCTAssertEqual(store.draft.worktreeSelection, "__new__")
        store.selectWorktree("__none__")
        XCTAssertEqual(store.draft.sessionType, .simple)

        store.setAgentType(.codex)
        XCTAssertNil(store.draft.pickedAgentType)
        store.pickAgentType(.rig)
        XCTAssertEqual(store.draft.agentType, .rig)
        XCTAssertEqual(store.draft.pickedAgentType, .rig)
        XCTAssertEqual(store.draft.updatedAt, 9)
    }

    func testTheDraftPersistsPerAccountAndLogoutClearsIt() async {
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        let store = NewSessionDraftStore.shared(for: settings)
        XCTAssertTrue(NewSessionDraftStore.shared(for: settings) === store)
        store.setInput("hello")
        store.setCreatesBot(true)
        store.setBotName("Captain")
        XCTAssertEqual(settings.newSessionDraft?.input, "hello")
        let reopened = NewSessionDraftStore(settings: settings)
        XCTAssertEqual(reopened.draft.input, "hello")
        XCTAssertFalse(reopened.createsBot, "a restarted app offers a session")
        XCTAssertEqual(reopened.botName, "")

        let other = LocalSettings(storage: InMemoryKeyValueStore())
        XCTAssertFalse(NewSessionDraftStore.shared(for: other) === store)
        settings.clear()
        XCTAssertNil(settings.newSessionDraft)
    }

    func testObserversHearEveryChange() async {
        let store = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        var heard: [String] = []
        let observation = store.observe { heard.append($0.draft.input) }
        store.setInput("a")
        store.setInput("ab")
        XCTAssertEqual(heard, ["a", "ab"])
        _ = observation
    }

    /// utils/botName.test.ts.
    func testBotNames() async {
        XCTAssertTrue(BotName.isValid("Release Captain"))
        XCTAssertTrue(BotName.isValid("  Release Captain  "))
        XCTAssertTrue(BotName.isValid(String(repeating: "a", count: BotName.maxLength)))
        XCTAssertFalse(BotName.isValid(""))
        XCTAssertFalse(BotName.isValid("   "))
        XCTAssertFalse(BotName.isValid(String(repeating: "a", count: BotName.maxLength + 1)))
        XCTAssertFalse(BotName.isValid("line\nbreak"))
        XCTAssertFalse(BotName.isValid("tab\tbed"))
        XCTAssertFalse(BotName.isValid("del\u{7f}"))
        XCTAssertEqual(BotName.sanitize("Release\nCaptain"), "Release Captain")
        XCTAssertEqual(BotName.sanitize(String(repeating: "a", count: BotName.maxLength + 10)).count, BotName.maxLength)
        XCTAssertTrue(BotName.isValid(BotName.sanitize("Release\r\nCaptain\t")))
        XCTAssertNil(BotName.problem("Release Captain"))
        XCTAssertEqual(BotName.problem("  "), "Give the bot a name")
        XCTAssertTrue(BotName.problem(String(repeating: "a", count: BotName.maxLength + 1))?.contains("at most") == true)
        XCTAssertTrue(BotName.problem("a\nb")?.contains("line breaks") == true)
    }
}

/// After happy-app's sync/spawnRequestId.test.ts.
@MainActor
final class SpawnRequestsTests: XCTestCase {
    private var count = 0
    private lazy var requests = SpawnRequests(makeId: { [unowned self] in
        count += 1
        return "request-\(count)"
    })
    private let base = SpawnRequests.Signature(
        machineId: "machine-1", agent: "rig", place: "~/project", worktree: "__none__",
        modelKey: "codex/gpt-5.6-sol", permissionMode: "auto", effort: "high"
    )

    private func changed(_ change: (inout SpawnRequests.Signature) -> Void) -> SpawnRequests.Signature {
        var signature = base
        change(&signature)
        return signature
    }

    func testTheSameRequestKeepsItsKey() async {
        XCTAssertEqual(requests.requestId(for: base), "request-1")
        XCTAssertEqual(requests.requestId(for: base), "request-1")
        requests.complete()
        XCTAssertEqual(requests.requestId(for: base), "request-2")
    }

    func testAChangedRequestGetsANewKey() async {
        XCTAssertEqual(requests.requestId(for: base), "request-1")
        XCTAssertEqual(requests.requestId(for: changed { $0.permissionMode = "read_only" }), "request-2")
        XCTAssertEqual(requests.requestId(for: changed { $0.place = "~/other" }), "request-3")
    }

    func testACreatedSessionIsAbandonedOnlyWhenTheRequestChanges() async {
        let id = requests.requestId(for: base)
        var abandoned = 0
        requests.remember(id, sessionId: "created-session", abandon: { abandoned += 1 })
        XCTAssertEqual(requests.requestId(for: base), id)
        XCTAssertEqual(requests.spawnedSessionId(id), "created-session")
        XCTAssertEqual(abandoned, 0)
        let replacement = requests.requestId(for: changed { $0.machineId = "other" })
        XCTAssertEqual(abandoned, 1)
        XCTAssertNil(requests.spawnedSessionId(replacement))
        requests.complete(id)
        XCTAssertEqual(requests.requestId(for: changed { $0.machineId = "other" }), replacement, "a late completion can't erase the newer attempt")
    }

    func testAcceptedOrAdoptedSessionsAreNeverAbandoned() async {
        var abandoned = 0
        let id = requests.requestId(for: base)
        requests.remember(id, sessionId: "accepted", abandon: { abandoned += 1 })
        requests.complete(id)
        _ = requests.requestId(for: changed { $0.place = "~/different" })
        let next = requests.requestId(for: base)
        requests.remember(next, sessionId: "adopted", abandon: { abandoned += 1 })
        requests.release(sessionId: "adopted")
        _ = requests.requestId(for: changed { $0.place = "~/elsewhere" })
        XCTAssertEqual(abandoned, 0)
    }

    func testABotIsItsOwnRequest() async {
        let first = requests.requestId(for: changed { $0.bot = (name: "Release Captain", faceSeed: "abc12345") })
        XCTAssertEqual(requests.requestId(for: changed { $0.bot = (name: "Release Captain", faceSeed: "abc12345") }), first)
        XCTAssertNotEqual(requests.requestId(for: changed { $0.bot = (name: "Release Cap", faceSeed: "abc12345") }), first)
        XCTAssertNotEqual(base, changed { $0.bot = (name: "Bot", faceSeed: "abc12345") })
    }

    func testTwoAccountsKeepIdenticalRequestsAndCallbacksSeparate() async {
        let first = SpawnRequests()
        let second = SpawnRequests()
        let firstID = first.requestId(for: base)
        let secondID = second.requestId(for: base)
        XCTAssertNotEqual(firstID, secondID)
        var firstAbandoned = 0
        var secondAbandoned = 0
        var firstReleased = 0
        var secondReleased = 0
        first.remember(firstID, sessionId: "same-server-id", abandon: { firstAbandoned += 1 }, release: { firstReleased += 1 })
        second.remember(secondID, sessionId: "same-server-id", abandon: { secondAbandoned += 1 }, release: { secondReleased += 1 })
        XCTAssertNil(first.spawnedSessionId(secondID))
        XCTAssertNil(second.spawnedSessionId(firstID))
        first.release(sessionId: "same-server-id")
        XCTAssertEqual(firstReleased, 1)
        XCTAssertEqual(secondReleased, 0)
        XCTAssertEqual(second.spawnedSessionId(secondID), "same-server-id")
        _ = second.requestId(for: changed { $0.place = "~/other" })
        XCTAssertEqual(secondAbandoned, 1)
        XCTAssertEqual(firstAbandoned, 0)
    }

    func testClosedScopeCannotBeRepopulatedByLateReplies() async {
        let old = SpawnRequests()
        let current = SpawnRequests()
        let oldID = old.requestId(for: base)
        let currentID = current.requestId(for: base)
        var canceled = 0
        var abandoned = 0
        var lateAbandoned = 0
        _ = old.registerAttempt { canceled += 1 }
        old.remember(oldID, sessionId: "old", abandon: { abandoned += 1 })
        current.remember(currentID, sessionId: "current", abandon: { XCTFail("old callbacks must not abandon the new account") })
        old.close()
        old.close()
        XCTAssertTrue(old.isClosed)
        XCTAssertEqual(canceled, 1)
        XCTAssertEqual(abandoned, 1)
        old.remember(oldID, sessionId: "late", abandon: { lateAbandoned += 1 })
        XCTAssertEqual(lateAbandoned, 1)
        let ignoredID = old.requestId(for: base)
        XCTAssertNil(old.spawnedSessionId(oldID))
        XCTAssertNil(old.spawnedSessionId(ignoredID))
        XCTAssertNil(old.registerAttempt { XCTFail("closed scope registered an attempt") })
        old.complete(currentID)
        old.release(sessionId: "current")
        XCTAssertEqual(current.requestId(for: base), currentID)
        XCTAssertEqual(current.spawnedSessionId(currentID), "current")
        current.complete()
    }
}

// MARK: - Starting a session

private actor FakeOps: HomeOps {
    var spawnResults: [SpawnSessionResult] = []
    var spawned: [SpawnSessionOptions] = []
    var bashResults: [String: [SessionBashResponse]] = [:]
    var commands: [String] = []
    var stops: [String] = []
    var stopSucceeds = true
    /// While set, a spawn waits here until `answer` is called.
    var holdSpawn = false
    private var held: CheckedContinuation<Void, Never>?

    func script(_ results: [SpawnSessionResult]) { spawnResults = results }
    func scriptBash(_ command: String, _ results: [SessionBashResponse]) { bashResults[command] = results }
    func hold() { holdSpawn = true }

    func answer() {
        holdSpawn = false
        held?.resume()
        held = nil
    }

    var isHolding: Bool { held != nil }

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        spawned.append(options)
        if holdSpawn {
            holdSpawn = false
            await withCheckedContinuation { held = $0 }
        }
        return spawnResults.isEmpty ? .error(errorMessage: "unscripted") : spawnResults.removeFirst()
    }

    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult {
        .error(errorMessage: "unused")
    }

    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult {
        .error(errorMessage: "unused")
    }

    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult {
        stops.append(sessionId)
        return MachineOperationResult(success: stopSucceeds, message: nil)
    }

    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse {
        commands.append(command)
        if var results = bashResults[command], !results.isEmpty {
            let result = results.removeFirst()
            bashResults[command] = results
            return result
        }
        return SessionBashResponse(success: true, stdout: "", stderr: "", exitCode: 0, error: nil)
    }
}

private actor FakeSessionOps: HomeSessionOps {
    var kills: [String] = []
    var archives: [String] = []
    var modes: [(String, SessionAgentModesPatch)] = []
    var readyFailures = 0
    var uploads: [(sessionId: String, name: String, bytes: Data)] = []
    var avatars: [(String, SessionAvatarPicture)] = []
    var uploadFailures = 0
    var avatarFailures = 0
    private var avatarGate: CheckedContinuation<Void, Never>?
    private var holdsAvatar = false
    private var readySession: String?
    private var readyGate: CheckedContinuation<Void, Never>?

    func failReady(times: Int) { readyFailures = times }
    func holdReady(sessionId: String) { readySession = sessionId }
    var isHoldingReady: Bool { readyGate != nil }
    func releaseReady() {
        readySession = nil
        readyGate?.resume()
        readyGate = nil
    }
    func failUpload(times: Int) { uploadFailures = times }
    func failAvatar(times: Int) { avatarFailures = times }
    func holdAvatar() { holdsAvatar = true }
    var isHoldingAvatar: Bool { avatarGate != nil }

    func releaseAvatar() {
        holdsAvatar = false
        avatarGate?.resume()
        avatarGate = nil
    }

    func sessionKill(sessionId: String) async throws -> SessionKillResponse {
        kills.append(sessionId)
        return SessionKillResponse(success: true, message: "")
    }

    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {
        modes.append((sessionId, patch))
    }

    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {
        if holdsAvatar { await withCheckedContinuation { avatarGate = $0 } }
        if avatarFailures > 0 {
            avatarFailures -= 1
            throw StartTestError.notWorn
        }
        avatars.append((sessionId, picture))
    }

    func archive(sessionId: String) async throws {
        archives.append(sessionId)
    }

    func ensureSessionReady(sessionId: String) async throws {
        if readySession == sessionId {
            readySession = nil
            await withCheckedContinuation { readyGate = $0 }
        }
        if readyFailures > 0 {
            readyFailures -= 1
            throw StartTestError.notSynced
        }
    }

    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) {
        if uploadFailures > 0 {
            uploadFailures -= 1
            throw StartTestError.notUploaded
        }
        uploads.append((sessionId, name, bytes))
        return ("blob:\(name)", bytes.count)
    }
}

private enum StartTestError: Error, LocalizedError {
    case notSynced
    case notUploaded
    case notWorn
    case notPainted

    var errorDescription: String? {
        switch self {
        case .notSynced: "The message was not sent: this session has not finished syncing. Please try again."
        case .notUploaded: "Network request failed"
        case .notWorn: "RPC timed out"
        case .notPainted: "The face could not be painted."
        }
    }
}

private actor FakeSender: ChatSending {
    var sent: [(OutgoingMessage, String)] = []

    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        sent.append((message, sessionId))
        return "local-\(sent.count)"
    }

    func retry(localId: String) async throws {}
    func discard(localId: String) async throws {}
}

/// Whether the new session's agent takes pictures (`attachmentPlan`).
private final class PictureSupport: @unchecked Sendable {
    var supported = true

    func plan(_ message: OutgoingMessage) -> AttachmentSendPlan {
        let text = !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return supported
            ? AttachmentSendPlan(accepted: message.attachments, rejected: [], shouldShowUnsupportedAlert: false, shouldSendText: true)
            : AttachmentSendPlan(
                accepted: [], rejected: message.attachments,
                shouldShowUnsupportedAlert: !message.attachments.isEmpty,
                shouldSendText: message.attachments.isEmpty || text
            )
    }
}

/// Holds the plan's store read, the way a slow disk would.
private actor PlanGate {
    private var holds = false
    private var waiting: CheckedContinuation<Void, Never>?
    private(set) var reads = 0

    func hold() { holds = true }
    var isHolding: Bool { waiting != nil }

    func pass() async {
        reads += 1
        if holds { await withCheckedContinuation { waiting = $0 } }
    }

    func release() {
        holds = false
        waiting?.resume()
        waiting = nil
    }
}

private struct FakeTransport: MetadataUpdateTransport {
    func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue { .null }
}

private actor Recorder {
    var sleeps: [Int] = []
    var refreshes = 0
    var painted: [String] = []
    var paintFailures = 0
    func slept(_ ms: Int) { sleeps.append(ms) }
    func refreshed() { refreshes += 1 }
    func failPaint(times: Int) { paintFailures = times }

    func paint(_ seed: String) throws -> Data {
        if paintFailures > 0 {
            paintFailures -= 1
            throw StartTestError.notPainted
        }
        painted.append(seed)
        return Data("png:\(seed)".utf8)
    }
}

@MainActor
private final class FakePresenter: SessionStarterPresenter {
    var errors: [String] = []
    var asked: [String] = []
    var approves = true
    var faceOffers: [String] = []
    /// The answers to "Picture not set", in turn; then "Not now".
    var retriesFace: [Bool] = []

    func showStartError(_ message: String) { errors.append(message) }

    func offerBotFaceRetry(_ message: String) async -> Bool {
        faceOffers.append(message)
        return retriesFace.isEmpty ? false : retriesFace.removeFirst()
    }

    var notSupported = 0
    func showAttachmentsNotSupported() { notSupported += 1 }

    func confirmDirectoryCreation(_ directory: String) async -> Bool {
        asked.append(directory)
        return approves
    }
}

@MainActor
final class SessionStarterTests: XCTestCase {
    private let ops = FakeOps()
    private let sessionOps = FakeSessionOps()
    private let sender = FakeSender()
    private let recorder = Recorder()
    private let presenter = FakePresenter()
    private let pictures = PictureSupport()
    private let planGate = PlanGate()
    private var phases: [NewSessionStartPhase?] = []
    private lazy var requests = SpawnRequests()

    private func makeStarter(spawnRequests: SpawnRequests? = nil, ops: FakeOps? = nil) -> SessionStarter {
        let recorder = self.recorder
        let starter = SessionStarter(environment: .init(
            ops: ops ?? self.ops,
            sessionOps: sessionOps,
            sender: sender,
            metadataTransport: FakeTransport(),
            refreshSessions: { await recorder.refreshed() },
            paintBotFace: { try await recorder.paint($0) },
            attachmentPlan: { [pictures, planGate] message, _ in
                await planGate.pass()
                return pictures.plan(message)
            },
            spawnRequests: spawnRequests ?? requests,
            sleep: { await recorder.slept($0) }
        ))
        starter.presenter = presenter
        starter.onPhaseChange = { [unowned self] in phases.append($0) }
        return starter
    }

    private func launch(
        agent: NewSessionDraft.Agent = .claude,
        rig: JSONValue? = nil,
        worktree: String = "__none__",
        creator: String? = nil,
        permission: String = "default",
        model: String = "default",
        effort: String? = "medium",
        prompt: String = "Fix the build",
        attachments: [OutgoingAttachment] = [],
        bot: NewSessionLaunch.Bot? = nil
    ) -> NewSessionLaunch {
        NewSessionLaunch(
            machineId: "m1",
            agent: agent,
            rigMetadata: rig,
            absolutePath: "/Users/steve/happy",
            worktreeSelection: worktree,
            worktreeCreationMachineId: creator,
            target: nil,
            permissionMode: permission,
            modelMode: model,
            effortLevel: effort,
            prompt: prompt,
            attachments: attachments,
            signature: SpawnRequests.Signature(
                machineId: "m1", agent: agent.rawValue, place: "~/happy", worktree: worktree,
                modelKey: model, permissionMode: permission, effort: effort,
                bot: bot.map { (name: $0.name, faceSeed: $0.faceSeed) }
            ),
            bot: bot
        )
    }

    private func botLaunch(_ name: String = "Captain", seed: String = "k3x9a0b2") -> NewSessionLaunch {
        launch(
            agent: .rig, rig: RigSessionCreationTests.rigMachine, permission: "auto", model: "codex:shared-model", effort: "high",
            prompt: "", bot: NewSessionLaunch.Bot(name: name, faceSeed: seed)
        )
    }

    /// Lets detached follow-up work (mode pinning, clean-up) run.
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    func testAHappyCLISessionStartsAndGetsItsFirstMessage() async {
        await ops.script([.success(sessionId: "s1")])
        let starter = makeStarter()
        let sessionId = await starter.start(launch(), isCurrentTarget: { true })
        await settle()

        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(phases, [.spawning, .opening, nil])
        XCTAssertFalse(starter.isStarting)
        let options = await ops.spawned
        XCTAssertEqual(options.count, 1)
        XCTAssertEqual(options.first?.agent, "claude")
        XCTAssertEqual(options.first?.directory, "/Users/steve/happy")
        XCTAssertNil(options.first?.permissionMode, "Default is no override")
        XCTAssertNil(options.first?.modelMode)
        XCTAssertEqual(options.first?.effortLevel, "medium")
        let modes = await sessionOps.modes
        XCTAssertEqual(modes.first?.0, "s1")
        XCTAssertEqual(modes.first?.1, SessionAgentModesPatch(permissionMode: .string("default"), modelMode: .string("default"), effortLevel: .string("medium")))
        let sent = await sender.sent
        XCTAssertEqual(sent.first?.0, OutgoingMessage(text: "Fix the build", source: .newSession))
        XCTAssertEqual(sent.first?.1, "s1")
        XCTAssertTrue(presenter.errors.isEmpty)
    }

    func testCodexDefaultIsSentAsARealPolicy() async {
        await ops.script([.success(sessionId: "s1")])
        _ = await makeStarter().start(launch(agent: .codex, model: "gpt-6.1-sol"), isCurrentTarget: { true })
        let options = await ops.spawned
        XCTAssertEqual(options.first?.permissionMode, "default")
        XCTAssertEqual(options.first?.modelMode, "gpt-6.1-sol")
    }

    func testANewWorktreeIsCreatedFirst() async {
        await ops.script([.success(sessionId: "s1")])
        await ops.scriptBash("git worktree add -b swift-river .dev/worktree/swift-river", [
            SessionBashResponse(success: false, stdout: "", stderr: "fatal: 'swift-river' already exists", exitCode: 128, error: nil),
        ])
        // The name is random; run creation directly to pin it.
        let created = await Worktrees.create(ops: ops, machineId: "m1", basePath: "/Users/steve/happy", name: "swift-river")
        XCTAssertEqual(created, .success(Worktrees.Created(path: "/Users/steve/happy/.dev/worktree/swift-river-2", branch: "swift-river-2")))
        let commands = await ops.commands
        XCTAssertEqual(commands, [
            "git rev-parse --git-dir",
            "git worktree add -b swift-river .dev/worktree/swift-river",
            "git worktree add -b swift-river-2 .dev/worktree/swift-river-2",
        ])

        let sessionId = await makeStarter().start(launch(worktree: "__new__", creator: "m1"), isCurrentTarget: { true })
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(phases, [.worktree, .spawning, .opening, nil])
        let directory = await ops.spawned.first?.directory ?? ""
        XCTAssertTrue(directory.hasPrefix("/Users/steve/happy/.dev/worktree/"), directory)
    }

    func testAWorktreeOutsideGitSaysSo() async {
        await ops.scriptBash("git rev-parse --git-dir", [
            SessionBashResponse(success: false, stdout: "", stderr: "fatal", exitCode: 128, error: nil),
        ])
        let sessionId = await makeStarter().start(launch(worktree: "__new__", creator: "m1"), isCurrentTarget: { true })
        XCTAssertNil(sessionId)
        XCTAssertEqual(presenter.errors, ["Not a Git repository"])
        let spawned = await ops.spawned
        XCTAssertTrue(spawned.isEmpty)
    }

    func testAnExistingWorktreeIsTheDirectory() async {
        await ops.script([.success(sessionId: "s1")])
        _ = await makeStarter().start(launch(worktree: "/Users/steve/happy/.dev/worktree/calm-star"), isCurrentTarget: { true })
        let directory = await ops.spawned.first?.directory
        XCTAssertEqual(directory, "/Users/steve/happy/.dev/worktree/calm-star")
        XCTAssertEqual(phases.first, .spawning)
    }

    func testHappyAgentIsPolledWhilePending() async {
        await ops.script([
            .pending(clientRequestId: "x", retryAfterMs: 0),
            .pending(clientRequestId: "x", retryAfterMs: 60_000),
            .success(sessionId: "s2"),
        ])
        let sessionId = await makeStarter().start(
            launch(agent: .rig, rig: RigSessionCreationTests.rigMachine, permission: "auto", model: "codex:shared-model", effort: "high"),
            isCurrentTarget: { true }
        )
        await settle()
        XCTAssertEqual(sessionId, "s2")
        let sleeps = await recorder.sleeps
        XCTAssertEqual(sleeps, [250, 10_000])
        let options = await ops.spawned
        XCTAssertEqual(options.count, 3)
        XCTAssertEqual(Set(options.compactMap(\.clientRequestId)).count, 1, "every retry carries the same key")
        XCTAssertEqual(options.first?.providerId, "codex")
        XCTAssertEqual(options.first?.modelId, "shared-model")
        let modes = await sessionOps.modes
        XCTAssertTrue(modes.isEmpty, "Happy Agent keeps its own modes")
    }

    func testStillPendingAfterThreeRetriesIsReported() async {
        await ops.script(Array(repeating: .pending(clientRequestId: "x", retryAfterMs: 500), count: 4))
        let sessionId = await makeStarter().start(
            launch(agent: .rig, rig: RigSessionCreationTests.rigMachine, permission: "auto", model: "codex:shared-model", effort: "high"),
            isCurrentTarget: { true }
        )
        XCTAssertNil(sessionId)
        XCTAssertEqual(presenter.errors, [SessionStarter.Message.stillSyncing])
    }

    func testAMissingDirectoryIsCreatedOnlyWhenApproved() async {
        await ops.script([.requestToApproveDirectoryCreation(directory: "/Users/steve/new"), .success(sessionId: "s3")])
        let sessionId = await makeStarter().start(launch(), isCurrentTarget: { true })
        XCTAssertEqual(sessionId, "s3")
        XCTAssertEqual(presenter.asked, ["/Users/steve/new"])
        let options = await ops.spawned
        XCTAssertEqual(options.map(\.approvedNewDirectoryCreation), [false, true])

        presenter.approves = false
        await ops.script([.requestToApproveDirectoryCreation(directory: "/Users/steve/no")])
        let declined = await makeStarter().start(launch(prompt: "other"), isCurrentTarget: { true })
        XCTAssertNil(declined)
    }

    func testTheMachinesErrorIsShown() async {
        await ops.script([.error(errorMessage: "Directory not allowed")])
        let sessionId = await makeStarter().start(launch(), isCurrentTarget: { true })
        XCTAssertNil(sessionId)
        XCTAssertEqual(presenter.errors, ["Directory not allowed"])
        XCTAssertEqual(phases, [.spawning, nil])
    }

    func testStopHandsBackAtOnceAndPutsDownWhatArrivesLate() async {
        await ops.script([.success(sessionId: "late")])
        await ops.hold()
        let starter = makeStarter()
        let started = Task { await starter.start(launch(), isCurrentTarget: { true }) }
        while !(await ops.isHolding) { await Task.yield() }
        XCTAssertEqual(starter.phase, .spawning)

        starter.cancel()
        XCTAssertNil(starter.phase, "the composer is back at once")
        let result = await started.value
        XCTAssertNil(result)

        await ops.answer()
        for _ in 0..<200 where await recorder.refreshes == 0 { await Task.yield() }
        let stops = await ops.stops
        XCTAssertEqual(stops, ["late"], "Happy CLI's daemon is asked to stop it")
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(presenter.errors.isEmpty, "a stop is not news")
    }

    func testAccountScopeCloseCancelsHeldSpawnAndCleansUpOnlyOldReply() async {
        await ops.script([.success(sessionId: "old-late")])
        await ops.hold()
        let starter = makeStarter()
        let started = Task { await starter.start(launch(), isCurrentTarget: { true }) }
        for _ in 0..<10_000 {
            if await ops.isHolding { break }
            await Task.yield()
        }
        let holding = await ops.isHolding
        guard holding else {
            XCTFail("spawn did not reach the gate")
            starter.cancel()
            await ops.answer()
            _ = await started.value
            return
        }
        let newScope = SpawnRequests()
        let newID = newScope.requestId(for: launch().signature)
        newScope.remember(newID, sessionId: "new", abandon: { XCTFail("old account stop affected the new account") })
        requests.close()
        let result = await started.value
        XCTAssertNil(result)
        XCTAssertFalse(starter.isStarting)
        let refused = await starter.start(launch(), isCurrentTarget: { true })
        XCTAssertNil(refused, "a stopped account cannot start again")
        await ops.answer()
        for _ in 0..<10_000 {
            if await recorder.refreshes > 0 { break }
            await Task.yield()
        }
        let stops = await ops.stops
        XCTAssertEqual(stops, ["old-late"])
        let spawned = await ops.spawned
        XCTAssertEqual(spawned.count, 1)
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(newScope.requestId(for: launch().signature), newID)
        XCTAssertEqual(newScope.spawnedSessionId(newID), "new")
        newScope.complete()
    }

    func testASessionThatFailedToOpenIsReusedOnTheNextPress() async {
        await ops.script([.success(sessionId: "s4")])
        await sessionOps.failReady(times: 1)
        let first = await makeStarter().start(launch(), isCurrentTarget: { true })
        XCTAssertNil(first)
        XCTAssertEqual(presenter.errors.count, 1)

        let second = await makeStarter().start(launch(), isCurrentTarget: { true })
        XCTAssertEqual(second, "s4")
        let spawned = await ops.spawned
        XCTAssertEqual(spawned.count, 1, "the same request is not spawned twice")
    }

    func testStripAndHomeStartersDoNotCancelEachOtherAfterSpawn() async {
        let root = SpawnRequests()
        let stripOps = FakeOps()
        await stripOps.script([.success(sessionId: "strip")])
        await sessionOps.holdReady(sessionId: "strip")
        let strip = makeStarter(spawnRequests: root.child(.pendingChats), ops: stripOps)
        let stripTask = Task { await strip.start(launch(prompt: ""), isCurrentTarget: { true }) }
        for _ in 0..<10_000 {
            if await sessionOps.isHoldingReady { break }
            await Task.yield()
        }
        guard await sessionOps.isHoldingReady else {
            XCTFail("strip did not reach the ready gate")
            strip.cancel()
            root.close()
            await sessionOps.releaseReady()
            _ = await stripTask.value
            return
        }
        await ops.script([.success(sessionId: "home")])
        let home = makeStarter(spawnRequests: root)
        let homeResult = await home.start(launch(permission: "read_only"), isCurrentTarget: { true })
        XCTAssertEqual(homeResult, "home")
        XCTAssertTrue(strip.isStarting, "a different Home signature must not abandon the strip's created session")
        let prematureStops = await stripOps.stops
        XCTAssertTrue(prematureStops.isEmpty)
        await sessionOps.releaseReady()
        let stripResult = await stripTask.value
        XCTAssertEqual(stripResult, "strip")
        let stops = await stripOps.stops
        XCTAssertTrue(stops.isEmpty)
        root.close()
    }

    func testAccountStopClosesStripWithRPCHeldAndLateReplyCannotAffectNextAccount() async throws {
        let accounts = try await Task.detached {
            let first = try AccountSession(credentials: TokenStorageFixtures.typical, store: LocalStore.inMemory(),
                dependencies: .init(serverURL: ServerConfig.defaultServerURL, clientID: "test", transport: FakeHTTP(), connector: FakeConnector()))
            let second = try AccountSession(credentials: Credentials(token: "next", secret: Data(repeating: 7, count: 32)), store: LocalStore.inMemory(),
                dependencies: .init(serverURL: ServerConfig.defaultServerURL, clientID: "test", transport: FakeHTTP(), connector: FakeConnector()))
            return (first, second)
        }.value
        let root = accounts.0.spawnRequests
        let child = root.child(.pendingChats)
        let stripOps = FakeOps()
        await stripOps.script([.success(sessionId: "same-server-id")])
        await stripOps.hold()
        let strip = makeStarter(spawnRequests: child, ops: stripOps)
        let stripTask = Task { await strip.start(launch(prompt: ""), isCurrentTarget: { true }) }
        for _ in 0..<10_000 {
            if await stripOps.isHolding { break }
            await Task.yield()
        }
        guard await stripOps.isHolding else {
            XCTFail("strip RPC did not reach its gate")
            strip.cancel()
            await stripOps.answer()
            await accounts.0.stop()
            await accounts.1.stop()
            _ = await stripTask.value
            return
        }
        let stripID = child.requestId(for: launch(prompt: "").signature)
        await ops.script([.success(sessionId: "home")])
        let homeResult = await makeStarter(spawnRequests: root).start(launch(permission: "read_only"), isCurrentTarget: { true })
        XCTAssertEqual(homeResult, "home")
        XCTAssertEqual(child.requestId(for: launch(prompt: "").signature), stripID)
        let current = accounts.1.spawnRequests.child(.pendingChats)
        let currentID = current.requestId(for: launch(prompt: "").signature)
        current.remember(currentID, sessionId: "same-server-id", abandon: { XCTFail("late old-account cleanup affected the next account") })
        await accounts.0.stop()
        let canceled = await stripTask.value
        XCTAssertNil(canceled)
        XCTAssertTrue(root.isClosed)
        XCTAssertTrue(child.isClosed)
        await stripOps.answer()
        for _ in 0..<10_000 {
            if !(await stripOps.stops).isEmpty { break }
            await Task.yield()
        }
        let oldStops = await stripOps.stops
        XCTAssertEqual(oldStops, ["same-server-id"])
        XCTAssertNil(child.spawnedSessionId(stripID))
        XCTAssertEqual(current.requestId(for: launch(prompt: "").signature), currentID)
        XCTAssertEqual(current.spawnedSessionId(currentID), "same-server-id")
        XCTAssertFalse(current.isClosed)
        current.complete()
        await accounts.1.stop()
    }

    func testAChangedComposerPutsTheNewSessionDown() async {
        await ops.script([.success(sessionId: "s5")])
        await ops.setStopSucceeds(false)
        let sessionId = await makeStarter().start(launch(), isCurrentTarget: { false })
        for _ in 0..<200 where await recorder.refreshes == 0 { await Task.yield() }
        XCTAssertNil(sessionId)
        let kills = await sessionOps.kills
        XCTAssertEqual(kills, ["s5"], "the session's own kill follows a daemon that can't stop it")
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty)
    }
}

extension SessionStarterTests {
    // MARK: Pictures with the first message

    private var picture: OutgoingAttachment {
        OutgoingAttachment(fileURL: URL(fileURLWithPath: "/tmp/a.jpg"), name: "a.jpg", mimeType: "image/jpeg", size: 10, width: 4, height: 3)
    }

    func testPicturesGoWithTheFirstMessage() async {
        await ops.script([.success(sessionId: "p1")])
        let sessionId = await makeStarter().start(launch(prompt: "", attachments: [picture]), isCurrentTarget: { true })
        XCTAssertEqual(sessionId, "p1", "a picture alone is a first message")
        let sent = await sender.sent
        XCTAssertEqual(sent.first?.0.attachments, [picture])
        XCTAssertEqual(sent.first?.0.source, .newSession)
        XCTAssertEqual(presenter.notSupported, 0)
    }

    func testPicturesTheAgentCantTakeAloneSendNothing() async {
        pictures.supported = false
        await ops.script([.success(sessionId: "p2")])
        let starter = makeStarter()
        let sessionId = await starter.start(launch(prompt: "", attachments: [picture]), isCurrentTarget: { true })
        await settle()
        XCTAssertNil(sessionId)
        XCTAssertEqual(presenter.notSupported, 1)
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty)
        let kills = await sessionOps.kills
        XCTAssertTrue(kills.isEmpty, "the session the composer still asks for stays")

        // The next press opens the same session.
        pictures.supported = true
        let again = await makeStarter().start(launch(prompt: "", attachments: [picture]), isCurrentTarget: { true })
        XCTAssertEqual(again, "p2")
        let spawned = await ops.spawned
        XCTAssertEqual(spawned.count, 1)
    }

    func testPicturesTheAgentCantTakeAreNamedAndTheTextStillGoes() async {
        pictures.supported = false
        await ops.script([.success(sessionId: "p3")])
        let sessionId = await makeStarter().start(launch(prompt: "Look", attachments: [picture]), isCurrentTarget: { true })
        XCTAssertEqual(sessionId, "p3")
        XCTAssertEqual(presenter.notSupported, 1)
        let sent = await sender.sent
        XCTAssertEqual(sent.map(\.0.text), ["Look"])
    }

    func testThePlanIsReadOnlyForPictures() async {
        await ops.script([.success(sessionId: "p4")])
        _ = await makeStarter().start(launch(), isCurrentTarget: { true })
        let reads = await planGate.reads
        XCTAssertEqual(reads, 0, "a text-only start reads no plan")
    }

    func testStopWhileThePlanIsReadPutsTheSessionDown() async {
        await ops.script([.success(sessionId: "p5")])
        await planGate.hold()
        let starter = makeStarter()
        let started = Task { await starter.start(launch(attachments: [picture]), isCurrentTarget: { true }) }
        while !(await planGate.isHolding) { await Task.yield() }
        XCTAssertEqual(starter.phase, .opening)

        starter.cancel()
        XCTAssertNil(starter.phase, "the composer is back at once")
        let result = await started.value
        XCTAssertNil(result)
        for _ in 0..<200 where await recorder.refreshes == 0 { await Task.yield() }
        let stops = await ops.stops
        XCTAssertEqual(stops, ["p5"])
        await planGate.release()
        await settle()
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty, "nothing is sent after Stop")
        XCTAssertEqual(presenter.notSupported, 0)
        XCTAssertTrue(presenter.errors.isEmpty)
    }

    func testAComposerThatMovedWhileThePlanWasReadPutsTheSessionDown() async {
        await ops.script([.success(sessionId: "p6")])
        await planGate.hold()
        var current = true
        let starter = makeStarter()
        let started = Task { await starter.start(launch(attachments: [picture]), isCurrentTarget: { current }) }
        while !(await planGate.isHolding) { await Task.yield() }
        current = false
        await planGate.release()
        let result = await started.value
        XCTAssertNil(result)
        for _ in 0..<200 where await recorder.refreshes == 0 { await Task.yield() }
        let stops = await ops.stops
        XCTAssertEqual(stops, ["p6"])
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty)

        // Spent: the next press for the same start spawns again.
        await ops.script([.success(sessionId: "p7")])
        let again = await makeStarter().start(launch(attachments: [picture]), isCurrentTarget: { true })
        XCTAssertEqual(again, "p7")
    }

    // MARK: A bot's face (`wearBotFace`)

    func testABotWearsItsFaceBeforeItOpens() async {
        await ops.script([.success(sessionId: "b1")])
        let sessionId = await makeStarter().start(botLaunch(), isCurrentTarget: { true })
        await settle()

        XCTAssertEqual(sessionId, "b1")
        XCTAssertEqual(phases, [.spawning, .opening, .avatar, nil])
        let painted = await recorder.painted
        XCTAssertEqual(painted, ["k3x9a0b2"])
        let uploads = await sessionOps.uploads
        XCTAssertEqual(uploads.map(\.sessionId), ["b1"])
        XCTAssertEqual(uploads.map(\.name), ["face.png"])
        XCTAssertEqual(uploads.first?.bytes, Data("png:k3x9a0b2".utf8))
        let avatars = await sessionOps.avatars
        XCTAssertEqual(avatars.map(\.0), ["b1"])
        XCTAssertEqual(avatars.first?.1, SessionAvatarPicture(ref: "blob:face.png", size: 12, mimeType: .png))
        let sent = await sender.sent
        XCTAssertTrue(sent.isEmpty, "a bot takes no first message")
        XCTAssertTrue(presenter.faceOffers.isEmpty)
    }

    func testASessionWearsNoFace() async {
        await ops.script([.success(sessionId: "s1")])
        _ = await makeStarter().start(launch(), isCurrentTarget: { true })
        await settle()
        XCTAssertFalse(phases.contains(.avatar))
        let painted = await recorder.painted
        XCTAssertTrue(painted.isEmpty)
    }

    func testAFaceThatWontUploadStillOpensTheBotAndCanBeTriedAgain() async {
        await ops.script([.success(sessionId: "b2")])
        await sessionOps.failUpload(times: 1)
        presenter.retriesFace = [true]
        let sessionId = await makeStarter().start(botLaunch("Release Captain"), isCurrentTarget: { true })
        XCTAssertEqual(sessionId, "b2", "a missing face is no reason to lose the bot")
        for _ in 0..<200 where await sessionOps.avatars.isEmpty { await Task.yield() }

        XCTAssertEqual(presenter.faceOffers, [
            "Release Captain is ready, but its picture couldn’t be uploaded. You can try again without creating another bot.",
        ])
        let painted = await recorder.painted
        XCTAssertEqual(painted.count, 2, "Try again paints and uploads the face alone")
        let avatars = await sessionOps.avatars
        XCTAssertEqual(avatars.map(\.0), ["b2"])
        let spawned = await ops.spawned
        XCTAssertEqual(spawned.count, 1, "no second bot")
    }

    func testAFaceThatWontPaintOrBeWornSaysItWasntSet() async {
        await ops.script([.success(sessionId: "b3")])
        await recorder.failPaint(times: 1)
        presenter.retriesFace = [true]
        await sessionOps.failAvatar(times: 1)
        _ = await makeStarter().start(botLaunch(), isCurrentTarget: { true })
        for _ in 0..<200 where presenter.faceOffers.count < 2 { await Task.yield() }

        let notSet = "Captain is ready, but its picture couldn't be set. Try again."
        XCTAssertEqual(presenter.faceOffers, [notSet, notSet], "painting, then wearing, failed; Not now ends it")
        let avatars = await sessionOps.avatars
        XCTAssertTrue(avatars.isEmpty)
    }

    func testStopWhileTheFaceGoesOnPutsTheBotDown() async {
        await ops.script([.success(sessionId: "b4")])
        await sessionOps.holdAvatar()
        let starter = makeStarter()
        let started = Task { await starter.start(botLaunch(), isCurrentTarget: { true }) }
        while !(await sessionOps.isHoldingAvatar) { await Task.yield() }
        XCTAssertEqual(starter.phase, .avatar)

        starter.cancel()
        let result = await started.value
        XCTAssertNil(result)
        for _ in 0..<200 where await recorder.refreshes == 0 { await Task.yield() }
        let kills = await sessionOps.kills
        XCTAssertEqual(kills, ["b4"], "Happy Agent's kill also retires the bot")
        await sessionOps.releaseAvatar()
        XCTAssertTrue(presenter.errors.isEmpty)
    }
}

extension FakeOps {
    func setStopSucceeds(_ value: Bool) { stopSucceeds = value }
}

/// utils/worktree.ts `listWorktrees`.
final class WorktreeListTests: XCTestCase {
    func testThePorcelainSkipsTheMainCheckout() {
        let porcelain = """
        worktree /Users/steve/happy
        HEAD abc
        branch refs/heads/main

        worktree /Users/steve/happy/.dev/worktree/calm-star
        HEAD def
        branch refs/heads/calm-star

        worktree /Users/steve/happy/.dev/worktree/detached
        HEAD 123
        detached
        """
        XCTAssertEqual(Worktrees.parse(porcelain), [
            Worktrees.Entry(path: "/Users/steve/happy/.dev/worktree/calm-star", branch: "calm-star"),
            Worktrees.Entry(path: "/Users/steve/happy/.dev/worktree/detached", branch: "/Users/steve/happy/.dev/worktree/detached"),
        ])
    }
}

/// HomeDock.tsx's option derivation and useStartSessionFromDraft.ts's
/// preamble, built from stored records.
final class NewSessionChoicesTests: XCTestCase {
    private func machine(_ id: String, name: String = "MacBook", active: Bool = true, createdAt: Int64 = 1, metadata: [String: JSONValue] = [:]) -> MachineRecord {
        var values = metadata
        values["displayName"] = values["displayName"] ?? .string(name)
        values["homeDir"] = values["homeDir"] ?? .string("/Users/steve")
        return MachineRecord(
            id: id, seq: 0, createdAt: createdAt, updatedAt: 1, active: active, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(values),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private func rigMachine(_ id: String, sibling: String?, bots: Bool = false, worktrees: Bool = false) -> MachineRecord {
        var metadata = RigSessionCreationTests.rigMachine.objectValue ?? [:]
        metadata["homeDir"] = .string("/Users/steve")
        metadata["capabilities"] = .object(["newSession": .bool(true), "bots": .bool(bots), "worktrees": .bool(worktrees)])
        if let sibling { metadata["siblingMachineId"] = .string(sibling) }
        return machine(id, createdAt: 2, metadata: metadata)
    }

    private func session(_ id: String, machine: String = "m1", path: String, project: (id: String, name: String)? = nil, workspace: (id: String, name: String)? = nil) -> SessionRecord {
        var metadata: [String: JSONValue] = ["machineId": .string(machine), "path": .string(path)]
        if let project { metadata["project"] = .object(["id": .string(project.id), "name": .string(project.name)]) }
        if let workspace { metadata["workspace"] = .object(["id": .string(workspace.id), "name": .string(workspace.name)]) }
        return SessionRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: "k", decryptable: true
        )
    }

    func testAPlainClaudeDraft() {
        let choices = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "m1", selectedPath: "/Users/steve/happy"),
            machines: [machine("m1"), machine("m2", name: "Studio", active: false)],
            sessions: [session("s1", path: "/Users/steve/happy"), session("s2", path: "/tmp/other")]
        ))
        XCTAssertEqual(choices.machineOptions.map(\.name), ["MacBook", "Studio"])
        XCTAssertEqual(choices.currentMachine?.key, "m1")
        XCTAssertEqual(choices.resolvedMachineId, "m1")
        XCTAssertEqual(choices.projectOptions.map(\.name), ["~/happy", "/tmp/other"])
        XCTAssertEqual(choices.currentProject?.key, "/Users/steve/happy")
        XCTAssertFalse(choices.picksWorkspaces)
        XCTAssertEqual(choices.worktreeOptions.map(\.name), ["Create New Worktree", "No worktree"])
        XCTAssertEqual(choices.currentWorktree?.name, "No worktree")
        XCTAssertTrue(choices.listsGitWorktrees)
        XCTAssertEqual(choices.gitWorktreeMachineId, "m1")
        XCTAssertEqual(choices.resolvedPath, "/Users/steve/happy")
        XCTAssertEqual(choices.agentOptions.map(\.name), ["Claude Code", "Codex"])
        XCTAssertEqual(choices.currentAgent.name, "Claude Code")
        XCTAssertEqual(choices.currentPermission?.key, "auto")
        XCTAssertEqual(choices.permissionLabel, "Auto")
        XCTAssertEqual(choices.currentModel?.key, "claude-opus-5", "an unknown CLI keeps the old Opus")
        XCTAssertEqual(choices.currentEffort?.key, "medium")
        XCTAssertEqual(choices.promptPlaceholder, "Ask Claude Code")
        XCTAssertFalse(choices.supportsBots)
    }

    func testGitWorktreesAreOfferedByBranch() {
        let choices = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "m1", selectedPath: "~/happy", sessionType: .worktree, worktreeKey: "/Users/steve/happy/.dev/worktree/calm-star"),
            machines: [machine("m1")],
            sessions: [],
            gitWorktrees: [Worktrees.Entry(path: "/Users/steve/happy/.dev/worktree/calm-star", branch: "calm-star")]
        ))
        XCTAssertEqual(choices.worktreeOptions.map(\.name), ["Create New Worktree", "No worktree", "calm-star"])
        XCTAssertEqual(choices.currentWorktree?.name, "calm-star")
        XCTAssertEqual(choices.resolvedPath, "/Users/steve/happy")
    }

    func testAStaleMachineFallsBackToTheFirstOnlineOne() {
        let choices = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "gone"),
            machines: [machine("m1", active: false, createdAt: 5), machine("m2", name: "Studio", createdAt: 1)],
            sessions: []
        ))
        XCTAssertEqual(choices.machineOptions.map(\.key), ["m2", "m1"], "online first")
        XCTAssertEqual(choices.resolvedMachineId, "m2")
        XCTAssertEqual(NewSessionChoices.resolveMachineSelection("x", available: []), "x", "an empty catalog keeps the choice")
    }

    func testAHappyAgentProjectPicksWorkspaces() {
        let sessions = [
            session("s1", machine: "rig1", path: "/Users/steve/happy/.dev/worktree/fix", project: (id: "p1", name: "happy"), workspace: (id: "w1", name: "fix")),
            session("s2", machine: "rig1", path: "/Users/steve/happy", project: (id: "p1", name: "happy")),
        ]
        let choices = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "m1", selectedPath: "/Users/steve/happy", agentType: .rig),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1", bots: true)],
            sessions: sessions
        ))
        XCTAssertEqual(choices.machineOptions.count, 1, "one computer, two daemons")
        XCTAssertEqual(choices.agentOptions.map(\.key), ["claude", "codex", "rig"])
        XCTAssertEqual(choices.currentAgent.name, "Happy")
        XCTAssertEqual(choices.currentProject?.name, "happy")
        XCTAssertTrue(choices.picksWorkspaces)
        XCTAssertEqual(choices.worktreeOptions.map(\.name), ["Create New Workspace", "Main", "fix"])
        XCTAssertFalse(choices.listsGitWorktrees)
        XCTAssertTrue(choices.supportsBots)
        XCTAssertEqual(choices.currentModel?.key, "codex:shared-model")
        XCTAssertEqual(choices.modelSections.map(\.title), ["OpenAI Codex", "Anthropic Claude"])
        XCTAssertEqual(choices.currentEffort?.key, "high")
        XCTAssertEqual(choices.promptPlaceholder, "Ask Happy")
        XCTAssertEqual(NewSessionChoices(.init(draft: NewSessionDraft(selectedMachineId: "m1"), createsBot: true, machines: [machine("m1")], sessions: [])).promptPlaceholder, "Name your bot")
    }

    func testAComputerWithHappyAgentResolvesToItWithoutAPick() {
        let choices = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "m1", agentType: .claude),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1")],
            sessions: []
        ))
        XCTAssertEqual(choices.resolvedAgent, .rig)
        let picked = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "m1", agentType: .claude, pickedAgentType: .claude),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1")],
            sessions: []
        ))
        XCTAssertEqual(picked.resolvedAgent, .claude)
    }

    func testOpenClawHasNoWorktrees() {
        let choices = NewSessionChoices(.init(
            draft: NewSessionDraft(selectedMachineId: "m1", agentType: .openclaw),
            machines: [machine("m1")],
            sessions: []
        ))
        XCTAssertEqual(choices.worktreeOptions, [NewSessionChoices.Option(key: "__none__", name: "No worktree", description: "Not supported by OpenClaw")])
    }

    func testLabelsAndPaths() {
        XCTAssertEqual(NewSessionChoices.absolutePath("~", homeDir: "/Users/steve/"), "/Users/steve")
        XCTAssertEqual(NewSessionChoices.absolutePath("~/happy", homeDir: "/Users/steve"), "/Users/steve/happy")
        XCTAssertEqual(NewSessionChoices.absolutePath("~/happy", homeDir: "C:\\Users\\steve"), "C:\\Users\\steve\\happy")
        XCTAssertEqual(NewSessionChoices.absolutePath("~bob/x", homeDir: "/Users/steve"), "~bob/x")
        XCTAssertEqual(NewSessionChoices.absolutePath("~/x", homeDir: nil), "~/x")
        XCTAssertEqual(NewSessionChoices.relativeToHome("/Users/steve/happy", homeDir: "/Users/steve/"), "~/happy")
        XCTAssertEqual(NewSessionChoices.relativeToHome("/Users/steve", homeDir: "/Users/steve"), "~")
        XCTAssertEqual(NewSessionChoices.relativeToHome("/tmp", homeDir: "/Users/steve"), "/tmp")
        XCTAssertEqual(NewSessionChoices.promptPlaceholder(agentKey: "codex", agentName: "Codex"), "Ask Codex")
    }

    // MARK: Launch

    func testTheLaunchIsResolvedWhenStartIsPressed() throws {
        let result = NewSessionLaunch.resolve(
            draft: NewSessionDraft(selectedMachineId: "m1", selectedPath: "~/happy", agentType: .claude, permissionMode: "plan", modelMode: "claude-opus-5-5[1m]"),
            pickedAgent: .claude,
            machines: [machine("m1", metadata: ["happyCliVersion": .string("1.2.6")])],
            sessions: [],
            agentDefaultOverrides: [:],
            prompt: "  Fix it  ",
            attachments: []
        )
        let launch = try result.get()
        XCTAssertEqual(launch.machineId, "m1")
        XCTAssertEqual(launch.agent, .claude)
        XCTAssertNil(launch.rigMetadata)
        XCTAssertEqual(launch.absolutePath, "/Users/steve/happy")
        XCTAssertEqual(launch.permissionMode, "plan")
        XCTAssertEqual(launch.modelMode, "claude-opus-5-5", "a retired model key is mapped")
        XCTAssertEqual(launch.effortLevel, "medium")
        XCTAssertEqual(launch.prompt, "Fix it")
        XCTAssertEqual(launch.worktreeSelection, "__none__")
        XCTAssertEqual(launch.signature.place, "~/happy")
    }

    func testAnAgentChangeStartsFromItsDefaults() throws {
        let launch = try NewSessionLaunch.resolve(
            draft: NewSessionDraft(selectedMachineId: "m1", agentType: .claude, permissionMode: "plan", modelMode: "claude-opus-5-5"),
            pickedAgent: .codex,
            machines: [machine("m1", metadata: ["happyCliVersion": .string("1.2.6")])],
            sessions: [],
            agentDefaultOverrides: [:],
            prompt: "x",
            attachments: []
        ).get()
        XCTAssertEqual(launch.agent, .codex)
        XCTAssertEqual(launch.permissionMode, "auto")
        XCTAssertEqual(launch.modelMode, "gpt-6.1-sol")
    }

    func testRefusals() {
        func refusal(_ draft: NewSessionDraft, machines: [MachineRecord], picked: NewSessionDraft.Agent? = nil, bot: (name: String, faceSeed: String)? = nil) -> NewSessionLaunch.Refusal? {
            if case .failure(let refusal) = NewSessionLaunch.resolve(draft: draft, pickedAgent: picked, bot: bot, machines: machines, sessions: [], agentDefaultOverrides: [:], prompt: "x", attachments: []) {
                return refusal
            }
            return nil
        }
        XCTAssertEqual(refusal(NewSessionDraft(), machines: [machine("m1")]), .selectMachine)
        XCTAssertEqual(refusal(NewSessionDraft(selectedMachineId: "elsewhere"), machines: [machine("m1")]), .machineNotRegistered)
        XCTAssertEqual(refusal(NewSessionDraft(selectedMachineId: "m1"), machines: [machine("m1", active: false)]), .happyCLIOffline)
        XCTAssertEqual(refusal(NewSessionDraft(selectedMachineId: "m1"), machines: [machine("m1")], bot: (name: " ", faceSeed: "a")), .botName("Give the bot a name"))
        XCTAssertEqual(refusal(NewSessionDraft(selectedMachineId: "m1"), machines: [machine("m1"), rigMachine("rig1", sibling: "m1")], bot: (name: "Cap", faceSeed: "a")), .cannotCreateBots)
        XCTAssertEqual(refusal(NewSessionDraft(selectedMachineId: "m1", selectedProjectId: "p1"), machines: [machine("m1")], picked: .claude), .projectNeedsHappyAgent)
        XCTAssertEqual(NewSessionLaunch.Refusal.happyCLIUnavailable.errorDescription, "Happy CLI is not available on your computer. Run `happy daemon start` on your computer, then try again.")
    }

    func testHappyAgentStartsInTheCatalogByIdentity() throws {
        let sessions = [
            session("s1", machine: "rig1", path: "/Users/steve/happy/.dev/worktree/fix", project: (id: "p1", name: "happy"), workspace: (id: "w1", name: "fix")),
            session("s2", machine: "rig1", path: "/Users/steve/happy", project: (id: "p1", name: "happy")),
        ]
        let machines = [machine("m1"), rigMachine("rig1", sibling: "m1", bots: true)]
        let workspace = try NewSessionLaunch.resolve(
            draft: NewSessionDraft(selectedMachineId: "m1", selectedPath: "/Users/steve/happy", agentType: .rig, sessionType: .worktree, worktreeKey: "/Users/steve/happy/.dev/worktree/fix"),
            pickedAgent: .rig, machines: machines, sessions: sessions, agentDefaultOverrides: [:], prompt: "x", attachments: []
        ).get()
        XCTAssertEqual(workspace.machineId, "rig1")
        XCTAssertEqual(workspace.target, .workspace(id: "w1"))
        XCTAssertNotNil(workspace.rigMetadata)
        XCTAssertEqual(workspace.permissionMode, "auto")
        XCTAssertEqual(workspace.modelMode, "codex:shared-model")
        XCTAssertEqual(workspace.effortLevel, "high")

        let created = try NewSessionLaunch.resolve(
            draft: NewSessionDraft(selectedMachineId: "m1", selectedPath: "/Users/steve/happy", agentType: .rig, sessionType: .worktree),
            pickedAgent: .rig, machines: machines, sessions: sessions, agentDefaultOverrides: [:], prompt: "x", attachments: []
        ).get()
        XCTAssertEqual(created.target, .newWorkspace(projectId: "p1"))
        XCTAssertNil(created.worktreeCreationMachineId, "the catalog makes it")

        let bot = try NewSessionLaunch.resolve(
            draft: NewSessionDraft(input: "", selectedMachineId: "m1"),
            pickedAgent: nil, bot: (name: " Captain ", faceSeed: "abc"), machines: machines, sessions: sessions,
            agentDefaultOverrides: [:], prompt: "ignored", attachments: []
        ).get()
        XCTAssertEqual(bot.target, .bot(name: "Captain"))
        XCTAssertEqual(bot.prompt, "")
        XCTAssertEqual(bot.signature.bot?.name, "Captain")
        XCTAssertEqual(bot.bot, NewSessionLaunch.Bot(name: "Captain", faceSeed: "abc"), "the start knows the face to put on")
        XCTAssertNil(workspace.bot)
    }

    func testAStaleNewWorktreeFallsBackToTheMainTree() throws {
        let launch = try NewSessionLaunch.resolve(
            draft: NewSessionDraft(selectedMachineId: "m1", agentType: .openclaw, sessionType: .worktree),
            pickedAgent: .claude,
            machines: [machine("m1", metadata: ["cliAvailability": .object(["claude": .bool(true), "openclaw": .bool(true)])])],
            sessions: [], agentDefaultOverrides: [:], prompt: "x", attachments: []
        ).get()
        XCTAssertEqual(launch.agent, .claude)
        XCTAssertEqual(launch.worktreeSelection, "__new__")
        XCTAssertEqual(launch.worktreeCreationMachineId, "m1")
    }

    // MARK: The composer's corrections and picks

    @MainActor
    private func composer(_ draft: NewSessionDraft, machines: [MachineRecord], sessions: [SessionRecord] = [], ops: FakeOps = FakeOps()) async -> NewSessionComposer {
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        drafts.selectAgent(draft.agentType, picked: false, defaults: AgentDefaults.Config(permissionMode: draft.permissionMode ?? "", modelMode: draft.modelMode ?? "", effortLevel: draft.effortLevel))
        if let picked = draft.pickedAgentType { drafts.pickAgentType(picked) }
        drafts.renameMachineId(draft.selectedMachineId)
        if let path = draft.selectedPath { drafts.setPath(path) }
        drafts.setSessionType(draft.sessionType)
        drafts.setWorktreeKey(draft.worktreeKey)
        let composer = NewSessionComposer(
            drafts: drafts,
            snapshot: HomeSnapshot(machines: MachinesSnapshot(synced: true, machines: machines), sessions: sessions),
            ops: ops
        )
        await composer.waitForIdle()
        return composer
    }

    @MainActor
    func testTheComposerMovesAGoneComputerToTheFirstOffered() async {
        let composer = await composer(NewSessionDraft(selectedMachineId: "gone"), machines: [machine("m1")])
        XCTAssertEqual(composer.drafts.draft.selectedMachineId, "m1")
        XCTAssertEqual(composer.choices.currentMachine?.key, "m1")
    }

    @MainActor
    func testTheComposerFollowsTheHarnessTheComputerSettlesOn() async {
        let rig = rigMachine("rig1", sibling: "m1")
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1", agentType: .claude, permissionMode: "auto"), machines: [machine("m1"), rig])
        let creation = RigSessionCreation(metadata: rig.metadata)
        let draft = composer.drafts.draft
        XCTAssertEqual(draft.agentType, .rig)
        XCTAssertNil(draft.pickedAgentType, "following the computer is not a pick")
        XCTAssertEqual(draft.permissionMode, creation?.defaultPermissionMode)
        XCTAssertEqual(draft.modelMode, creation?.defaultModelKey)
        XCTAssertEqual(composer.choices.currentAgent.name, "Happy")
    }

    @MainActor
    func testTheComposerDropsAWorktreeTheHarnessCantMake() async {
        // Happy Agent without worktrees, in a plain directory.
        let composer = await composer(
            NewSessionDraft(selectedMachineId: "m1", selectedPath: "~/x", agentType: .rig, sessionType: .worktree),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1", worktrees: false)]
        )
        XCTAssertEqual(composer.drafts.draft.agentType, .rig)
        XCTAssertEqual(composer.drafts.draft.sessionType, .simple)
        XCTAssertNil(composer.drafts.draft.worktreeKey)
        XCTAssertEqual(composer.choices.currentWorktree?.name, "No worktree")
    }

    @MainActor
    func testPickingACatalogProjectMovesTheHarnessToHappyAgent() async {
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1", agentType: .claude, pickedAgentType: .claude), machines: [machine("m1"), rigMachine("rig1", sibling: "m1")])
        XCTAssertEqual(composer.drafts.draft.agentType, .claude)
        composer.selectProject(SessionPlaces.projectKey("p1"))
        await composer.waitForIdle()
        let draft = composer.drafts.draft
        XCTAssertEqual(draft.selectedProjectId, "p1")
        XCTAssertNil(draft.selectedPath)
        XCTAssertEqual(draft.agentType, .rig)
        XCTAssertEqual(draft.pickedAgentType, .rig)
        XCTAssertTrue(composer.choices.picksWorkspaces)
        XCTAssertEqual(composer.choices.currentProject?.name, "Project")
    }

    @MainActor
    func testACustomPathIsTrimmedAndABlankOneChangesNothing() async {
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1", selectedPath: "~/happy"), machines: [machine("m1")])
        composer.selectProject(NewSessionChoices.customPathKey)
        XCTAssertEqual(composer.drafts.draft.selectedPath, "~/happy")
        composer.selectCustomPath("   ")
        composer.selectCustomPath(nil)
        XCTAssertEqual(composer.drafts.draft.selectedPath, "~/happy")
        composer.selectCustomPath("  ~/work/api \n")
        XCTAssertEqual(composer.drafts.draft.selectedPath, "~/work/api")
    }

    @MainActor
    func testPickingAHarnessStartsItOnItsDefaults() async {
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1", agentType: .claude, pickedAgentType: .claude, permissionMode: "plan"), machines: [machine("m1")])
        composer.selectAgent("codex")
        let draft = composer.drafts.draft
        let defaults = AgentDefaults.resolve([:], .codex, cliVersion: nil)
        XCTAssertEqual(draft.agentType, .codex)
        XCTAssertEqual(draft.pickedAgentType, .codex)
        XCTAssertEqual(draft.permissionMode, defaults.permissionMode)
        XCTAssertEqual(draft.modelMode, defaults.modelMode)
        composer.selectAgent("vim")
        XCTAssertEqual(composer.drafts.draft.agentType, .codex)
    }

    @MainActor
    func testGitWorktreesAreListedForAPlainDirectory() async throws {
        let ops = FakeOps()
        await ops.scriptBash("git worktree list --porcelain", [SessionBashResponse(
            success: true,
            stdout: "worktree /Users/steve/happy\nbranch refs/heads/main\n\nworktree /Users/steve/happy/.dev/worktree/calm\nbranch refs/heads/calm",
            stderr: "", exitCode: 0, error: nil
        )])
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1", selectedPath: "~/happy"), machines: [machine("m1")], ops: ops)
        for _ in 0..<100 where composer.gitWorktrees.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(composer.gitWorktrees.map(\.branch), ["calm"])
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.worktreeOptions.map(\.name), ["Create New Worktree", "No worktree", "calm"])
        let commands = await ops.commands
        XCTAssertEqual(commands, ["git worktree list --porcelain"])
    }

    @MainActor
    func testTheBotIsResolvedFromTheDraft() async throws {
        let composer = await composer(
            NewSessionDraft(selectedMachineId: "m1"),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1", bots: true)]
        )
        let drafts = composer.drafts
        drafts.setCreatesBot(true)
        drafts.setBotName("  Captain ")
        drafts.setBotFaceSlot(2)
        let launch = try composer.launchBot().get()
        XCTAssertEqual(launch.machineId, "rig1")
        XCTAssertEqual(launch.agent, .rig)
        XCTAssertEqual(launch.target, .bot(name: "Captain"))
        XCTAssertEqual(launch.bot, NewSessionLaunch.Bot(name: "Captain", faceSeed: drafts.botFaceSeeds[2]))
        XCTAssertEqual(launch.prompt, "")
        XCTAssertTrue(launch.attachments.isEmpty)

        let started = drafts.draft
        let bot = drafts.bot
        XCTAssertTrue(composer.isCurrentTarget(started, bot: bot))
        drafts.setBotFaceSlot(1)
        XCTAssertFalse(composer.isCurrentTarget(started, bot: bot), "another face is another bot")
        drafts.setBotFaceSlot(2)
        drafts.rollBotFaces()
        XCTAssertFalse(composer.isCurrentTarget(started, bot: bot))
    }

    @MainActor
    func testBotFacesRollTogetherAndKeepTheSlot() {
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        XCTAssertEqual(drafts.botFaceSeeds.count, 4)
        XCTAssertEqual(drafts.botFaceSlot, 0)
        for seed in drafts.botFaceSeeds {
            XCTAssertEqual(seed.count, 8)
            XCTAssertTrue(seed.allSatisfy { $0.isNumber || ("a"..."z").contains($0) }, seed)
        }
        drafts.setBotFaceSlot(3)
        drafts.setBotFaceSlot(4)
        XCTAssertEqual(drafts.botFaceSlot, 3, "only the four faces on offer")
        let before = drafts.botFaceSeeds
        drafts.rollBotFaces()
        XCTAssertNotEqual(drafts.botFaceSeeds, before)
        XCTAssertEqual(drafts.botFaceSlot, 3)
        XCTAssertEqual(drafts.botFaceSeed, drafts.botFaceSeeds[3])
    }

    @MainActor
    func testABotsNameRebuildsNoPicker() async {
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1"), machines: [machine("m1"), rigMachine("rig1", sibling: "m1", bots: true)])
        var changes = 0
        composer.onChange = { changes += 1 }
        composer.drafts.setCreatesBot(true)
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.promptPlaceholder, "Name your bot")
        let choices = composer.choices
        composer.drafts.setBotName("Cap")
        composer.drafts.rollBotFaces()
        XCTAssertEqual(changes, 3, "what shows the name and faces is told")
        XCTAssertEqual(composer.choices, choices)
    }

    func testTheTargetIsWhatTheStartWasAskedFor() {
        let draft = NewSessionDraft(input: "a", selectedMachineId: "m1", selectedPath: "~/x")
        var typed = draft
        typed.input = "b"
        XCTAssertTrue(typed.sameTarget(as: draft), "the text is not the target")
        var moved = draft
        moved.selectedPath = "~/y"
        XCTAssertFalse(moved.sameTarget(as: draft))
    }
}

// MARK: - The new-session screen

extension NewSessionChoicesTests {
    private func screen(
        _ draft: NewSessionDraft,
        machines: [MachineRecord],
        sessions: [SessionRecord] = [],
        isStarting: Bool = false,
        now: Int64 = 1
    ) -> NewSessionScreenModel {
        let snapshot = HomeSnapshot(machines: MachinesSnapshot(synced: true, machines: machines), sessions: sessions)
        let choices = NewSessionChoices(.init(draft: draft, createsBot: false, snapshot: snapshot))
        return NewSessionScreenModel(choices: choices, draft: draft, snapshot: snapshot, gitWorktrees: [], isStarting: isStarting, now: now)
    }

    func testTheScreenForAPlainClaudeDraft() {
        let draft = NewSessionDraft(selectedMachineId: "m1", selectedPath: "/Users/steve/happy")
        let machines = [machine("m1"), machine("m2", name: "Studio", active: false, createdAt: 5)]
        let sessions = [session("s1", path: "/Users/steve/happy"), session("s2", path: "/tmp/other")]
        let model = screen(draft, machines: machines, sessions: sessions, now: 1 + 3 * 60_000)

        XCTAssertEqual(model.machineName, "MacBook")
        XCTAssertEqual(model.machineItems.map(\.key), ["m1", "m2"], "online first")
        XCTAssertEqual(model.machineItems.map(\.status), [.online, .lastSeen(.minutes(3))])
        XCTAssertEqual(model.machineItems.map(\.isDimmed), [false, true])
        XCTAssertEqual(model.selectedMachineKey, "m1")
        XCTAssertNil(model.offlineHelp)

        XCTAssertEqual(model.pathItems.map(\.label), ["~/happy", "/tmp/other"])
        XCTAssertEqual(model.pathName, "~/happy")
        XCTAssertEqual(model.pathValue, "/Users/steve/happy")
        XCTAssertEqual(model.matchedPathKey, "/Users/steve/happy")
        XCTAssertNil(model.selectedProjectKey)

        XCTAssertTrue(model.canPickWorktree)
        XCTAssertFalse(model.picksWorkspaces)
        XCTAssertEqual(model.worktreeFixedItems.map(\.label), ["new worktree", "no worktree"])
        XCTAssertEqual(model.worktreeLabel, "no worktree")

        XCTAssertEqual(model.agentItems.map(\.label), ["claude code", "codex"])
        XCTAssertEqual(model.agentLabel, "claude code")
        XCTAssertEqual(model.placeholder, "Ask claude code")
        XCTAssertFalse(model.isCodex)
        XCTAssertEqual(model.settings.map(\.kind), [.permission, .model, .effort])
        XCTAssertEqual(model.settings[0].value, "Auto")
        XCTAssertEqual(model.settings[0].icon, "shield-outline", "the ambient mode has no accent")

        XCTAssertTrue(model.canSend, "no prompt needed")
        XCTAssertFalse(screen(draft, machines: machines, sessions: sessions, isStarting: true).canSend)
    }

    func testAnOfflineDaemonStopsSendAndExplains() {
        let model = screen(NewSessionDraft(selectedMachineId: "m1"), machines: [machine("m1", active: false)])
        XCTAssertEqual(model.offlineHelp, .happyCLI)
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(model.pathName, "~")
        XCTAssertFalse(screen(NewSessionDraft(), machines: [machine("m1")]).canSend, "a computer must be chosen")
    }

    func testCodexWordsItsOwnPlaceholder() {
        let model = screen(NewSessionDraft(selectedMachineId: "m1", agentType: .codex, pickedAgentType: .codex), machines: [machine("m1")])
        XCTAssertEqual(model.agentLabel, "codex")
        XCTAssertEqual(model.placeholder, "Ask Codex")
        XCTAssertTrue(model.isCodex)
    }

    func testAHappyAgentProjectOffersItsWorkspaces() {
        let sessions = [
            session("s1", machine: "rig1", path: "/Users/steve/happy/.dev/worktree/fix", project: (id: "p1", name: "happy"), workspace: (id: "w1", name: "fix")),
            session("s2", machine: "rig1", path: "/Users/steve/happy", project: (id: "p1", name: "happy")),
        ]
        let model = screen(
            NewSessionDraft(selectedMachineId: "m1", selectedPath: "/Users/steve/happy", agentType: .rig, pickedAgentType: .rig),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1")],
            sessions: sessions
        )
        XCTAssertEqual(model.pathItems, [NewSessionScreenModel.Item(key: "/Users/steve/happy", label: "happy", subtitle: "~/happy")])
        XCTAssertEqual(model.matchedPathKey, "/Users/steve/happy")
        XCTAssertTrue(model.picksWorkspaces)
        XCTAssertEqual(model.worktreeFixedItems.map(\.label), ["Create New", "Main"])
        XCTAssertEqual(model.worktreeItems.map(\.label), ["fix"])
        XCTAssertEqual(model.worktreeLabel, "Main")
        XCTAssertEqual(model.agentItems.map(\.key), ["claude", "codex", "rig"])
        XCTAssertEqual(model.agentLabel, "happy")
        XCTAssertEqual(model.placeholder, "Ask happy")
        XCTAssertEqual(model.settings.map(\.kind), [.permission, .model, .effort])
        XCTAssertEqual(model.settings[0].icon, "shield-outline")
        XCTAssertEqual(model.settings[1].items.compactMap(\.section), ["OpenAI Codex", "Anthropic Claude"])
        XCTAssertTrue(model.canSend)
    }

    func testACatalogProjectWithNoChatsLeftKeepsItsRow() {
        let model = screen(
            NewSessionDraft(selectedMachineId: "m1", selectedProjectId: "p9", agentType: .rig, pickedAgentType: .rig),
            machines: [machine("m1"), rigMachine("rig1", sibling: "m1")]
        )
        XCTAssertEqual(model.pathItems, [NewSessionScreenModel.Item(key: "project:p9", label: "Project", projectId: "p9")])
        XCTAssertEqual(model.selectedProjectKey, "project:p9")
        XCTAssertEqual(model.selectedProjectName, "Project")
        XCTAssertEqual(model.pathName, "Project")
        XCTAssertEqual(model.fieldValue(for: model.pathItems[0]), "", "a project has no folder to type")
        XCTAssertTrue(model.worktreeItems.isEmpty)
    }

    func testPathsAndIcons() {
        XCTAssertEqual(NewSessionScreenModel.normalizedPath(" ~/happy/ ", homeDir: "/Users/steve"), "/Users/steve/happy")
        XCTAssertEqual(NewSessionScreenModel.normalizedPath("/", homeDir: nil), "/")
        XCTAssertEqual(NewSessionScreenModel.normalizedPath("C:\\", homeDir: nil), "C:\\")
        XCTAssertNil(NewSessionScreenModel.normalizedPath("  ", homeDir: nil))
        XCTAssertEqual(NewSessionScreenModel.permissionIcon("plan"), "pause")
        XCTAssertEqual(NewSessionScreenModel.permissionIcon("yolo"), "play-forward")
        XCTAssertNil(NewSessionScreenModel.permissionIcon("default"))
    }

    @MainActor
    func testTheScreensPicks() async {
        let composer = await composer(NewSessionDraft(selectedMachineId: "m1", agentType: .claude, pickedAgentType: .claude, permissionMode: "plan"), machines: [machine("m1"), rigMachine("rig1", sibling: "m1")])
        composer.pickAgent("codex")
        XCTAssertEqual(composer.drafts.draft.agentType, .codex)
        XCTAssertEqual(composer.drafts.draft.pickedAgentType, .codex)
        XCTAssertEqual(composer.drafts.draft.permissionMode, "plan", "the harness alone")
        composer.pickAgent("openclaw")
        XCTAssertEqual(composer.drafts.draft.agentType, .codex, "not offered here")

        composer.typePath("~/w")
        XCTAssertEqual(composer.drafts.draft.selectedPath, "~/w", "as typed")
        composer.pickProject("p1")
        XCTAssertEqual(composer.drafts.draft.selectedProjectId, "p1")
        XCTAssertNil(composer.drafts.draft.selectedPath)
        XCTAssertEqual(composer.drafts.draft.agentType, .rig)
    }

    @MainActor
    func testAProjectsPlusPreparesANewWorkspace() {
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        drafts.setInput("keep")
        drafts.prepareWorkspace(WorkspaceOrigin(machineId: "m1", projectId: nil, path: "/src/happy"))
        XCTAssertEqual(drafts.draft.selectedMachineId, "m1")
        XCTAssertEqual(drafts.draft.selectedPath, "/src/happy")
        XCTAssertEqual(drafts.draft.sessionType, .worktree)
        XCTAssertNil(drafts.draft.worktreeKey)
        XCTAssertEqual(drafts.draft.input, "keep")

        drafts.prepareWorkspace(WorkspaceOrigin(machineId: "m2", projectId: "p1", path: nil))
        XCTAssertEqual(drafts.draft.selectedProjectId, "p1")
        XCTAssertNil(drafts.draft.selectedPath)
        XCTAssertEqual(drafts.draft.pickedAgentType, .rig)
    }
}
