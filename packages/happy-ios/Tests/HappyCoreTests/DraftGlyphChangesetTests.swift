import Foundation
import GRDB
import XCTest
@testable import HappyCore
@testable import HappyStore

/// The screens' own subscription (`ApplyPipeline.followDrafts`, as home and
/// the iPad sidebar call it) over a real store: a draft appearing or going
/// reconfigures exactly the row that draws its glyph, typing in a draft
/// that exists wakes nothing, and a draft a row doesn't draw applies
/// nothing.
@MainActor
final class DraftGlyphChangesetTests: XCTestCase {
    private func store(sessions: Int) async throws -> LocalStore {
        try await Task.detached {
            let store = try LocalStore(writer: DatabaseQueue())
            try store.replaceMachines([ApplyPerfFixtures.machine])
            try store.upsertSessions((0..<sessions).map(ApplyPerfFixtures.session))
            return store
        }.value
    }

    private func write(_ store: LocalStore, _ edits: [(String, String)]) async throws {
        try await Task.detached {
            for (index, edit) in edits.enumerated() {
                try store.saveDraft(sessionId: edit.0, text: edit.1, at: Int64(index + 1))
            }
        }.value
    }

    func testHomeFlatRowsReconfigureOnlyTheRowWhoseDraftCameOrWent() async throws {
        let store = try await store(sessions: 50)
        let feed = HomeFeed(store: store)
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(clock: ApplyPerfFixtures.clock),
            state: HomeDerivation.Applied(),
            derive: { HomeDerivation.derive($0, applied: $1) },
            apply: { recorder.take($0) }
        )
        pipeline.follow(feed.snapshots()) { $0.snapshot = $1 }
        pipeline.followDrafts(feed, into: \.draftSessionIds)
        await applyPerfWait { recorder.outputs.count == 1 }
        let start = pipeline.counts

        try await write(store, [("session-0020", "h")])
        await applyPerfWait { recorder.outputs.count == 2 }
        XCTAssertEqual(recorder.outputs[1].changeset, RowChangeset(reconfigures: [20]))
        guard case .flat(.session(let row))? = recorder.outputs[1].content.list?.rows[20] else { return XCTFail("flat row") }
        XCTAssertTrue(row.hasDraft)
        XCTAssertEqual(recorder.outputs[1].content.list?.rows.filter { if case .flat(.session(let row)) = $0 { row.hasDraft } else { false } }.count, 1)

        // Thirty keystrokes in that draft, then the last character deleted:
        // only the deletion reaches the pipeline.
        try await write(store, (1...30).map { ("session-0020", String(repeating: "h", count: $0 + 1)) } + [("session-0020", "")])
        await applyPerfWait { recorder.outputs.count == 3 }
        XCTAssertEqual(recorder.outputs[2].changeset, RowChangeset(reconfigures: [20]))
        XCTAssertEqual(pipeline.counts.derivations, start.derivations + 2)
        XCTAssertEqual(pipeline.counts.applies, start.applies + 2)

        pipeline.cancel()
        feed.stop()
        await store.stopSnapshotProducers()
    }

    func testTabletSidebarReconfiguresTheWaitingChatAndTheArchivedCardAlone() async throws {
        // Only the draft table is read from the store; the sidebar's rows
        // come from the grouped fixture.
        let store = try await store(sessions: 0)
        let feed = HomeFeed(store: store)
        let recorder = ApplyPerfRecorder<TabletSidebarUpdate>()
        let pipeline = ApplyPipeline<TabletSidebarInput, TabletSidebarDerivation.Applied, TabletSidebarUpdate>(
            input: TabletSidebarInput(snapshot: TabletGroupedListTests.snapshot()),
            state: TabletSidebarDerivation.Applied(),
            derive: { TabletSidebarDerivation.derive($0, applied: $1, clock: ApplyPerfFixtures.clock) },
            apply: { recorder.take($0) }
        )
        pipeline.followDrafts(feed, into: \.draftSessionIds)
        pipeline.update { _ in }
        await applyPerfWait { recorder.outputs.count == 1 }
        let rows = try XCTUnwrap(recorder.outputs[0].frame.grouped?.rows)
        let chat = try XCTUnwrap(rows.firstIndex { if case .chat(let row) = $0 { row.id == "s1" } else { false } })
        let archived = try XCTUnwrap(rows.firstIndex { if case .archived(let row) = $0 { row.id == "a1" } else { false } })

        try await write(store, [("s1", "draft")])
        await applyPerfWait { recorder.outputs.count == 2 }
        XCTAssertEqual(recorder.outputs[1].changeset, RowChangeset(reconfigures: [chat]))
        guard case .chat(let row)? = recorder.outputs[1].frame.grouped?.rows[chat] else { return XCTFail("chat row") }
        XCTAssertTrue(row.hasDraft)

        try await write(store, [("a1", "later")])
        await applyPerfWait { recorder.outputs.count == 3 }
        XCTAssertEqual(recorder.outputs[2].changeset, RowChangeset(reconfigures: [archived]))
        guard case .archived(let card)? = recorder.outputs[2].frame.grouped?.rows[archived] else { return XCTFail("archived row") }
        XCTAssertTrue(card.hasDraft)

        // s2 is thinking: its row draws no glyph, so its draft applies
        // nothing. s1's draft going is the fence that follows it.
        let applies = pipeline.counts.applies
        try await write(store, [("s2", "not drawn"), ("s1", "")])
        await applyPerfWait { recorder.outputs.count == 4 }
        XCTAssertEqual(recorder.outputs[3].changeset, RowChangeset(reconfigures: [chat]))
        XCTAssertEqual(pipeline.counts.applies, applies + 1)

        pipeline.cancel()
        feed.stop()
        await store.stopSnapshotProducers()
    }
}
