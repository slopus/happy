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
}
