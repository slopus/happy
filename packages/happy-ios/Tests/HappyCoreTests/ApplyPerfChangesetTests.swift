import Foundation
import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

final class ApplyPerfChangesetTests: XCTestCase {
    private struct Row: Equatable {
        var id: String
        var value: Int
    }

    private func rows(_ ids: String, value: Int = 0) -> [Row] {
        ids.map { Row(id: String($0), value: value) }
    }

    func testSameRowsTouchNothing() {
        let changes = RowChangeset(from: rows("abcd"), to: rows("abcd"), id: \.id)
        XCTAssertTrue(changes.isEmpty)
        XCTAssertEqual(changes.touchedRows, 0)
    }

    func testChangedValueReconfiguresInPlace() {
        var next = rows("abcd")
        next[2].value = 1
        XCTAssertEqual(RowChangeset(from: rows("abcd"), to: next, id: \.id), RowChangeset(reconfigures: [2]))
    }

    func testMembershipChangesInsertAndDelete() {
        let changes = RowChangeset(from: rows("abcd"), to: rows("abxd"), id: \.id)
        XCTAssertEqual(changes, RowChangeset(deletes: [2], inserts: [2]))
        XCTAssertTrue(changes.isStructural)
    }

    func testOrderChangeMovesAndReconfiguresAtNewIndex() {
        var next = rows("cabd")
        next[0].value = 1
        let changes = RowChangeset(from: rows("abcd"), to: next, id: \.id)
        XCTAssertEqual(changes.moves, [.init(from: 2, to: 0)])
        XCTAssertEqual(changes.reconfigures, [0])
        XCTAssertTrue(changes.deletes.isEmpty)
        XCTAssertTrue(changes.inserts.isEmpty)
    }

    func testAppliedChangesetReproducesTheNewOrder() {
        // Replays the changeset as UIKit would and checks the result.
        let old = rows("abcdefgh")
        let new = rows("hbxdcaey")
        let changes = RowChangeset(from: old, to: new, id: \.id)
        var result: [String?] = Array(repeating: nil, count: new.count)
        let removed = Set(changes.deletes).union(changes.moves.map(\.from))
        var survivors = old.indices.filter { !removed.contains($0) }.map { old[$0].id }
        for move in changes.moves { result[move.to] = old[move.from].id }
        for insert in changes.inserts { result[insert] = new[insert].id }
        for index in result.indices where result[index] == nil {
            result[index] = survivors.removeFirst()
        }
        XCTAssertEqual(result.compactMap { $0 }, new.map(\.id))
    }
}

final class ApplyPerfHomeTests: XCTestCase {
    func testInvisibleFieldsDeriveNothingForTheMainThread() throws {
        var snapshot = ApplyPerfFixtures.snapshot(50)
        let first = try XCTUnwrap(ApplyPerfFixtures.derive(snapshot, after: nil))
        XCTAssertEqual(first.output.changeset.inserts.count, 50)
        var applied = first.state
        var updates = 0
        for step in 1...150 {
            snapshot.sessions[step % 10] = ApplyPerfFixtures.invisiblyTouched(snapshot.sessions[step % 10], by: Int64(step))
            if let result = ApplyPerfFixtures.derive(snapshot, after: applied) {
                updates += 1
                applied = result.state
            }
        }
        XCTAssertEqual(updates, 0, "150 invisible changes reach the main thread 0 times and touch 0 rows")
    }

    func testOneTitleReconfiguresExactlyOneRow() throws {
        var snapshot = ApplyPerfFixtures.snapshot(50)
        let applied = try XCTUnwrap(ApplyPerfFixtures.derive(snapshot, after: nil)).state
        snapshot.sessions[20] = ApplyPerfFixtures.retitled(snapshot.sessions[20], "Changed")
        let update = try XCTUnwrap(ApplyPerfFixtures.derive(snapshot, after: applied)).output
        XCTAssertEqual(update.changeset, RowChangeset(reconfigures: [20]))
        XCTAssertFalse(update.kindChanged)
    }

