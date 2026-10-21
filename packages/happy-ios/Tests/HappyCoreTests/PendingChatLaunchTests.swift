import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// The worktree strip's `+` end to end below the screen: the composer's
/// writer on a stand-in's record, the start queue, the handover or the
/// retirement, and the writer that takes over for the real session
/// (pendingChats.ts, pendingChatHandover.ts, WorktreeTabStrip.tsx).
final class PendingChatLaunchTests: XCTestCase {
    /// A session's stored draft and the messages sent to it.
    private actor Sessions {
        var drafts: [String: String] = [:]
        var sent: [(sessionId: String, text: String)] = []
        var refuses: String?

        init(drafts: [String: String] = [:], refuses: String? = nil) {
            self.drafts = drafts
            self.refuses = refuses
        }

        func send(_ sessionId: String, _ text: String) throws -> Bool {
            if text == refuses { throw Refusal() }
            sent.append((sessionId, text))
            return true
        }

        func write(_ sessionId: String, _ text: String) { drafts[sessionId] = text }
        func read(_ sessionId: String) -> String? { drafts[sessionId] }
        func sentTexts() -> [String] { sent.map(\.text) }
    }

    private struct Refusal: Error, LocalizedError {
        var errorDescription: String? { "Session not ready" }
    }

    /// The real session's storage and sender, as the composer sees them
    /// once it has been retargeted.
    private struct RealStorage: ComposerStorage, ChatSending {
        let sessions: Sessions

        func composerValue(sessionId: String) async throws -> ComposerStoreValue {
            ComposerStoreValue(draft: await sessions.read(sessionId) ?? "")
        }

        func saveDraft(sessionId: String, text: String) async throws {
            await sessions.write(sessionId, text)
        }

        func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
            AsyncThrowingStream { $0.finish() }
        }

