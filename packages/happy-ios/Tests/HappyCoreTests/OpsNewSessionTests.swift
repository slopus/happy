import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private actor PendingDelivery {
    var sent: [String] = []
    var drafts: [String: String] = [:]
    var rejects: String?
    init(rejects: String? = nil) { self.rejects = rejects }
    func send(_ sessionId: String, _ message: String) -> Bool {
        sent.append(message)
        return message != rejects
    }
    func write(_ sessionId: String, _ text: String) { drafts[sessionId] = text }
    func read(_ sessionId: String) -> String? { drafts[sessionId] ?? "" }
}

final class OpsNewSessionTests: XCTestCase {
    func testProgressAndPrimaryAction() {
        XCTAssertNil(NewSessionProgress.label(phase: nil, agentName: "Codex", picksWorkspaces: false))
        XCTAssertEqual(NewSessionProgress.label(phase: .worktree, agentName: "Codex", picksWorkspaces: true), "Creating workspace…")
        XCTAssertEqual(NewSessionProgress.label(phase: .worktree, agentName: "Codex", picksWorkspaces: false), "Creating worktree…")
        XCTAssertEqual(NewSessionProgress.label(phase: .spawning, agentName: "Codex", picksWorkspaces: false), "Starting Codex…")
        XCTAssertEqual(NewSessionProgress.label(phase: .spawning, agentName: "Happy", picksWorkspaces: false, createsBot: true), "Creating bot…")
        XCTAssertEqual(NewSessionProgress.label(phase: .opening, agentName: "Happy", picksWorkspaces: false, createsBot: true), "Opening bot…")
        XCTAssertEqual(NewSessionProgress.label(phase: .avatar, agentName: "Happy", picksWorkspaces: false), "Putting on a face…")
        XCTAssertEqual(NewSessionProgress.primaryAction(canSubmit: true, phase: .spawning, canCancel: true), .stop)
        XCTAssertEqual(NewSessionProgress.primaryAction(canSubmit: true, phase: .opening, canCancel: false), .busy)
        XCTAssertEqual(NewSessionProgress.primaryAction(canSubmit: true, phase: nil, canCancel: false), .send)
        XCTAssertEqual(NewSessionProgress.primaryAction(canSubmit: false, phase: nil, canCancel: false), .idle)
    }

    func testDefaultsReuseAccountOverridesAndCLICompatibility() {
        let settings = AccountSettings(["agentDefaultOverrides": .object(["claude": .object(["permissionMode": .string("acceptEdits"), "effortLevel": .string("high")])])])
        let config = NewSessionDefaults.resolve(agent: .claude, settings: settings, cliVersion: "1.2.0")
        XCTAssertEqual(config.permissionMode, "acceptEdits")
        XCTAssertEqual(config.effortLevel, "high")
        XCTAssertEqual(config.modelMode, "claude-opus-5")
        let preserved: JSONValue = .array([.object(["machineId": .string("m"), "path": .string("/old")])])
        XCTAssertEqual(AccountSettings(["recentMachinePaths": preserved]).syncPayload["recentMachinePaths"], preserved)
    }

    func testPendingDraftSubmitAndSettlementIdentity() async {
        let pending = PendingChats()
        let chat = await pending.open(anchorSessionId: "anchor", knownSessionIds: ["old"])
        XCTAssertTrue(PendingChats.isPendingChatId(chat.id))
        await pending.setDraft(id: chat.id, draft: "first")
        await pending.submit(id: chat.id, message: "first")
        await pending.submit(id: chat.id, message: "  ")
        await pending.setDraft(id: chat.id, draft: "second")
        let before = await pending.get(id: chat.id)
        XCTAssertEqual(before?.queued, ["first"])
        XCTAssertEqual(before?.draft, "second")
        await pending.settle(id: chat.id, sessionId: "real")
        await pending.setDraft(id: chat.id, draft: "late")
        await pending.settle(id: chat.id, sessionId: "other")
        let after = await pending.get(id: chat.id)
        XCTAssertEqual(after?.sessionId, "real")
        XCTAssertEqual(after?.draft, "second")
        XCTAssertEqual(after?.knownSessionIds, ["old"])
    }

    func testHandoverSendsInOrderAndReturnsRejectedTailToDraft() async throws {
        let pending = PendingChats()
        let chat = await pending.open(anchorSessionId: "anchor", knownSessionIds: [])
        for text in [" first ", "second", "third"] { await pending.submit(id: chat.id, message: text) }
        await pending.setDraft(id: chat.id, draft: "still typing")
        let delivery = PendingDelivery(rejects: "second")
        try await pending.handOver(id: chat.id, sessionId: "real", send: { await delivery.send($0, $1) }, writeDraft: { await delivery.write($0, $1) })
        let sent = await delivery.sent
        let draft = await delivery.read("real")
        let settled = await pending.get(id: chat.id)
        XCTAssertEqual(sent, ["first", "second"])
        XCTAssertEqual(draft, "second\n\nthird\n\nstill typing")
        XCTAssertEqual(settled?.sessionId, "real")
        try await pending.handOver(id: chat.id, sessionId: "real", send: { await delivery.send($0, $1) }, writeDraft: { await delivery.write($0, $1) })
        let again = await delivery.sent
        XCTAssertEqual(again, sent)
    }