    func testNewActivityInTheSameMinuteOnlyMoves() throws {
        let (before, after) = ApplyPerfFixtures.overtaking()
        let applied = try XCTUnwrap(ApplyPerfFixtures.derive(before, after: nil)).state
        let update = try XCTUnwrap(ApplyPerfFixtures.derive(after, after: applied)).output
        // The old apply also redrew the row for its raw activity time.
        XCTAssertEqual(update.changeset.moves.count, 1)
        XCTAssertEqual(update.changeset.reconfigures, [])
        XCTAssertEqual(update.changeset.touchedRows, 1)
    }

    func testOneBatchOf500IsOneApplyOfInserts() throws {
        var empty = ApplyPerfFixtures.snapshot(0)
        empty.machines = ApplyPerfFixtures.snapshot(1).machines
        let applied = ApplyPerfFixtures.derive(empty, after: nil)?.state
        XCTAssertEqual(applied?.content?.kind, .noSessions)
        let update = try XCTUnwrap(ApplyPerfFixtures.derive(ApplyPerfFixtures.snapshot(500), after: applied)).output
        XCTAssertTrue(update.kindChanged)
        XCTAssertEqual(update.changeset.inserts.count, 500)
        XCTAssertEqual(update.changeset.touchedRows, 500)
    }

    func testRenderedRowsOmitRawActivity() throws {
        let content = try XCTUnwrap(ApplyPerfFixtures.derive(ApplyPerfFixtures.snapshot(3), after: nil)).state
        for case .flat(.session(let row)) in content.content?.list?.rows ?? [] {
            XCTAssertEqual(row.lastActivityAt, 0)
            XCTAssertFalse(row.timestamp.isEmpty)
        }
    }

    func testDerivationCostOffMain() {
        for count in [1, 50, 1000] {
            let fixture = ApplyPerfFixtures.snapshot(count)
            var touched = fixture
            touched.sessions[0] = ApplyPerfFixtures.retitled(touched.sessions[0], "Changed")
            let applied = ApplyPerfFixtures.derive(fixture, after: nil)?.state
            let median = applyPerfMedian {
                XCTAssertEqual(ApplyPerfFixtures.derive(touched, after: applied)?.output.changeset.touchedRows, 1)
            }
            XCTAssertLessThan(median, 10_000, "generous shared-machine ceiling; background work, not a main-thread budget")
            print("APPLY_PERF after home-derive+diff-\(count) (background): median=\(String(format: "%.3f", median))ms")
        }
    }
}