        func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
            _ = try await sessions.send(sessionId, message.text)
            return "local"
        }

        func retry(localId: String) async throws {}
        func discard(localId: String) async throws {}
    }

    @MainActor
    private final class Starts {
        var asked: [String] = []
        var answers: [String: String?] = [:]
        var gate: CheckedContinuation<Void, Never>?
        var holdFirst = false
        var reported: [String] = []

        func start(_ chat: PendingChat) async -> String? {
            asked.append(chat.id)
            if holdFirst, asked.count == 1 {
                await withCheckedContinuation { gate = $0 }
            }
            return answers[chat.id] ?? nil
        }

        func release() {
            gate?.resume()
            gate = nil
        }
    }

    @MainActor
    private func launcher(_ chats: PendingChats, _ starts: Starts, _ sessions: Sessions) -> PendingChatLauncher {
        PendingChatLauncher(environment: .init(
            chats: chats,
            start: { await starts.start($0) },
            send: { try await sessions.send($0, $1) },
            readDraft: { await sessions.read($0) },
            writeDraft: { await sessions.write($0, $1) },
            reportSendFailure: { starts.reported.append(($0 as? LocalizedError)?.errorDescription ?? "") }
        ))
    }

    // MARK: The stand-in's composer

    func testTheComposerWritesEveryKeystrokeOntoTheStandIn() async throws {
        let chats = PendingChats()
        let chat = await chats.open(anchorSessionId: "anchor", knownSessionIds: ["anchor"])
        let writer = ComposerDraftWriter(sessionId: chat.id, storage: PendingChatComposerStorage(chats), sending: PendingChatSender(chats))
        writer.save("he", generation: 1)
        writer.save("hello", generation: 2)
        await writer.settle()
        let typed = await chats.get(id: chat.id)
        XCTAssertEqual(typed?.draft, "hello")

        // Send queues it for the handover and empties the draft.
        let localId = try await writer.send(OutgoingMessage(text: "hello")).value
        XCTAssertTrue(localId.hasPrefix("pending:"))
        writer.save("and more", generation: 3)
        await writer.settle()
        let queued = await chats.get(id: chat.id)
        XCTAssertEqual(queued?.queued, ["hello"])
        XCTAssertEqual(queued?.draft, "and more")
        writer.close()
    }

    func testTheStandInsDraftIsReadAndFollowed() async throws {
        let chats = PendingChats()
        let chat = await chats.open(anchorSessionId: "anchor", knownSessionIds: [])
        await chats.setDraft(id: chat.id, draft: "left mid-sentence")
        let storage = PendingChatComposerStorage(chats)
        let value = try await storage.composerValue(sessionId: chat.id)
        XCTAssertEqual(value.draft, "left mid-sentence")
        var values = storage.composerValues(sessionId: chat.id).makeAsyncIterator()
        let first = try await values.next()
        XCTAssertEqual(first?.draft, "left mid-sentence")
        await chats.setDraft(id: chat.id, draft: "more")
        let second = try await values.next()
        XCTAssertEqual(second?.draft, "more")
    }

    func testASendTheStandInRefusesKeepsTheText() async {
        let chats = PendingChats()
        let chat = await chats.open(anchorSessionId: "anchor", knownSessionIds: [])
        await chats.settle(id: chat.id, sessionId: "real")
        let sender = PendingChatSender(chats)
        do {
            _ = try await sender.send(OutgoingMessage(text: "too late"), sessionId: chat.id)
            XCTFail("a settled stand-in took a message")
        } catch {
            XCTAssertTrue(error is PendingChatSender.Refused)
        }
        do {
            _ = try await sender.send(OutgoingMessage(text: "gone"), sessionId: "pending-chat:missing")
            XCTFail("a missing stand-in took a message")
        } catch {}
        let settled = await chats.get(id: chat.id)
        XCTAssertEqual(settled?.queued, [])
    }

    // MARK: Starts

    @MainActor
    func testAStartThatOpensHandsTheWritingOverThenNamesTheChat() async throws {
        let chats = PendingChats()
        let starts = Starts()
        let sessions = Sessions()
        let launcher = launcher(chats, starts, sessions)
        starts.holdFirst = true
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: ["anchor"])
        starts.answers[chat.id] = "real"

        // Typed and sent while the machine is still thinking.
        let writer = ComposerDraftWriter(sessionId: chat.id, storage: PendingChatComposerStorage(chats), sending: PendingChatSender(chats))
        _ = try await writer.send(OutgoingMessage(text: "first message")).value
        writer.save("still typing", generation: 1)
        await writer.settle()
        let waiting = await chats.get(id: chat.id)
        XCTAssertNil(waiting?.sessionId)

        while starts.gate == nil { await Task.yield() }
        starts.release()
        await launcher.idle()

        let sent = await sessions.sentTexts()
        XCTAssertEqual(sent, ["first message"])
        let draft = await sessions.read("real")
        XCTAssertEqual(draft, "still typing")
        let settled = await chats.get(id: chat.id)
        XCTAssertEqual(settled?.sessionId, "real")
        XCTAssertEqual(settled?.queued, [])

        // The screen retargets the same composer: the new writer waits for
        // the old one, then writes and sends to the session.
        let real = RealStorage(sessions: sessions)
        let next = ComposerDraftWriter(sessionId: "real", storage: real, sending: real, generation: 1, after: writer)
        writer.close()
        next.save("still typing, and more", generation: 2)
        _ = try await next.send(OutgoingMessage(text: "second message")).value
        await next.settle()
        let after = await sessions.sentTexts()
        XCTAssertEqual(after, ["first message", "second message"])
        let realDraft = await sessions.read("real")
        XCTAssertEqual(realDraft, "still typing, and more")
        // Nothing more lands on the stand-in.
        let record = await chats.get(id: chat.id)
        XCTAssertEqual(record?.draft, "still typing")
        next.close()
    }

    @MainActor
    func testAStartThatFailsGivesTheWritingBackAheadOfTheAnchorsDraft() async {
        let chats = PendingChats()
        let starts = Starts()
        let sessions = Sessions(drafts: ["anchor": "the other thought"])
        let launcher = launcher(chats, starts, sessions)
        starts.holdFirst = true
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: ["anchor"])
        await chats.submit(id: chat.id, message: "sent too soon")
        await chats.setDraft(id: chat.id, draft: "typing")
        while starts.gate == nil { await Task.yield() }
        starts.release()
        await launcher.idle()

        let anchor = await sessions.read("anchor")
        XCTAssertEqual(anchor, "sent too soon\n\ntyping\n\nthe other thought")
        let failed = await chats.get(id: chat.id)
        XCTAssertEqual(failed?.status, .failed)
        XCTAssertNil(failed?.sessionId)
        let sent = await sessions.sentTexts()
        XCTAssertEqual(sent, [])
    }

    @MainActor
    func testAFirstMessageTheSessionRefusesIsSaidAndKept() async {
        let chats = PendingChats()
        let starts = Starts()
        let sessions = Sessions(refuses: "first")
        let launcher = launcher(chats, starts, sessions)
        starts.holdFirst = true
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        starts.answers[chat.id] = "real"
        await chats.submit(id: chat.id, message: "first")
        await chats.submit(id: chat.id, message: "second")
        while starts.gate == nil { await Task.yield() }
        starts.release()
        await launcher.idle()

        XCTAssertEqual(starts.reported, ["Session not ready"])
        let draft = await sessions.read("real")
        XCTAssertEqual(draft, "first\n\nsecond")
        let settled = await chats.get(id: chat.id)
        XCTAssertEqual(settled?.sessionId, "real", "the chat is real all the same")
    }

    @MainActor
    func testStartsRunOneAtATimeInTheOrderAsked() async {
        let chats = PendingChats()
        let starts = Starts()
        let sessions = Sessions()
        let launcher = launcher(chats, starts, sessions)
        starts.holdFirst = true
        let first = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        let second = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        starts.answers[first.id] = "one"
        starts.answers[second.id] = "two"
        // Both tabs exist at once; only the first start is running.
        while starts.gate == nil { await Task.yield() }
        XCTAssertEqual(starts.asked, [first.id])
        let both = await chats.get(id: second.id)
        XCTAssertEqual(both?.status, .starting)
        starts.release()
        await launcher.idle()
        XCTAssertEqual(starts.asked, [first.id, second.id])
        let one = await chats.get(id: first.id)
        let two = await chats.get(id: second.id)
        XCTAssertEqual(one?.sessionId, "one")
        XCTAssertEqual(two?.sessionId, "two")
    }

    // MARK: The account stopping

    @MainActor
    func testClosingStopsTheStartRunningAndTheOnesBehindItAndWritesNothing() async {
        let chats = PendingChats()
        let starts = Starts()
        let sessions = Sessions(drafts: ["anchor": "the anchor's own"])
        var cancels = 0
        let launcher = PendingChatLauncher(environment: .init(
            chats: chats,
            start: { await starts.start($0) },
            send: { try await sessions.send($0, $1) },
            readDraft: { await sessions.read($0) },
            writeDraft: { await sessions.write($0, $1) },
            reportSendFailure: { starts.reported.append(($0 as? LocalizedError)?.errorDescription ?? "") },
            cancelStart: { cancels += 1 }
        ))
        starts.holdFirst = true
        let first = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        let second = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        _ = await chats.submit(id: first.id, message: "hello")
        starts.answers[first.id] = "one"
        starts.answers[second.id] = "two"
        while starts.gate == nil { await Task.yield() }

        launcher.close()
        launcher.close()
        XCTAssertEqual(cancels, 1, "the start running is stopped once")
        // What the running start hands back now is left alone.
        starts.release()
        await launcher.idle()
        XCTAssertEqual(starts.asked, [first.id], "the start behind it never begins")
        let one = await chats.get(id: first.id)
        XCTAssertNil(one?.sessionId)
        XCTAssertEqual(one?.status, .starting)
        let sent = await sessions.sentTexts()
        XCTAssertEqual(sent, [])
        let anchorDraft = await sessions.read("anchor")
        XCTAssertEqual(anchorDraft, "the anchor's own")
        XCTAssertEqual(starts.reported, [])
    }

    /// The machine is asked for the session; the account stops before it
    /// answers. With a real `SessionStarter` behind the launcher, the session
    /// it hands back afterwards is put down and nothing is sent to it.
    @MainActor
    func testASessionTheMachineHandsBackAfterTheAccountStoppedIsPutDown() async {
        let chats = PendingChats()
        let sessions = Sessions()
        let machine = Machine()
        await machine.holdSpawn()
        let root = SpawnRequests()
        let starter = starter(machine, sessions: sessions, scope: root.child(.pendingChats))
        let launcher = stripLauncher(chats, sessions, starter: starter, launch: Self.launch(place: "/src/happy"))
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        _ = await chats.submit(id: chat.id, message: "hello")
        await waitFor { await machine.isHoldingSpawn }

        launcher.close()
        XCTAssertFalse(starter.isStarting)
        await launcher.idle()
        await machine.answerSpawn(.success(sessionId: "late"))
        await waitFor { await machine.refreshes > 0 }
        let stops = await machine.stops
        XCTAssertEqual(stops, ["late"])
        let record = await chats.get(id: chat.id)
        XCTAssertNil(record?.sessionId, "the stand-in never names it")
        let sent = await sessions.sentTexts()
        XCTAssertEqual(sent, [], "the queued message is not sent to it")
        root.close()
    }

    // MARK: The strip's spawn requests, beside the dock's

    /// The strip's start has its session and waits for it to sync; the dock
    /// starts something else on the same account meanwhile. Both are real
    /// starters, the strip's on the account's `pendingChats` scope, the
    /// dock's on the account's own: the dock's new request doesn't abandon
    /// the strip's session, and the stand-in becomes it with what was typed.
    @MainActor
    func testADockStartDoesNotAbandonTheStripsSessionOnTheSameAccount() async {
        let chats = PendingChats()
        let sessions = Sessions()
        let root = SpawnRequests()
        let stripMachine = Machine(spawns: [.success(sessionId: "strip")])
        await stripMachine.holdReady("strip")
        let strip = starter(stripMachine, sessions: sessions, scope: root.child(.pendingChats))
        let launcher = stripLauncher(chats, sessions, starter: strip, launch: Self.launch(place: "/src/happy"))
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        _ = await chats.submit(id: chat.id, message: "hello")
        await waitFor { await stripMachine.isHoldingReady }

        let dockMachine = Machine(spawns: [.success(sessionId: "dock")])
        let dock = starter(dockMachine, sessions: sessions, scope: root)
        let docked = await dock.start(Self.launch(place: "/src/other", prompt: "Fix the build"), isCurrentTarget: { true })
        XCTAssertEqual(docked, "dock")
        XCTAssertTrue(strip.isStarting, "the strip's start is still waiting for its session")
        let early = await stripMachine.stops
        XCTAssertEqual(early, [])

        await stripMachine.releaseReady()
        await launcher.idle()
        let named = await chats.get(id: chat.id)
        XCTAssertEqual(named?.sessionId, "strip")
        let sent = await sessions.sent.map { "\($0.sessionId): \($0.text)" }
        XCTAssertEqual(sent, ["dock: Fix the build", "strip: hello"])
        let stops = await stripMachine.stops + dockMachine.stops
        XCTAssertEqual(stops, [])
        root.close()
    }

    /// The other way round: the dock's session is waiting to sync when the
    /// strip starts a sibling. The strip's request is its own, so the dock's
    /// session is left alone and opens with its first message.
    @MainActor
    func testAStripStartDoesNotAbandonTheDocksSessionOnTheSameAccount() async {
        let chats = PendingChats()
        let sessions = Sessions()
        let root = SpawnRequests()
        let dockMachine = Machine(spawns: [.success(sessionId: "dock")])
        await dockMachine.holdReady("dock")
        let dock = starter(dockMachine, sessions: sessions, scope: root)
        let docking = Task { await dock.start(Self.launch(place: "/src/other", prompt: "Fix the build"), isCurrentTarget: { true }) }
        await waitFor { await dockMachine.isHoldingReady }

        let stripMachine = Machine(spawns: [.success(sessionId: "strip")])
        let strip = starter(stripMachine, sessions: sessions, scope: root.child(.pendingChats))
        let launcher = stripLauncher(chats, sessions, starter: strip, launch: Self.launch(place: "/src/happy"))
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        await launcher.idle()
        let named = await chats.get(id: chat.id)
        XCTAssertEqual(named?.sessionId, "strip")
        XCTAssertTrue(dock.isStarting)

        await dockMachine.releaseReady()
        let docked = await docking.value
        XCTAssertEqual(docked, "dock")
        let sent = await sessions.sentTexts()
        XCTAssertEqual(sent, ["Fix the build"])
        let stops = await stripMachine.stops + dockMachine.stops
        XCTAssertEqual(stops, [])
        root.close()
    }

    /// `AccountSession.stop` closes the account's spawn requests, the
    /// strip's scope with them, while the machine is still being asked. The
    /// start stops without waiting for the machine, and its stand-in gives
    /// its writing back to the chat it was opened beside; the session the
    /// machine hands back later is put down, never named, never written to.
    /// The scope stays closed: a start on it afterwards asks the machine for
    /// nothing.
    @MainActor
    func testClosingTheAccountsSpawnRequestsStopsTheStripsStartWhileTheMachineIsAsked() async {
        let chats = PendingChats()
        let sessions = Sessions(drafts: ["anchor": "the anchor's own"])
        let root = SpawnRequests()
        let machine = Machine(spawns: [.success(sessionId: "late")])
        await machine.holdSpawn()
        let strip = starter(machine, sessions: sessions, scope: root.child(.pendingChats))
        let launcher = stripLauncher(chats, sessions, starter: strip, launch: Self.launch(place: "/src/happy"))
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        _ = await chats.submit(id: chat.id, message: "hello")
        await waitFor { await machine.isHoldingSpawn }

        // The attempt is cancelled now; the start unwinds on its own task.
        root.close()
        await launcher.idle()
        XCTAssertFalse(strip.isStarting)
        let retired = await chats.get(id: chat.id)
        XCTAssertNil(retired?.sessionId)
        XCTAssertEqual(retired?.status, .failed)
        let anchorDraft = await sessions.read("anchor")
        XCTAssertEqual(anchorDraft, "hello\n\nthe anchor's own")

        await machine.answerSpawn(.success(sessionId: "late"))
        await waitFor { await machine.refreshes > 0 }
        let stops = await machine.stops
        XCTAssertEqual(stops, ["late"])
        let sent = await sessions.sentTexts()
        XCTAssertEqual(sent, [])

        let scope = root.child(.pendingChats)
        XCTAssertTrue(scope.isClosed)
        let again = await starter(machine, sessions: sessions, scope: scope).start(Self.launch(place: "/src/happy"), isCurrentTarget: { true })
        XCTAssertNil(again)
        let spawned = await machine.spawned
        XCTAssertEqual(spawned, 1, "a closed scope asks the machine for nothing")
    }

    /// The strip's session opened somewhere else while it syncs (a chat
    /// screen's `onSessionVisible`, which releases on the account's own
    /// requests): the release reaches the strip's scope, so the session is
    /// no longer the start's to put down. It keeps running; the stand-in,
    /// whose start no longer owns it, gives its writing back.
    @MainActor
    func testReleasingOnTheAccountReachesTheStripsScope() async {
        let chats = PendingChats()
        let sessions = Sessions(drafts: ["anchor": ""])
        let root = SpawnRequests()
        let machine = Machine(spawns: [.success(sessionId: "strip")])
        await machine.holdReady("strip")
        let strip = starter(machine, sessions: sessions, scope: root.child(.pendingChats))
        let launcher = stripLauncher(chats, sessions, starter: strip, launch: Self.launch(place: "/src/happy"))
        let chat = await launcher.open(anchorSessionId: "anchor", knownSessionIds: [])
        _ = await chats.submit(id: chat.id, message: "hello")
        await waitFor { await machine.isHoldingReady }

        root.release(sessionId: "another")
        XCTAssertTrue(strip.isStarting, "another session's release is not this one's")
        root.release(sessionId: "strip")
        await machine.releaseReady()
        await launcher.idle()
        let record = await chats.get(id: chat.id)
        XCTAssertNil(record?.sessionId)
        let stops = await machine.stops
        let kills = await machine.kills
        XCTAssertEqual(stops, [], "the session opened elsewhere keeps running")
        XCTAssertEqual(kills, [])
        let anchorDraft = await sessions.read("anchor")
        XCTAssertEqual(anchorDraft, "hello")
        root.close()
    }

    // MARK: Real starters

    private static func launch(place: String, prompt: String = "") -> NewSessionLaunch {
        NewSessionLaunch(
            machineId: "m1", agent: .claude, rigMetadata: nil, absolutePath: place,
            worktreeSelection: NewSessionDraft.noWorktreeKey, worktreeCreationMachineId: nil, target: nil,
            permissionMode: "default", modelMode: "default", effortLevel: nil, prompt: prompt, attachments: [],
            signature: SpawnRequests.Signature(machineId: "m1", agent: "claude", place: place, worktree: nil, modelKey: nil, permissionMode: nil, effort: nil)
        )
    }

    @MainActor
    private func starter(_ machine: Machine, sessions: Sessions, scope: SpawnRequests) -> SessionStarter {
        SessionStarter(environment: .init(
            ops: machine,
            sessionOps: machine,
            sender: RealStorage(sessions: sessions),
            metadataTransport: NoTransport(),
            refreshSessions: { await machine.refreshed() },
            paintBotFace: { _ in Data() },
            attachmentPlan: { message, _ in AttachmentSendPlan(accepted: message.attachments, rejected: [], shouldShowUnsupportedAlert: false, shouldSendText: true) },
            spawnRequests: scope,
            sleep: { _ in }
        ))
    }

    /// `ChatPendingStarts`' launcher: every start the strip's, with no
    /// first message, whatever the composer is doing.
    @MainActor
    private func stripLauncher(_ chats: PendingChats, _ sessions: Sessions, starter: SessionStarter, launch: NewSessionLaunch) -> PendingChatLauncher {
        PendingChatLauncher(environment: .init(
            chats: chats,
            start: { _ in await starter.start(launch, isCurrentTarget: { true }) },
            send: { try await sessions.send($0, $1) },
            readDraft: { await sessions.read($0) },
            writeDraft: { await sessions.write($0, $1) },
            reportSendFailure: { _ in },
            cancelStart: { starter.cancel() }
        ))
    }

    /// Polls, so a start that never gets there is a failure, not a hang.
    @MainActor
    private func waitFor(file: StaticString = #filePath, line: UInt = #line, _ condition: () async -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await condition()) {
            if ContinuousClock.now > deadline {
                XCTFail("timed out", file: file, line: line)
                return
            }
            try? await Task.sleep(for: .milliseconds(2))
        }
    }

    /// A computer: answers spawns in turn, and can hold a spawn or a
    /// session's sync until told to go on.
    private actor Machine: HomeOps, HomeSessionOps {
        private var spawns: [SpawnSessionResult]
        private(set) var spawned = 0
        private(set) var stops: [String] = []
        private(set) var kills: [String] = []
        private(set) var refreshes = 0
        private var holdsSpawn = false
        private var spawnGate: CheckedContinuation<SpawnSessionResult, Never>?
        private var readyHeldFor: String?
        private var readyGate: CheckedContinuation<Void, Never>?

        init(spawns: [SpawnSessionResult] = []) {
            self.spawns = spawns
        }

        var isHoldingSpawn: Bool { spawnGate != nil }
        var isHoldingReady: Bool { readyGate != nil }

        func holdSpawn() { holdsSpawn = true }
        func holdReady(_ sessionId: String) { readyHeldFor = sessionId }
        func refreshed() { refreshes += 1 }

        func answerSpawn(_ result: SpawnSessionResult) {
            spawnGate?.resume(returning: result)
            spawnGate = nil
        }

        func releaseReady() {
            readyHeldFor = nil
            readyGate?.resume()
            readyGate = nil
        }

        func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
            spawned += 1
            if holdsSpawn {
                holdsSpawn = false
                return await withCheckedContinuation { spawnGate = $0 }
            }
            return spawns.isEmpty ? .error(errorMessage: "unscripted") : spawns.removeFirst()
        }

        func ensureSessionReady(sessionId: String) async throws {
            if sessionId == readyHeldFor { await withCheckedContinuation { readyGate = $0 } }
        }

        func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult {
            stops.append(sessionId)
            return MachineOperationResult(success: true, message: nil)
        }

        func sessionKill(sessionId: String) async throws -> SessionKillResponse {
            kills.append(sessionId)
            return SessionKillResponse(success: true, message: "")
        }

        func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult {
            .error(errorMessage: "unused")
        }

        func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult {
            .error(errorMessage: "unused")
        }

        func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse {
            SessionBashResponse(success: true, stdout: "", stderr: "", exitCode: 0, error: nil)
        }

        func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
        func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
        func archive(sessionId: String) async throws {}
        func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { ("", 0) }
    }

    private struct NoTransport: MetadataUpdateTransport {
        func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue { .null }
    }

    // MARK: newSessionLikeSession

    private func record(_ metadata: [String: JSONValue]) -> SessionRecord {
        SessionRecord(
            id: "open", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: "k", decryptable: true
        )
    }

    func testASiblingStartsInTheChatsOwnDirectoryWithItsPicks() {
        let like = NewSessionDraft.like(
            record([
                "machineId": .string("m1"),
                "path": .string("/Users/me/src/happy/.dev/worktree/gdansk"),
                "homeDir": .string("/Users/me"),
                "flavor": .string("codex"),
            ]),
            picks: ComposerPicks(permissionMode: "yolo", modelMode: "gpt-5", effortLevel: "high")
        )
        XCTAssertEqual(like.draft.selectedMachineId, "m1")
        XCTAssertEqual(like.draft.selectedPath, "~/src/happy/.dev/worktree/gdansk")
        XCTAssertEqual(like.draft.agentType, .codex)
        XCTAssertEqual(like.draft.pickedAgentType, .codex)
        XCTAssertEqual(like.draft.permissionMode, "yolo")
        XCTAssertEqual(like.draft.modelMode, "gpt-5")
        XCTAssertEqual(like.draft.effortLevel, "high")
        XCTAssertEqual(like.draft.worktreeSelection, NewSessionDraft.noWorktreeKey)
        XCTAssertEqual(like.draft.input, "")
        XCTAssertNil(like.target)
    }

    func testAnUnknownFlavorStartsClaude() {
        let like = NewSessionDraft.like(record(["machineId": .string("m1"), "path": .string("/src"), "flavor": .string("mystery")]), picks: ComposerPicks())
        XCTAssertEqual(like.draft.agentType, .claude)
        XCTAssertNil(like.draft.permissionMode)
    }

    func testHappyAgentIsToldItsWorkspaceAndKeepsItsOwnModes() {
        let metadata: [String: JSONValue] = [
            "machineId": .string("rig-1"),
            "path": .string("/rig/projects/happy"),
            "client": .object(["id": .string("rig")]),
            "project": .object(["id": .string("p1"), "name": .string("Happy")]),
            "workspace": .object(["id": .string("w1"), "name": .string("Strip")]),
            "currentOperatingModeCode": .string("plan"),
        ]
        let like = NewSessionDraft.like(record(metadata), picks: ComposerPicks())
        XCTAssertEqual(like.draft.agentType, .rig)
        XCTAssertEqual(like.target, .workspace(id: "w1"))
        XCTAssertEqual(like.draft.permissionMode, "plan")

        var projectOnly = metadata
        projectOnly["workspace"] = nil
        XCTAssertEqual(NewSessionDraft.like(record(projectOnly), picks: ComposerPicks()).target, .project(id: "p1"))
        // The chat's own pick wins over the agent's metadata.
        XCTAssertEqual(NewSessionDraft.like(record(metadata), picks: ComposerPicks(permissionMode: "auto")).draft.permissionMode, "auto")
    }
}
