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

    /// `record` as Happy Agent publishes it, with these line counts for
    /// its checkout (rig.ts `getRigGitSummary`).
    static func withLineChanges(_ record: SessionRecord, insertions: Double, deletions: Double = 1, files: Double = 1) -> SessionRecord {
        var record = record
        var metadata = record.metadata?.objectValue ?? [:]
        metadata["client"] = .object(["id": .string("rig")])
        metadata["git"] = .object([
            "changedFiles": .number(files), "countsExact": .bool(true),
            "insertions": .number(insertions), "deletions": .number(deletions),
        ])
        record.metadata = .object(metadata)
        return record
    }

    /// Home's list alone, without the new-session pickers' snapshot (which
    /// keeps the metadata whole).
    static func listOnly(_ snapshot: HomeSnapshot, after applied: HomeDerivation.Applied?) -> (output: HomeUpdate, state: HomeDerivation.Applied)? {
        HomeDerivation.derive(HomeDerivation.Input(snapshot: snapshot, clock: ApplyPerfFixtures.clock), applied: applied ?? .init())
    }

    func testOneSessionsLineChangesReconfigureExactlyOneRow() throws {
        var snapshot = ApplyPerfFixtures.snapshot(50)
        snapshot.sessions[20] = Self.withLineChanges(snapshot.sessions[20], insertions: 3)
        let applied = try XCTUnwrap(Self.listOnly(snapshot, after: nil)).state
        snapshot.sessions[20] = Self.withLineChanges(snapshot.sessions[20], insertions: 4)
        let update = try XCTUnwrap(Self.listOnly(snapshot, after: applied))
        XCTAssertEqual(update.output.changeset, RowChangeset(reconfigures: [20]))
        XCTAssertFalse(update.output.kindChanged)

        // The row draws no file count.
        snapshot.sessions[20] = Self.withLineChanges(snapshot.sessions[20], insertions: 4, files: 7)
        XCTAssertNil(Self.listOnly(snapshot, after: update.state))
        // A clean comparison takes the counts away.
        snapshot.sessions[20] = Self.withLineChanges(snapshot.sessions[20], insertions: 0, deletions: 0)
        XCTAssertEqual(try XCTUnwrap(Self.listOnly(snapshot, after: update.state)).output.changeset, RowChangeset(reconfigures: [20]))
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

    /// The screen's next main-thread turn after an apply already sees it
    /// as applied: the state moves with the count, not later on the
    /// derivation's own thread.
    @MainActor
    func testTheAppliedStateMovesWithTheApplyItself() async {
        let box = ApplyPerfPipelineBox<ApplyPipeline<Int, Int, Int>>()
        let seen = ApplyPerfRecorder<[Int]>()
        let pipeline = ApplyPipeline<Int, Int, Int>(
            input: 0,
            state: 0,
            minimumInterval: .zero,
            derive: { input, applied in input == applied ? nil : (input, input) },
            apply: { _ in
                Task { @MainActor in
                    guard let pipeline = box.pipeline else { return }
                    _ = seen.take([pipeline.counts.applies, pipeline.applied])
                }
                return true
            }
        )
        box.pipeline = pipeline
        for value in 1...40 {
            pipeline.update { $0 = value }
            await applyPerfWait { seen.outputs.count == value }
        }
        XCTAssertEqual(seen.outputs, (1...40).map { [$0, $0] }, "after apply n, n applies and state n")
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

    /// ProjectHomeList.tsx's `ChatRow` (a bot, an archived chat) draws no
    /// line counts, so theirs never reach the main thread.
    func testABotsAndAnArchivedChatsLineChangesRedrawNothingInTheProjectList() throws {
        var snapshot = grouped(ApplyPerfFixtures.snapshot(3), "project")
        snapshot.settings.pending["hideInactiveSessions"] = .bool(false)
        func bot(_ record: SessionRecord) -> SessionRecord {
            var record = record
            var metadata = record.metadata?.objectValue ?? [:]
            metadata["bot"] = .object(["username": .string("ops")])
            record.metadata = .object(metadata)
            return record
        }
        func archived(_ record: SessionRecord) -> SessionRecord {
            var record = record
            var metadata = record.metadata?.objectValue ?? [:]
            metadata["lifecycleState"] = .string("archived")
            record.metadata = .object(metadata)
            return record
        }
        snapshot.sessions[1] = bot(ApplyPerfHomeTests.withLineChanges(snapshot.sessions[1], insertions: 3))
        snapshot.sessions[2] = archived(ApplyPerfHomeTests.withLineChanges(snapshot.sessions[2], insertions: 3))
        let applied = try XCTUnwrap(ApplyPerfHomeTests.listOnly(snapshot, after: nil)).state
        let rows = try XCTUnwrap(applied.content?.list?.rows)
        XCTAssertTrue(rows.contains { if case .project(.bot(let row)) = $0 { row.id == "session-0001" && row.changes == nil } else { false } })
        XCTAssertTrue(rows.contains { if case .project(.archived(let row)) = $0 { row.id == "session-0002" && row.changes == nil } else { false } })

        snapshot.sessions[1] = ApplyPerfHomeTests.withLineChanges(snapshot.sessions[1], insertions: 30)
        snapshot.sessions[2] = ApplyPerfHomeTests.withLineChanges(snapshot.sessions[2], insertions: 30)
        XCTAssertNil(ApplyPerfHomeTests.listOnly(snapshot, after: applied))
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
    /// Each apply starts at least a frame after the previous one finished.
    /// Every apply here does 2 ms of work (spinning, not sleeping), so pacing
    /// from when an apply started would leave gaps of about 14.7 ms.
    @MainActor
    func testEachApplyStartsAFrameAfterThePreviousOneFinished() async throws {
        let recorder = ApplyPerfRecorder<Int>()
        let frame = ApplyPipeline<Int, Int, Int>.frame
        var starts: [ContinuousClock.Instant] = []
        var ends: [ContinuousClock.Instant] = []
        let pipeline = ApplyPipeline<Int, Int, Int>(
            input: 0,
            state: 0,
            derive: { input, applied in input == applied ? nil : (input, input) },
            apply: { value in
                let start = ContinuousClock.now
                starts.append(start)
                while start.duration(to: .now) < .milliseconds(2) {}
                defer { ends.append(.now) }
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
        // From the end of one apply to the start of the next.
        let idle = zip(ends, starts.dropFirst()).map { $0.duration(to: $1) }
        XCTAssertTrue(idle.allSatisfy { $0 >= frame }, "\(idle)")
        let gaps = zip(starts, starts.dropFirst()).map { $0.duration(to: $1) }
        XCTAssertTrue(gaps.allSatisfy { $0 >= frame + .milliseconds(2) }, "\(gaps)")
        XCTAssertLessThanOrEqual(recorder.outputs.count, 22, "\(value) inputs in 340 ms became at most one apply per 18.7 ms")
        XCTAssertGreaterThan(value, recorder.outputs.count)
        let format = { (durations: [Duration]) in durations.min().map { String(format: "%.2f", $0.milliseconds) } ?? "-" }
        print("APPLY_PERF pacing: inputs=\(value) applies=\(recorder.outputs.count) min_idle=\(format(idle))ms min_gap=\(format(gaps))ms (wall clock, not display frames)")
        pipeline.cancel()
    }
}

final class ApplyPerfDockTests: XCTestCase {
    /// The dock's pickers order sessions by whether they are online and by
    /// their last meaningful message: both reach them, a heartbeat or a
    /// cursor does not.
    func testOrderingFieldsReachTheDockAndHeartbeatsDoNot() throws {
        let snapshot = ApplyPerfFixtures.snapshot(5)
        let applied = try XCTUnwrap(ApplyPerfFixtures.derive(snapshot, after: nil)).state
        let dock = try XCTUnwrap(applied.dock)
        XCTAssertEqual(dock.sessions.map(\.active), snapshot.sessions.map(\.active))
        XCTAssertEqual(dock.sessions.map(\.lastActivityAt), snapshot.sessions.map(\.lastActivityAt))

        var heartbeat = snapshot
        heartbeat.sessions = heartbeat.sessions.map { ApplyPerfFixtures.invisiblyTouched($0, by: 2000) }
        XCTAssertNil(ApplyPerfFixtures.derive(heartbeat, after: applied), "nothing for home or the dock")

        var message = snapshot
        message.sessions[3] = ApplyPerfFixtures.active(message.sessions[3], at: ApplyPerfFixtures.now + 5)
        let messaged = try XCTUnwrap(ApplyPerfFixtures.derive(message, after: applied)).output
        XCTAssertEqual(messaged.dock?.sessions[3].lastActivityAt, ApplyPerfFixtures.now + 5)

        var stopped = snapshot
        stopped.sessions[2].active = false
        let stoppedUpdate = try XCTUnwrap(ApplyPerfFixtures.derive(stopped, after: applied)).output
        XCTAssertEqual(stoppedUpdate.dock?.sessions[2].active, false)
    }
}

extension ApplyPerfDockTests {
    /// The new-session screen hears nothing until the computers are known,
    /// so an empty first read never resets the draft; then only what its
    /// pickers read.
    func testTheNewSessionScreenWaitsForComputersAndIgnoresHeartbeats() throws {
        var unknown = ApplyPerfFixtures.snapshot(3)
        unknown.machines = MachinesSnapshot(synced: false, machines: [])
        XCTAssertNil(NewSessionSnapshot.derive(unknown, applied: nil))
        XCTAssertNil(NewSessionSnapshot.derive(nil, applied: nil))

        var onDisk = ApplyPerfFixtures.snapshot(3)
        onDisk.machines.synced = false
        let first = try XCTUnwrap(NewSessionSnapshot.derive(onDisk, applied: nil))
        XCTAssertEqual(first.output.machines.machines.count, 1, "computers from before, ahead of the refresh")

        var noComputers = unknown
        noComputers.machines.synced = true
        XCTAssertNotNil(NewSessionSnapshot.derive(noComputers, applied: nil), "synced and empty is an answer")

        var heartbeat = onDisk
        heartbeat.sessions = heartbeat.sessions.map { ApplyPerfFixtures.invisiblyTouched($0, by: 2000) }
        heartbeat.presenceNow = ApplyPerfFixtures.now + 60_000
        XCTAssertNil(NewSessionSnapshot.derive(heartbeat, applied: first.state))

        var message = onDisk
        message.sessions[2] = ApplyPerfFixtures.active(message.sessions[2], at: ApplyPerfFixtures.now + 5)
        XCTAssertNotNil(NewSessionSnapshot.derive(message, applied: first.state))
    }
}

extension ApplyPerfDockTests {
    /// Two sessions in one directory under different projects: the newer
    /// one names the directory's project in the pickers. A send this device
    /// accepted makes a session the newer one before the server stamps it,
    /// on home's dock and on the new-session screen alike.
    func testAnAcceptedSendReordersThePickersSamePathProject() async throws {
        let store = try LocalStore.inMemory()
        func session(_ id: String, createdAt: Int64, project: String) -> SessionRecord {
            var record = ChatRecords.storeSession(id, metadata: .object([
                "machineId": .string("m"), "path": .string("/work"),
                "project": .object(["id": .string(project), "name": .string(project)]),
            ]))
            record.createdAt = createdAt
            return record
        }
        try store.upsertSessions([session("x", createdAt: 1, project: "px"), session("y", createdAt: 2, project: "py")])
        try store.upsertMachine(.init(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, metadataCipher: "", metadata: .object(["host": .string("host")]), daemonStateVersion: 0,
            daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true))
        let draft = NewSessionDraft(selectedMachineId: "m")
        func project(_ snapshot: HomeSnapshot, revision: UInt64) async -> String? {
            let choices = await NewSessionChoiceDeriver().choices(snapshot: snapshot, revision: revision, generation: revision,
                                                                  draft: draft, createsBot: false, worktrees: [])
            return choices?.value.sessionPlaces.first { $0.path == "/work" }?.projectId
        }

        let before = try store.homeSnapshot()
        let screen = try XCTUnwrap(NewSessionSnapshot.derive(before, applied: nil))
        let home = try XCTUnwrap(ApplyPerfFixtures.derive(before, after: nil)).state
        let shownBefore = await project(screen.output, revision: 0)
        XCTAssertEqual(shownBefore, "py")

        try store.enqueueAcceptedSend([.init(localId: "sent", kind: .message, sessionId: "x", payload: .object([
            "role": .string("user"), "content": .object(["type": .string("text"), "text": .string("hello")]),
        ]), createdAt: 100)], attachments: [])
        let after = try store.homeSnapshot()
        XCTAssertEqual(after.sessions.first { $0.id == "x" }?.lastMessageSentAt, 100)

        let screenAfter = try XCTUnwrap(NewSessionSnapshot.derive(after, applied: screen.state), "the new-session screen hears the send")
        let shownAfter = await project(screenAfter.output, revision: 1)
        XCTAssertEqual(shownAfter, "px")
        let dock = try XCTUnwrap(ApplyPerfFixtures.derive(after, after: home)?.output.dock, "home's dock hears the send")
        let dockShown = await project(dock, revision: 2)
        XCTAssertEqual(dockShown, "px")
        XCTAssertEqual(ChatSessionState(after, sessionId: "x"), ChatSessionState(before, sessionId: "x"), "the chat does not")
    }
}

final class ApplyPerfMachineScreenTests: XCTestCase {
    /// The machine screen rebuilds for what it shows: a session's
    /// heartbeat or cursor is nothing to it, a title on this machine is.
    func testTheMachineScreenIgnoresSessionHeartbeats() {
        let snapshot = MachineDetailSnapshot(machine: ApplyPerfFixtures.machine, sessions: (0..<8).map(ApplyPerfFixtures.session))
        let shown = MachineScreenContent(snapshot)
        XCTAssertEqual(shown.model?.recentSessions.count, MachineDetailsModel.recentSessionLimit)

        var heartbeat = snapshot
        heartbeat.sessions = heartbeat.sessions.map { ApplyPerfFixtures.invisiblyTouched($0, by: 2000) }
        XCTAssertEqual(MachineScreenContent(heartbeat), shown)

        var retitled = snapshot
        retitled.sessions[0] = ApplyPerfFixtures.retitled(retitled.sessions[0], "Renamed")
        XCTAssertNotEqual(MachineScreenContent(retitled), shown)

        XCTAssertNil(MachineScreenContent(MachineDetailSnapshot(machine: nil, sessions: [])).model, "not found")
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

    /// The presence clock stands still while nothing is disconnected, here
    /// 30 hours. Home and the sidebar write headings at the real time, so
    /// last night's archived chat is "Yesterday", not "Today".
    func testHomeHeadingsIgnoreAStalePresenceClock() throws {
        let now = Date()
        let calendar = Calendar.autoupdatingCurrent
        let today = calendar.startOfDay(for: now)
        let millis = { (date: Date) in Int64(date.timeIntervalSince1970 * 1000) }
        var snapshot = ApplyPerfFixtures.snapshot(3)
        snapshot.sessions[1] = ApplyPerfFixtures.active(snapshot.sessions[1], at: millis(max(today, now - 2 * 3600)))
        snapshot.sessions[1].active = false
        snapshot.sessions[2] = ApplyPerfFixtures.active(snapshot.sessions[2], at: millis(today - 3600))
        snapshot.sessions[2].active = false
        snapshot.settings = SettingsSnapshot(pending: ["hideInactiveSessions": .bool(false)])
        snapshot.presenceNow = millis(now) - 30 * 3_600_000

        let home = try XCTUnwrap(HomeDerivation.derive(HomeDerivation.Input(snapshot: snapshot), applied: .init())).output
        let headings = try XCTUnwrap(home.content.list).rows.compactMap { row -> SessionList.DayAge? in
            if case .flat(.dayHeader(let age)) = row { return age }
            return nil
        }
        XCTAssertEqual(headings, [.today, .yesterday])

        let sidebar = try XCTUnwrap(TabletSidebarDerivation.derive(snapshot, applied: .init())).output
        guard case .list(let list) = sidebar.frame.content else { return XCTFail("the sidebar lists the live session") }
        let sidebarHeadings = list.rows.compactMap { row -> SessionList.DayAge? in
            if case .flat(.dayHeader(let age)) = row { return age }
            return nil
        }
        XCTAssertEqual(sidebarHeadings, [.today, .yesterday])
    }

    /// With the time fixed, presence ticks alone reach neither home nor the
    /// sidebar, a minute or a day apart.
    func testPresenceTicksAloneChangeNothingOnHome() throws {
        var snapshot = stopped(ApplyPerfFixtures.snapshot(5), index: 1, lastSeen: ApplyPerfFixtures.now - 5 * 60_000)
        snapshot.presenceNow = ApplyPerfFixtures.now
        let input = { (snapshot: HomeSnapshot) in
            HomeDerivation.Input(snapshot: snapshot, includesDock: true, clock: ApplyPerfFixtures.clock)
        }
        let home = try XCTUnwrap(HomeDerivation.derive(input(snapshot), applied: .init())).state
        let sidebar = try XCTUnwrap(TabletSidebarDerivation.derive(snapshot, applied: .init(), clock: ApplyPerfFixtures.clock)).state
        for tick: Int64 in [60_000, 25 * 3_600_000] {
            snapshot.presenceNow = ApplyPerfFixtures.now + tick
            XCTAssertNil(HomeDerivation.derive(input(snapshot), applied: home))
            XCTAssertNil(TabletSidebarDerivation.derive(snapshot, applied: sidebar, clock: ApplyPerfFixtures.clock))
        }
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
