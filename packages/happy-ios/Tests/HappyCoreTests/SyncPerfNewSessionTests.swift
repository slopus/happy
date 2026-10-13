import Foundation
import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

private struct PickerNoOps: HomeOps {
    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult { .error(errorMessage: "unused") }
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult { .error(errorMessage: "unused") }
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult { .error(errorMessage: "unused") }
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { .init(success: false, message: nil) }
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse {
        .init(success: false, stdout: "", stderr: "unused", exitCode: 1, error: nil)
    }
}

final class SyncPerfNewSessionTests: XCTestCase {
    private func snapshot(count: Int = 1000) -> HomeSnapshot {
        let machine = MachineRecord(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, metadataCipher: "", metadata: .object(["host": .string("fixed"), "homeDir": .string("/home"),
                "cliAvailability": .object(["claude": .bool(true), "codex": .bool(true)])]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true)
        let rows = (0..<count).map { index in
            var row = ChatRecords.storeSession("s\(index)")
            row.metadata = .object(["machineId": .string("m"), "path": .string("/work/\(index)"), "title": .string("ignored")])
            return row
        }
        return HomeSnapshot(machines: .init(synced: true, machines: [machine]), sessions: rows)
    }

    @MainActor
    func testThousandSessionUnrenderedChangesRebuildNoPickersAndPublishNothing() async {
        let violations = PageCounter()
        let oldEnforcement = ThreadRules.isEnforced
        let oldHandler = ThreadRules.violationHandler
        ThreadRules.violationHandler = { _ in violations.count += 1 }
        ThreadRules.isEnforced = true
        defer { ThreadRules.isEnforced = oldEnforcement; ThreadRules.violationHandler = oldHandler }
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        drafts.renameMachineId("m")
        let deriver = NewSessionChoiceDeriver()
        let original = snapshot()
        let composer = NewSessionComposer(drafts: drafts, snapshot: original, ops: PickerNoOps(), deriver: deriver)
        await composer.waitForIdle()
        let initialCount = await deriver.derivationCount
        XCTAssertEqual(initialCount, 1)
        var changes = 0
        composer.onChange = { changes += 1 }
        var next = original
        for index in next.sessions.indices {
            next.sessions[index].unread = true
            next.sessions[index].seq += 1
            next.sessions[index].metadataVersion += 1
            next.sessions[index].agentState = .object(["ignored": .bool(true)])
            var metadata = next.sessions[index].metadata?.objectValue ?? [:]
            metadata["title"] = .string("still ignored")
            next.sessions[index].metadata = .object(metadata)
        }
        next.presenceNow = 2_000_000
        next.sessionsSynced = true
        next.settings.profile = AccountProfile(id: "unused", timestamp: 1, firstName: "ignored")
        composer.update(snapshot: next)
        await composer.waitForIdle()
        let unchangedCount = await deriver.derivationCount
        XCTAssertEqual(unchangedCount, initialCount)
        XCTAssertEqual(changes, 0)

        var metadata = next.sessions[0].metadata?.objectValue ?? [:]
        metadata["path"] = .string("/work/changed")
        next.sessions[0].metadata = .object(metadata)
        composer.update(snapshot: next)
        await composer.waitForIdle()
        let changedCount = await deriver.derivationCount
        XCTAssertEqual(changedCount, initialCount + 1)
        XCTAssertEqual(changes, 1)
        XCTAssertTrue(composer.choices.projectOptions.contains { $0.key == "/work/changed" })
        XCTAssertEqual(violations.count, 0, "catalog projection, model derivation and equality run off main")
    }

    @MainActor
    func testDraftTypingReusesCatalogAndLateBootstrapCannotRestoreOldTarget() async throws {
        let held = Gate(), requested = Gate(), finished = Gate()
        let deriver = NewSessionChoiceDeriver { _, draft in
            if draft.selectedPath == "/old" {
                await requested.open()
                await held.wait()
                await finished.open()
            }
        }
        defer { Task { await held.open() } }
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        drafts.renameMachineId("m")
        drafts.setPath("/old")
        let composer = NewSessionComposer(drafts: drafts, snapshot: snapshot(count: 2), ops: PickerNoOps(), deriver: deriver)
        try await syncPerfWait(requested)
        drafts.setPath("/new")
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.resolvedPath, "/new")
        let settledCount = await deriver.derivationCount
        let settledProjections = await deriver.catalogProjectionCount
        var changes = 0
        composer.onChange = { changes += 1 }
        for index in 0..<50 { drafts.setInput("typed \(index)") }
        await composer.waitForIdle()
        let typedCount = await deriver.derivationCount
        let typedProjections = await deriver.catalogProjectionCount
        XCTAssertEqual(typedCount, settledCount, "text edits never rebuild chooser models")
        XCTAssertEqual(typedProjections, settledProjections, "text edits never sort or project the account catalog")
        XCTAssertEqual(changes, 1, "draft notifications coalesce while the actor is preparing")
        await held.open()
        try await syncPerfWait(finished)
        XCTAssertEqual(drafts.draft.selectedPath, "/new")
        XCTAssertEqual(composer.choices.resolvedPath, "/new")
    }