final class ApplyPerfPipelineTests: XCTestCase {
    @MainActor
    func testCatchUpPagesArrivingDuringADerivationApplyOnce() async throws {
        let gate = ApplyPerfGate()
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(includesDock: true, clock: ApplyPerfFixtures.clock),
            state: HomeDerivation.Applied(),
            derive: { input, applied in
                gate.pass()
                return HomeDerivation.derive(input, applied: applied)
            },
            apply: { recorder.take($0) }
        )
        let fixture = ApplyPerfFixtures.snapshot(500)
        var page = fixture
        page.sessions = Array(fixture.sessions.prefix(100))
        pipeline.update { $0.snapshot = page }
        await Task.detached { gate.waitUntilHeld() }.value
        for end in stride(from: 200, through: 500, by: 100) {
            page.sessions = Array(fixture.sessions.prefix(end))
            pipeline.update { $0.snapshot = page }
        }
        gate.open()
        await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.derivations == 2 }
        let counts = pipeline.counts
        XCTAssertEqual(counts.derivations, 2, "the first page, then the four that came meanwhile, merged")
        XCTAssertEqual(counts.superseded, 1, "the first page's result never reached the screen")
        XCTAssertEqual(counts.applies, 1)
        // Diffed against what was applied (nothing), not the dropped page.
        XCTAssertEqual(recorder.outputs.first?.changeset.inserts.count, 500)
        XCTAssertEqual(pipeline.applied.content?.list?.ids.count, 500)
        pipeline.cancel()
    }

    @MainActor
    func testRefusedApplyKeepsDiffingAgainstWhatIsOnScreen() async throws {
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        recorder.refuses = true
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(includesDock: true, clock: ApplyPerfFixtures.clock),
            state: HomeDerivation.Applied(),
            derive: { HomeDerivation.derive($0, applied: $1) },
            apply: { recorder.take($0) }
        )
        pipeline.update { $0.snapshot = ApplyPerfFixtures.snapshot(10) }
        await applyPerfWait { pipeline.counts.rejected == 1 }
        XCTAssertNil(pipeline.applied.content)
        recorder.refuses = false
        pipeline.update { $0.snapshot = ApplyPerfFixtures.snapshot(12) }
        await applyPerfWait { pipeline.counts.applies == 1 }
        XCTAssertEqual(recorder.outputs.last?.changeset.inserts.count, 12)
        pipeline.cancel()
    }

    @MainActor
    func testCancelledPipelineNeverApplies() async throws {
        let gate = ApplyPerfGate()
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(includesDock: true, clock: ApplyPerfFixtures.clock),
            state: HomeDerivation.Applied(),
            derive: { input, applied in
                gate.pass()
                return HomeDerivation.derive(input, applied: applied)
            },
            apply: { recorder.take($0) }
        )
        pipeline.update { $0.snapshot = ApplyPerfFixtures.snapshot(10) }
        await Task.detached { gate.waitUntilHeld() }.value
        // An account switch or a closed screen: the result in flight is dropped.
        pipeline.cancel()
        gate.open()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(recorder.outputs.count, 0)
        XCTAssertEqual(pipeline.counts.applies, 0)
        pipeline.update { $0.snapshot = ApplyPerfFixtures.snapshot(11) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(pipeline.counts.derivations, 1)
    }

    /// The real store, feed and production derivations: 10 sessions, 30 s of
    /// unchanged heartbeats every 2 s and a message cursor bump each, then
    /// one visible change as a fence.
    @MainActor
    func testHeartbeatsAndCursorsApplyNothingOnHomeOrChat() async throws {
        let store = try LocalStore.inMemory()
        try store.replaceMachines([ApplyPerfFixtures.machine])
        try store.setCursor(.machinesLastSync, 1)
        try store.upsertSessions((0..<10).map(ApplyPerfFixtures.session))
        try store.setCursor(.sessionsChangedSince, 1)
        let feed = HomeFeed(store: store)

        let home = ApplyPerfRecorder<HomeUpdate>()
        let homePipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(includesDock: true, clock: ApplyPerfFixtures.clock),
            state: HomeDerivation.Applied(),
            derive: { HomeDerivation.derive($0, applied: $1) },
            apply: { home.take($0) }
        )
        homePipeline.follow(feed.snapshots()) { $0.snapshot = $1 }

        let chat = ApplyPerfRecorder<ChatSessionState>()
        let chatPipeline = ApplyPipeline<HomeSnapshot?, ChatSessionState?, ChatSessionState>(
            input: nil,
            state: nil,
            derive: { snapshot, applied in
                guard let snapshot else { return nil }
                let state = ChatSessionState(snapshot, sessionId: "session-0003")
                return state == applied ? nil : (state, state)
            },
            apply: { chat.take($0) }
        )
        chatPipeline.follow(feed.snapshots()) { $0 = $1 }
        await applyPerfWait { home.outputs.count == 1 && chat.outputs.count == 1 }

        for tick in 1...15 {
            let at = ApplyPerfFixtures.now + Int64(tick) * 2000
            for index in 0..<10 {
                try store.applySessionActivity(id: ApplyPerfFixtures.session(index).id, active: true, activeAt: at)
                try store.applyMessagePage(sessionId: ApplyPerfFixtures.session(index).id, messages: [], syncedThrough: tick)
            }
        }
        let fence = ApplyPerfFixtures.retitled(try XCTUnwrap(store.session(id: "session-0003")), "Fence")
        _ = try store.applySessionUpdate(
            id: fence.id,
            metadata: VersionedPayload(version: fence.metadataVersion + 1, cipher: "fence", value: fence.metadata),
            agentState: nil,
            projectId: nil
        )
        await applyPerfWait { home.outputs.count == 2 && chat.outputs.count == 2 }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(home.outputs.count, 2, "the first list and the fence; 150 heartbeats applied nothing")
        XCTAssertEqual(home.outputs.last?.changeset, RowChangeset(reconfigures: [3]))
        XCTAssertEqual(chat.outputs.count, 2, "the first state and the fence")
        print("APPLY_PERF after 10x30s-heartbeats: home_derivations=\(homePipeline.counts.derivations) home_applies=\(homePipeline.counts.applies) chat_derivations=\(chatPipeline.counts.derivations) chat_applies=\(chatPipeline.counts.applies)")
        homePipeline.cancel()
        chatPipeline.cancel()
    }
}