    func testFailureReturnsWritingAheadOfAnchorDraftExactlyOnce() async throws {
        let pending = PendingChats()
        let chat = await pending.open(anchorSessionId: "anchor", knownSessionIds: [])
        await pending.submit(id: chat.id, message: "queued")
        await pending.setDraft(id: chat.id, draft: "new thought")
        let delivery = PendingDelivery()
        await delivery.write("anchor", "anchor thought")
        for _ in 0..<2 {
            try await pending.retire(id: chat.id, readDraft: { await delivery.read($0) }, writeDraft: { await delivery.write($0, $1) })
        }
        let draft = await delivery.read("anchor")
        let failed = await pending.get(id: chat.id)
        XCTAssertEqual(draft, "queued\n\nnew thought\n\nanchor thought")
        XCTAssertEqual(failed?.status, .failed)
        _ = await pending.open(anchorSessionId: "anchor", knownSessionIds: [])
        let swept = await pending.get(id: chat.id)
        XCTAssertNil(swept)
    }

    func testKeystrokesDuringAsyncDraftPersistenceAreIncludedBeforeSettlement() async throws {
        let pending = PendingChats()
        let chat = await pending.open(anchorSessionId: "anchor", knownSessionIds: [])
        await pending.setDraft(id: chat.id, draft: "first")
        let delivery = PendingDelivery()
        try await pending.handOver(id: chat.id, sessionId: "real", send: { _, _ in true }, writeDraft: { session, text in
            if text == "first" { await pending.setDraft(id: chat.id, draft: "latest keystrokes") }
            await delivery.write(session, text)
        })
        let draft = await delivery.read("real")
        let settled = await pending.get(id: chat.id)
        XCTAssertEqual(draft, "latest keystrokes")
        XCTAssertEqual(settled?.sessionId, "real")
    }

    func testRetireReturnsTextToExistingAnchorWithoutDraftAndSkipsAbsentAnchor() async throws {
        for exists in [true, false] {
            let pending = PendingChats()
            let chat = await pending.open(anchorSessionId: "anchor", knownSessionIds: [])
            await pending.submit(id: chat.id, message: "queued")
            await pending.setDraft(id: chat.id, draft: "typing")
            let delivery = PendingDelivery()
            try await pending.retire(
                id: chat.id, readDraft: { _ in exists ? "" : nil },
                writeDraft: { await delivery.write($0, $1) }
            )
            let returned = await delivery.drafts["anchor"]
            XCTAssertEqual(returned, exists ? "queued\n\ntyping" : nil)
            let failed = await pending.get(id: chat.id)
            XCTAssertEqual(failed?.status, .failed)
        }
    }

    func testMachineChoiceResolvesSiblingHarnessAndWorktreeMachine() throws {
        let store = try LocalStore.inMemory()
        func machine(_ id: String, _ metadata: JSONValue) -> MachineRecord {
            MachineRecord(
                id: id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadataVersion: 1,
                metadataCipher: "", metadata: metadata, daemonStateVersion: 0, daemonStateCipher: nil,
                daemonState: nil, dataKeyCipher: nil, decryptable: false
            )
        }
        try store.upsertMachine(machine("cli", .object(["host": .string("host"), "cliAvailability": .object(["claude": .bool(false), "codex": .bool(true), "agy": .bool(false)])])))
        try store.upsertMachine(machine("rig", .object(["host": .string("host"), "machineKind": .string("rig"), "siblingMachineId": .string("cli")])) )
        let choices = MachineChoice.collect(try store.machines())
        let choice = try XCTUnwrap(MachineChoice.find(in: choices, machineId: "rig"))
        XCTAssertEqual(choice.availableAgents, ["codex", "rig"])
        XCTAssertEqual(choice.resolveNewSessionAgent(stored: "claude", picked: nil), "rig")
        XCTAssertEqual(choice.resolveNewSessionAgent(stored: "claude", picked: "codex"), "codex")
        XCTAssertEqual(choice.resolveAgent("gemini"), "codex")
        XCTAssertEqual(choice.machine(forAgent: "rig")?.id, "rig")
        XCTAssertEqual(choice.worktreeCreationMachine(agent: "rig", agentSupportsWorktrees: false)?.id, "cli")
        XCTAssertNil(choice.worktreeCreationMachine(agent: "codex", agentSupportsWorktrees: false))
    }

    func testPathPickerPrefersNamedProjectAndOffersWorkspaceOnlyProjectByIdentity() throws {
        let fixture = ServerFixture()
        func session(_ id: String, _ metadata: JSONValue) -> SessionRecord {
            var row = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session(id, updatedAt: 1))
            row.metadata = metadata
            return row
        }
        let rows = [
            session("workspace", .object([
                "machineId": .string("rig"), "path": .string("/worktrees/w"),
                "project": .object(["id": .string("p2"), "name": .string("Only workspaces")]),
                "workspace": .object(["id": .string("w"), "name": .string("Fix")]),
            ])),
            session("named", .object(["machineId": .string("rig"), "path": .string("/repo"), "project": .object(["id": .string("p1"), "name": .string("Project")])])),
            session("bare", .object(["machineId": .string("cli"), "path": .string("/repo")])),
            session("archived", .object(["machineId": .string("rig"), "path": .string("/gone"), "lifecycleState": .string("archived")])),
            session("other", .object(["machineId": .string("other"), "path": .string("/unrelated")])),
        ]
        let places = SessionPlaces.collect(machineIds: ["rig", "cli"], sessions: rows, selectedPath: " /selected ")
        XCTAssertEqual(places.map(\.key), ["/selected", "/repo", "project:p2"])
        XCTAssertEqual(places[1].name, "Project")
        XCTAssertNil(places[2].path)
        XCTAssertEqual(SessionPlaces.projectId(from: "project:p2"), "p2")
        let workspaces = SessionPlaces.workspaces(machineIds: ["rig", "cli"], projectId: "p2", sessions: rows)
        XCTAssertEqual(workspaces.first?.name, "Fix")
        XCTAssertEqual(workspaces.first?.path, "/worktrees/w")
    }
}