    @MainActor
    func testPickerOrderFollowsActiveMeaningfulActivityAndIgnoresBackgroundTimestamps() async {
        var catalog = snapshot(count: 4)
        for index in catalog.sessions.indices {
            var metadata = catalog.sessions[index].metadata?.objectValue ?? [:]
            metadata["lastMeaningfulMessageAt"] = .number(Double(30 - index * 10))
            if index == 3 { metadata["isSideChat"] = .bool(true) }
            catalog.sessions[index].metadata = .object(metadata)
        }
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        drafts.renameMachineId("m")
        let deriver = NewSessionChoiceDeriver()
        let composer = NewSessionComposer(drafts: drafts, snapshot: catalog, ops: PickerNoOps(), deriver: deriver)
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.projectOptions.filter { !$0.isAction }.map(\.key), ["~", "/work/0", "/work/1", "/work/2"])
        let initialCount = await deriver.derivationCount
        catalog.sessions.reverse()
        for index in catalog.sessions.indices { catalog.sessions[index].updatedAt = Int64(index * 1000) }
        composer.update(snapshot: catalog)
        await composer.waitForIdle()
        let backgroundCount = await deriver.derivationCount
        XCTAssertEqual(backgroundCount, initialCount)
        XCTAssertEqual(composer.choices.projectOptions.filter { !$0.isAction }.map(\.key), ["~", "/work/0", "/work/1", "/work/2"])

        let recent = catalog.sessions.firstIndex { $0.id == "s2" }!
        var metadata = catalog.sessions[recent].metadata?.objectValue ?? [:]
        metadata["lastMeaningfulMessageAt"] = .number(100)
        catalog.sessions[recent].metadata = .object(metadata)
        composer.update(snapshot: catalog)
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.projectOptions.filter { !$0.isAction }.map(\.key), ["~", "/work/2", "/work/0", "/work/1"])
        catalog.sessions[recent].active = false
        composer.update(snapshot: catalog)
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.projectOptions.filter { !$0.isAction }.map(\.key), ["~", "/work/0", "/work/1", "/work/2"])
    }

    @MainActor
    func testPrivateRetryDefaultsInstallWithoutAVisibleChangeCallback() async {
        var catalog = snapshot(count: 0)
        catalog.machines.machines[0].metadata = .object([
            "machineKind": .string("rig"), "capabilities": .object(["newSession": .bool(true)]),
            "sessionCreation": .object(["pendingRetryAfterMs": .number(250)]),
        ])
        let drafts = NewSessionDraftStore(settings: LocalSettings(storage: InMemoryKeyValueStore()))
        drafts.renameMachineId("m")
        drafts.pickAgentType(.rig)
        let composer = NewSessionComposer(drafts: drafts, snapshot: catalog, ops: PickerNoOps())
        await composer.waitForIdle()
        var callbacks = 0
        composer.onChange = { callbacks += 1 }
        var metadata = catalog.machines.machines[0].metadata?.objectValue ?? [:]
        metadata["sessionCreation"] = .object(["pendingRetryAfterMs": .number(500)])
        catalog.machines.machines[0].metadata = .object(metadata)
        composer.update(snapshot: catalog)
        await composer.waitForIdle()
        XCTAssertEqual(composer.choices.rigSelectionCreation?.pendingRetryAfterMs, 500)
        XCTAssertEqual(callbacks, 0, "private defaults update without touching currently rendered picker rows")
    }
}