final class ApplyPerfMetricsTests: XCTestCase {
    func testAppliesShareOneBatchAndTotalsSurviveClosing() throws {
        #if DEBUG
        let metrics = ApplyMetrics()
        XCTAssertTrue(metrics.record(.homeList, rows: 1, milliseconds: 0.2))
        XCTAssertFalse(metrics.record(.chatList, rows: 1, milliseconds: 0.3))
        let batch = try XCTUnwrap(metrics.endBatch())
        XCTAssertEqual(batch.applies, 2)
        XCTAssertEqual(batch.milliseconds, 0.5, accuracy: 0.0001)
        XCTAssertEqual(metrics.total(.homeList), .init(applies: 1, rows: 1, milliseconds: 0.2))
        XCTAssertEqual(metrics.batches, [batch])
        XCTAssertNil(metrics.endBatch())
        XCTAssertTrue(metrics.record(.homeList, rows: 2, milliseconds: 5))
        XCTAssertEqual(metrics.total(.homeList).rows, 3)
        XCTAssertEqual(metrics.blocksOverBudget, 1)
        metrics.reset()
        XCTAssertEqual(metrics.total(.homeList), .init())
        XCTAssertTrue(metrics.batches.isEmpty)
        XCTAssertNil(metrics.endBatch())
        #endif
    }

    func testOnlyTheLatest64BatchesAreKept() {
        #if DEBUG
        let metrics = ApplyMetrics()
        for index in 0..<100 {
            metrics.record(.screen, rows: index, milliseconds: Double(index))
            metrics.endBatch()
        }
        XCTAssertEqual(metrics.batches.count, 64)
        XCTAssertEqual(metrics.batches.first?.milliseconds, 36)
        XCTAssertEqual(metrics.total(.screen).applies, 100)
        #endif
    }
}

final class ApplyPerfHomeLayoutTests: XCTestCase {
    private func grouped(_ snapshot: HomeSnapshot, _ grouping: String) -> HomeSnapshot {
        var snapshot = snapshot
        snapshot.settings = SettingsSnapshot(pending: ["sessionListGrouping": .string(grouping)])
        return snapshot
    }

    func testSwitchingLayoutSwapsRowsAndNeverReconfiguresAcrossCellKinds() throws {
        var snapshot = ApplyPerfFixtures.snapshot(5)
        // One archived session, so both layouts have a toggle and a day.
        snapshot.sessions[4].active = false
        snapshot.settings = SettingsSnapshot(pending: ["hideInactiveSessions": .bool(false)])
        let flat = try XCTUnwrap(ApplyPerfFixtures.derive(snapshot, after: nil)).state
        var project = snapshot
        project.settings.pending["sessionListGrouping"] = .string("project")
        let update = try XCTUnwrap(ApplyPerfFixtures.derive(project, after: flat)).output
        let before = try XCTUnwrap(flat.content?.list)
        let after = try XCTUnwrap(update.content.list)
        XCTAssertFalse(before.grouped)
        XCTAssertTrue(after.grouped)
        XCTAssertTrue(Set(before.ids).isDisjoint(with: after.ids), "the layouts share no row id")
        XCTAssertEqual(update.changeset.deletes.count, before.ids.count)
        XCTAssertEqual(update.changeset.inserts.count, after.ids.count)
        XCTAssertEqual(update.changeset.reconfigures, [])
        XCTAssertEqual(update.changeset.moves, [])
        XCTAssertFalse(update.kindChanged)
    }

