#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A server that answers nothing: the account never leaves this phone.
private struct NoServer: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Held shut until a test lets what waits on it through.
private actor Gate {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private(set) var arrived = 0

    func wait() async {
        arrived += 1
        if isOpen { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    func open() {
        isOpen = true
        for continuation in waiting { continuation.resume() }
        waiting.removeAll()
    }
}

/// The relay and the outbox a call's tools reach (`LegacyCallTargets.Relay`):
/// what was switched, kept and started, counted; each chat the store's own,
/// with its open subscriptions counted.
private final class FakeRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var _enqueued: [String] = []
    private var _switches = 0
    private var _starts = 0
    private var _open = 0
    private var _failSwitches = 0
    private var _requests: [ObjectIdentifier] = []

    var switchGate: Gate?
    var picksGate: Gate?
    var startGate: Gate?
    /// What a start makes, once its gate lets it.
    var made: (@MainActor () async throws -> String)?

    var enqueued: [String] { lock.withLock { _enqueued } }
    var switches: Int { lock.withLock { _switches } }
    var starts: Int { lock.withLock { _starts } }
    /// The spawn requests each start ran under.
    var requests: [ObjectIdentifier] { lock.withLock { _requests } }
    /// Chat subscriptions still open.
    var open: Int { lock.withLock { _open } }
    /// The next switches fail.
    func failSwitches(_ count: Int) { lock.withLock { _failSwitches = count } }

    func relay(_ feed: LocalChatFeed) -> LegacyCallTargets.Relay {
        LegacyCallTargets.Relay(
            picks: { [self] _ in
                await picksGate?.wait()
                return ComposerPicks()
            },
            chats: { [self] id in
                AsyncStream { continuation in
                    lock.withLock { _open += 1 }
                    let forward = Task {
                        for await snapshot in feed.snapshots(sessionId: id) { continuation.yield(snapshot) }
                        continuation.finish()
                    }
                    continuation.onTermination = { [self] _ in
                        forward.cancel()
                        lock.withLock { _open -= 1 }
                    }
                }
            },
            switchModes: { [self] _, _ in
                lock.withLock { _switches += 1 }
                await switchGate?.wait()
                let fails = lock.withLock { () -> Bool in
                    defer { _failSwitches = max(0, _failSwitches - 1) }
                    return _failSwitches > 0
                }
                if fails { throw URLError(.timedOut) }
            },
            enqueue: { [self] text, sessionId in
                lock.withLock { _enqueued.append("\(sessionId): \(text)") }
                return .queued
            },
            start: { [self] _, requests, _ in
                lock.withLock {
                    _starts += 1
                    _requests.append(ObjectIdentifier(requests))
                }
                await startGate?.wait()
                // As SessionStarter does: a closed scope starts nothing.
                guard !requests.isClosed else { return .failure(LegacyNewWork.Refusal(reason: "stopped")) }
                guard let made else { return .failure(LegacyNewWork.Refusal(reason: "nothing to make")) }
                do { return .success(try await made()) } catch { return .failure(LegacyNewWork.Refusal(reason: "\(error)")) }
            }
        )
    }
}

/// A call's tools over a Happy account (`LegacyCallTargets`), against a
/// fake relay and outbox: a send under one message ID goes once however
/// often it is retried, the checks before it is kept run again after the
/// model switch's wait, and a follow holds one chat subscription, none
/// once the call or the follow is gone.
@MainActor
final class HostedLegacyCallTargetsTests: XCTestCase {
    private let secret = Data(repeating: 5, count: 32)
    private var accounts: AccountController?
    private var targets: LegacyCallTargets?
    private var directory: URL?

    override func tearDown() async throws {
        targets?.close()
        targets = nil
        if let session = accounts?.session {
            await session.stop()
            try? session.store.close()
        }
        accounts = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        NetworkPath.shared.force(nil)
        try await super.tearDown()
    }

    private func until(_ what: String, _ seconds: Double = 10, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
        throw CancellationError()
    }

    /// A Happy Agent session on the harness computer: one that is no
    /// longer running stays listed, so "inactive" is its own case.
    private static func record(_ id: String, seq: Int, active: Bool = true, archived: Bool = false, asking: Bool = false) -> SessionRecord {
        let base = SeededAccount.base + 900_000
        var metadata: [String: JSONValue] = [
            "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
            "machineId": .string(SeededAccount.machineId), "flavor": .string("claude"), "client": .object(["id": .string("rig")]),
            "summary": .object(["text": .string("Voice probe \(id)"), "updatedAt": .number(Double(base))]),
        ]
        if archived { metadata["lifecycleState"] = .string("archived") }
        var state: [String: JSONValue] = ["controlledByUser": .bool(false)]
        if asking { state["requests"] = .object(["r1": .object(["tool": .string("Bash"), "arguments": .object([:])])]) }
        return SessionRecord(
            id: id, seq: seq, createdAt: base, updatedAt: base + Int64(seq), active: active, activeAt: Int64(Date().timeIntervalSince1970 * 1000),
            projectId: nil, metadataVersion: seq, metadataCipher: "harness", metadata: .object(metadata),
            agentStateVersion: seq, agentStateCipher: nil, agentState: .object(state), dataKeyCipher: nil, decryptable: true
        )
    }

    /// A computer whose Happy Agent starts tasks.
    private static let rigMachine = MachineRecord(
        id: "rig-mac", seq: 1, createdAt: SeededAccount.base, updatedAt: SeededAccount.base, active: true,
        activeAt: Int64(Date().timeIntervalSince1970 * 1000), metadataVersion: 1, metadataCipher: "harness",
        metadata: .object([
            "host": .string("rig-host"), "homeDir": .string("/Users/rig"), "displayName": .string("Rig"),
            "machineKind": .string("rig"), "rigOnly": .bool(true),
            "capabilities": .object(["newSession": .bool(true), "resume": .bool(false), "worktrees": .bool(false), "tasks": .bool(true), "bots": .bool(false)]),
            "defaults": .object([
                "providerId": .string("claude"), "modelId": .string("haiku"), "permissionMode": .string("auto"), "effort": .string("low"),
            ]),
            "models": .array([
                .object([
                    "providerId": .string("claude"), "id": .string("haiku"), "name": .string("Haiku"), "providerName": .string("Anthropic Claude"),
                    "thinkingLevels": .array([.string("low"), .string("high")]), "defaultThinkingLevel": .string("low"),
                ]),
            ]),
            "operatingModes": .array([
                .object(["code": .string("auto"), "value": .string("Auto"), "description": .string("Safe default"), "kind": .string("safe-yolo")]),
            ]),
        ]),
        daemonStateVersion: 1, daemonStateCipher: nil, daemonState: .object(["status": .string("running")]),
        dataKeyCipher: nil, decryptable: true
    )

    private func upsert(_ records: [SessionRecord], machines: [MachineRecord] = []) async throws {
        let store = try XCTUnwrap(accounts?.session?.store)
        try await Task.detached {
            for machine in machines { try store.upsertMachine(machine) }
            try store.upsertSessions(records)
        }.value
    }

    /// Signed in offline, `s1` on home, the call's tools over it with `fake` as the relay.
    private func start(_ fake: FakeRelay, machines: [MachineRecord] = []) async throws -> LegacyCallTargets {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-call-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.directory = directory
        NetworkPath.shared.force(false)
        let accounts = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoServer(), connector: NoSockets()
        )
        self.accounts = accounts
        try await accounts.signIn(Credentials(token: "t", secret: secret))
        let session = try XCTUnwrap(accounts.session)
        let store = session.store
        try await Task.detached { try SeededAccount.seed(store) }.value
        try await upsert([Self.record("s1", seq: 1)], machines: machines)
        let context = AppContext(account: accounts, variant: .development, version: "test")
        let targets = LegacyCallTargets(session: session, context: context, shell: nil, relay: fake.relay(session.chatFeed))
        self.targets = targets
        try await until("s1 listed") { await targets.directory().contains { $0.agentId == "s1" } }
        return targets
    }

    private static let lower = CallModeChange(effort: "low")

    // MARK: Retries

    func testARetryUnderTheSameIdSharesTheSendAndGoesOnce() async throws {
        let fake = FakeRelay()
        let gate = Gate()
        fake.switchGate = gate
        let targets = try await start(fake)
        _ = await targets.state(of: "s1")
        let first = Task { await targets.send("s1", text: "Ping", id: "m1", change: Self.lower) }
        try await until("the first at the switch") { await gate.arrived == 1 }
        // Its answer wasn't heard ("uncertain"): the same words again, under the same ID.
        let retry = Task { await targets.send("s1", text: "Ping", id: "m1", change: Self.lower) }
        try await Task.sleep(for: .milliseconds(200))
        await gate.open()
        let outcomes = [await first.value, await retry.value]
        XCTAssertEqual(outcomes, [.queued, .queued])
        let again = await targets.send("s1", text: "Ping", id: "m1", change: Self.lower)
        XCTAssertEqual(again, .queued)
        XCTAssertEqual(fake.enqueued, ["s1: Ping"], "kept once")
        XCTAssertEqual(fake.switches, 1, "switched once")
    }

    func testARefusedSendCanBeTriedAgain() async throws {
        let fake = FakeRelay()
        fake.failSwitches(1)
        let targets = try await start(fake)
        _ = await targets.state(of: "s1")
        let refused = await targets.send("s1", text: "Ping", id: "m1", change: Self.lower)
        XCTAssertEqual(refused, .refused("The model couldn't be switched; nothing was sent."))
        XCTAssertTrue(fake.enqueued.isEmpty)
        let retried = await targets.send("s1", text: "Ping", id: "m1", change: Self.lower)
        XCTAssertEqual(retried, .queued)
        XCTAssertEqual(fake.enqueued, ["s1: Ping"])
    }

    func testARetryOfNewWorksFirstMessageStartsItOnceAndSendsNothingMore() async throws {
        let fake = FakeRelay()
        let gate = Gate()
        fake.startGate = gate
        fake.made = { [weak self] in
            try await self?.upsert([Self.record("made-1", seq: 1)])
            return "made-1"
        }
        let targets = try await start(fake, machines: [Self.rigMachine])
        let drafted = await targets.draft(.task, name: "Probe")
        let work = try XCTUnwrap(drafted, "a computer that starts tasks")
        let first = Task { await targets.send(work.agentId, text: "Start it", id: "n1", change: nil) }
        try await until("the start under way") { await gate.arrived == 1 }
        let retry = Task { await targets.send(work.agentId, text: "Start it", id: "n1", change: nil) }
        try await Task.sleep(for: .milliseconds(200))
        await gate.open()
        let outcomes = [await first.value, await retry.value]
        XCTAssertEqual(outcomes, [.queued, .queued])
        // The session it made, listed under the call's ID for it: the same words again still went the first time.
        try await until("the new work listed") { await targets.directory().contains { $0.agentId == work.agentId } }
        let again = await targets.send(work.agentId, text: "Start it", id: "n1", change: nil)
        XCTAssertEqual(again, .queued)
        XCTAssertEqual(fake.starts, 1, "started once")
        XCTAssertTrue(fake.enqueued.isEmpty, "its first message is the start's, never sent again: \(fake.enqueued)")
    }

    func testEachStartHasItsOwnSpawnRequestsAndTheCallsEndStopsAPendingOne() async throws {
        let fake = FakeRelay()
        let gate = Gate()
        fake.startGate = gate
        var made = 0
        fake.made = {
            made += 1
            return "made-\(made)"
        }
        let targets = try await start(fake, machines: [Self.rigMachine])
        let one = await targets.draft(.task, name: "One")
        let two = await targets.draft(.task, name: "Two")
        let first = try XCTUnwrap(one), second = try XCTUnwrap(two)
        let starting = Task { await targets.send(first.agentId, text: "Go", id: "a", change: nil) }
        let other = Task { await targets.send(second.agentId, text: "Go", id: "b", change: nil) }
        try await until("both under way") { await gate.arrived == 2 }
        let account = try XCTUnwrap(accounts?.session)
        XCTAssertEqual(Set(fake.requests).count, 2, "never one shared slot")
        XCTAssertFalse(fake.requests.contains(ObjectIdentifier(account.spawnRequests)), "never compose's")
        // The person taps End while they wait on their computers.
        targets.close()
        await gate.open()
        let outcomes = [await starting.value, await other.value]
        XCTAssertEqual(outcomes, [.refused("stopped"), .refused("stopped")])
        XCTAssertEqual(made, 0, "nothing made after the call ended")
    }

    // MARK: Checked again before it is kept

    /// A send held at the model switch while `meanwhile` happens: what it answers, and nothing kept.
    private func sendAcrossTheSwitch(_ meanwhile: (LegacyCallTargets, Task<CallSendOutcome, Never>) async throws -> Void) async throws -> CallSendOutcome {
        let fake = FakeRelay()
        let gate = Gate()
        fake.switchGate = gate
        let targets = try await start(fake)
        _ = await targets.state(of: "s1")
        let send = Task { await targets.send("s1", text: "Ping", id: "m1", change: Self.lower) }
        try await until("at the switch") { await gate.arrived == 1 }
        try await meanwhile(targets, send)
        await gate.open()
        let outcome = await send.value
        XCTAssertEqual(fake.switches, 1)
        XCTAssertTrue(fake.enqueued.isEmpty, "nothing kept: \(fake.enqueued)")
        return outcome
    }

    func testACallThatEndsDuringTheSwitchSendsNothing() async throws {
        let outcome = try await sendAcrossTheSwitch { targets, _ in targets.close() }
        XCTAssertEqual(outcome, .refused("No answer in time."))
    }

    func testADeadlineThatPassesDuringTheSwitchSendsNothing() async throws {
        let outcome = try await sendAcrossTheSwitch { _, send in send.cancel() }
        XCTAssertEqual(outcome, .refused("No answer in time."))
    }

    func testASessionArchivedDuringTheSwitchTakesNothing() async throws {
        let outcome = try await sendAcrossTheSwitch { targets, _ in
            try await upsert([Self.record("s1", seq: 2, archived: true)])
            try await until("archived") { targets.records["s1"]?.isArchived == true }
        }
        XCTAssertEqual(outcome, .refused("No such conversation."))
    }

    func testASessionThatStopsDuringTheSwitchTakesNothing() async throws {
        let outcome = try await sendAcrossTheSwitch { targets, _ in
            try await upsert([Self.record("s1", seq: 2, active: false)])
            try await until("stopped") { targets.records["s1"]?.active == false }
        }
        XCTAssertEqual(outcome, .refused("That conversation can't take a message now."))
    }

    func testASessionThatAsksDuringTheSwitchTakesNothing() async throws {
        let outcome = try await sendAcrossTheSwitch { targets, _ in
            try await upsert([Self.record("s1", seq: 2, asking: true)])
            try await until("asking") { targets.records["s1"]?.hasPendingPermissionRequests == true }
        }
        XCTAssertEqual(outcome, .refused("It's waiting for the person in the app; answer there first."))
    }

    // MARK: Following

    func testOverlappingFollowsHoldOneSubscription() async throws {
        let fake = FakeRelay()
        let gate = Gate()
        fake.picksGate = gate
        let targets = try await start(fake)
        let first = Task { await targets.follow("s1", true) }
        let second = Task { await targets.follow("s1", true) }
        try await until("the chips being read") { await gate.arrived >= 1 }
        try await Task.sleep(for: .milliseconds(200))
        await gate.open()
        await first.value
        await second.value
        try await until("subscribed") { fake.open >= 1 }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(fake.open, 1, "one observer")
        XCTAssertEqual(targets.following, ["s1"])
        await targets.follow("s1", false)
        try await until("none once unfollowed") { fake.open == 0 }
    }

    func testACallClosedWhileAFollowIsSetUpLeavesNoSubscription() async throws {
        let fake = FakeRelay()
        let gate = Gate()
        fake.picksGate = gate
        let targets = try await start(fake)
        let follow = Task { await targets.follow("s1", true) }
        try await until("the chips being read") { await gate.arrived == 1 }
        targets.close()
        await gate.open()
        await follow.value
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(fake.open, 0)
        XCTAssertTrue(targets.following.isEmpty)
    }

    func testAnUnfollowWhileAFollowIsSetUpLeavesNoSubscription() async throws {
        let fake = FakeRelay()
        let gate = Gate()
        fake.picksGate = gate
        let targets = try await start(fake)
        let follow = Task { await targets.follow("s1", true) }
        try await until("the chips being read") { await gate.arrived == 1 }
        await targets.follow("s1", false)
        await gate.open()
        await follow.value
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(fake.open, 0)
        XCTAssertTrue(targets.following.isEmpty)
    }
}
#endif