    func testSelectionFindsAChatInEitherLayout() throws {
        let flat = try XCTUnwrap(ApplyPerfFixtures.derive(ApplyPerfFixtures.snapshot(3), after: nil)).state.content?.list
        XCTAssertEqual(flat?.index(ofSession: "session-0001"), 1)
        let project = try XCTUnwrap(ApplyPerfFixtures.derive(grouped(ApplyPerfFixtures.snapshot(3), "project"), after: nil)).state.content?.list
        let index = try XCTUnwrap(project?.index(ofSession: "session-0000"))
        XCTAssertEqual(project?.rows[index].sessionId, "session-0000")
    }

    func testGroupingChoiceAloneReachesTheMenu() throws {
        let snapshot = ApplyPerfFixtures.snapshot(3)
        let applied = try XCTUnwrap(ApplyPerfFixtures.derive(snapshot, after: nil))
        XCTAssertEqual(applied.output.grouping, .flat)
        XCTAssertNil(ApplyPerfFixtures.derive(snapshot, after: applied.state))
    }
}

final class ApplyPerfChatSessionTests: XCTestCase {
    func testUnrenderedSettingsAndInvisibleFieldsChangeNothing() {
        var snapshot = ApplyPerfFixtures.snapshot(3)
        let before = ChatSessionState(snapshot, sessionId: "session-0001")
        snapshot.settings = SettingsSnapshot(pending: [
            "reviewPromptAnswered": .bool(true), "recentMachinePaths": .array([.string("/x")]),
            "sessionListGrouping": .string("project"), "lastUsedAgent": .string("codex"),
        ])
        snapshot.sessions[1] = ApplyPerfFixtures.invisiblyTouched(snapshot.sessions[1], by: 5000)
        snapshot.sessions[2] = ApplyPerfFixtures.retitled(snapshot.sessions[2], "Another session")
        snapshot.machines.machines[0].activeAt += 5000
        XCTAssertEqual(ChatSessionState(snapshot, sessionId: "session-0001"), before)
    }

    func testRenderedSettingsAndFieldsDoChange() {
        let snapshot = ApplyPerfFixtures.snapshot(3)
        let before = ChatSessionState(snapshot, sessionId: "session-0001")
        for key in ChatSessionState.renderedSettings {
            var changed = snapshot
            changed.settings = SettingsSnapshot(pending: [key: .string("changed")])
            XCTAssertNotEqual(ChatSessionState(changed, sessionId: "session-0001"), before, key)
        }
        var offline = snapshot
        offline.sessions[1].active = false
        let stopped = ChatSessionState(offline, sessionId: "session-0001")
        XCTAssertNotEqual(stopped, before)
        XCTAssertEqual(stopped.machine?.id, "computer", "a stopped session keeps its machine for resuming")
        offline.sessions[1].activeAt -= 3_600_000
        XCTAssertNotEqual(ChatSessionState(offline, sessionId: "session-0001"), stopped, "a stopped session shows when it was last seen")
    }
}

final class ApplyPerfPacingTests: XCTestCase {
    @MainActor
    func testAppliesAreAtLeastAFrameApart() async throws {
        let recorder = ApplyPerfRecorder<Int>()
        var times: [ContinuousClock.Instant] = []
        let pipeline = ApplyPipeline<Int, Int, Int>(
            input: 0,
            state: 0,
            derive: { input, applied in input == applied ? nil : (input, input) },
            apply: { value in
                times.append(.now)
                return recorder.take(value)
            }
        )
        // A burst far faster than a frame, for 20 frames' worth.
        let start = ContinuousClock.now
        var value = 0
        while start.duration(to: .now) < .milliseconds(340) {
            value += 1
            let next = value
            pipeline.update { $0 = next }
            try await Task.sleep(for: .milliseconds(1))
        }
        await applyPerfWait { pipeline.applied == value }
        let gaps = zip(times.dropFirst(), times).map { $0.duration(to: $1) * -1 }
        XCTAssertTrue(gaps.allSatisfy { $0 >= ApplyPipeline<Int, Int, Int>.frame }, "\(gaps)")
        XCTAssertLessThanOrEqual(recorder.outputs.count, 22, "\(value) inputs in 340 ms became at most one apply per 16.7 ms")
        XCTAssertGreaterThan(value, recorder.outputs.count)
        print("APPLY_PERF pacing: inputs=\(value) applies=\(recorder.outputs.count) min_gap=\(gaps.min().map { String(format: "%.2f", $0.milliseconds) } ?? "-")ms (wall clock, not display frames)")
        pipeline.cancel()
    }
}

final class ApplyPerfPresenceClockTests: XCTestCase {
    private func stopped(_ snapshot: HomeSnapshot, index: Int, lastSeen: Int64) -> HomeSnapshot {
        var snapshot = snapshot
        snapshot.sessions[index].active = false
        snapshot.sessions[index].activeAt = lastSeen
        return snapshot
    }

    func testChatLastSeenChangesOnlyWithItsShownText() {
        let now = ApplyPerfFixtures.now
        var snapshot = stopped(ApplyPerfFixtures.snapshot(3), index: 1, lastSeen: now - 5 * 60_000)
        snapshot.presenceNow = now
        let first = ChatSessionState(snapshot, sessionId: "session-0001")
        XCTAssertEqual(first.lastSeen, .minutes(5))
        snapshot.presenceNow = now + 30_000
        XCTAssertEqual(ChatSessionState(snapshot, sessionId: "session-0001"), first, "still 5 minutes")
        snapshot.presenceNow = now + 60_000
        XCTAssertEqual(ChatSessionState(snapshot, sessionId: "session-0001").lastSeen, .minutes(6))
        // An online session shows no last seen: the clock changes nothing.
        let online = ChatSessionState(snapshot, sessionId: "session-0002")
        snapshot.presenceNow = now + 3_600_000
        XCTAssertNil(online.lastSeen)
        XCTAssertEqual(ChatSessionState(snapshot, sessionId: "session-0002"), online)
    }

    func testHomeRowsUseThePresenceClockAndIgnoreItsTicks() throws {
        var snapshot = ApplyPerfFixtures.snapshot(5)
        snapshot.presenceNow = ApplyPerfFixtures.now
        let input = { (snapshot: HomeSnapshot) in HomeDerivation.Input(snapshot: snapshot, includesDock: true) }
        let applied = try XCTUnwrap(HomeDerivation.derive(input(snapshot), applied: .init())).state
        // A tick that changes no shown text: nothing for the main thread.
        snapshot.presenceNow = ApplyPerfFixtures.now + 60_000
        XCTAssertNil(HomeDerivation.derive(input(snapshot), applied: applied))
        // A day later every stamp turns into a weekday: one reconfigure each.
        snapshot.presenceNow = ApplyPerfFixtures.now + 25 * 3_600_000
        let update = try XCTUnwrap(HomeDerivation.derive(input(snapshot), applied: applied)).output
        XCTAssertEqual(update.changeset.reconfigures.count, 5)
        XCTAssertFalse(update.changeset.isStructural)
    }
}

final class ApplyPerfChatFactsTests: XCTestCase {
    func testFactsComeFromOnePassOverTheMessages() throws {
        var reducer = ChatReducer()
        _ = reducer.reduce([ChatRecords.user("u1", localId: "local-1"), ChatRecords.text("a1")])
        let messages = reducer.messages
        let facts = ChatSnapshotFacts(ChatSnapshot(sessionId: "s", messages: messages, isLoaded: true))
        XCTAssertTrue(facts.isLoaded)
        XCTAssertFalse(facts.isEmpty)
        XCTAssertFalse(facts.hasPendingQuestion)
        XCTAssertEqual(facts.storedLocalIds, ["local-1"])
    }
}
