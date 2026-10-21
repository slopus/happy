import Foundation
import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

/// What home did before the apply work (b1247fce), modelled: it runs the
/// production `HomeState` once per delivery, as `HomeViewController.received`
/// did on the main thread, and repeats `SessionListViewController.apply`'s
/// row comparison (full `SessionRow` equality, a fresh diffable snapshot per
/// change). It never runs UIKit, so it counts work, not UIKit time.
/// (Baseline after rsk9uz60gm70eksxwl249t4n's fixtures.)
private struct LegacyHomeApply {
    struct Counts: Equatable {
        /// `HomeState` built on the main thread.
        var mainDerivations = 0
        /// Fresh diffable snapshots applied.
        var applies = 0
        var inserts = 0
        var deletes = 0
        var reconfigures = 0
        var moves = 0
    }

    private var state: HomeState?
    private var rows: [SessionRow] = []
    var counts = Counts()

    mutating func receive(_ snapshot: HomeSnapshot) {
        counts.mainDerivations += 1
        let next = HomeState(snapshot, clock: ApplyPerfFixtures.clock)
        guard next != state else { return }
        state = next
        let newRows: [SessionRow]
        if case .list(let list, _) = next {
            newRows = list.items.compactMap { if case .session(let row) = $0 { row } else { nil } }
        } else {
            newRows = []
        }
        let changes = RowChangeset(from: rows, to: newRows, id: \.id)
        counts.applies += 1
        counts.inserts += changes.inserts.count
        counts.deletes += changes.deletes.count
        counts.moves += changes.moves.count
        counts.reconfigures += changes.reconfigures.count
        rows = newRows
    }

    mutating func resetCounts() { counts = Counts() }
}

final class ApplyPerfBaselineTests: XCTestCase {
    func testBeforeInvisibleFieldsDeriveOnMainForEveryDelivery() {
        var snapshot = ApplyPerfFixtures.snapshot(50)
        var baseline = LegacyHomeApply()
        baseline.receive(snapshot)
        baseline.resetCounts()
        for step in 1...150 {
            snapshot.sessions[0] = ApplyPerfFixtures.invisiblyTouched(snapshot.sessions[0], by: Int64(step))
            baseline.receive(snapshot)
        }
        XCTAssertEqual(baseline.counts, .init(mainDerivations: 150))
        print("APPLY_PERF before invisible-fields: main_derivations=150 home_applies=0")
    }

    func testBeforeOneTitleReconfiguresOneRow() {
        var snapshot = ApplyPerfFixtures.snapshot(50)
        var baseline = LegacyHomeApply()
        baseline.receive(snapshot)
        baseline.resetCounts()
        snapshot.sessions[20] = ApplyPerfFixtures.retitled(snapshot.sessions[20], "Changed")
        baseline.receive(snapshot)
        XCTAssertEqual(baseline.counts, .init(mainDerivations: 1, applies: 1, reconfigures: 1))
    }

    func testBeforeCatchUpInFivePagesAppliesFiveTimes() {
        let fixture = ApplyPerfFixtures.snapshot(500)
        var snapshot = fixture
        snapshot.sessions = []
        var baseline = LegacyHomeApply()
        baseline.receive(snapshot)
        baseline.resetCounts()
        for end in stride(from: 100, through: 500, by: 100) {
            snapshot.sessions = Array(fixture.sessions.prefix(end))
            baseline.receive(snapshot)
        }
        // Each page's last row gains its hairline when the next page lands.
        XCTAssertEqual(baseline.counts, .init(mainDerivations: 5, applies: 5, inserts: 500, reconfigures: 4))
    }

    func testBeforeNewActivityMovesAndRedrawsTheRow() {
        let (before, after) = ApplyPerfFixtures.overtaking()
        var baseline = LegacyHomeApply()
        baseline.receive(before)
        baseline.resetCounts()
        baseline.receive(after)
        // The row's raw `lastActivityAt` differs although its stamp reads
        // the same, so it was redrawn as well as moved.
        XCTAssertEqual(baseline.counts, .init(mainDerivations: 1, applies: 1, reconfigures: 1, moves: 1))
    }

    func testBeforeChatComparedTheWholeRecord() {
        let before = ApplyPerfFixtures.session(0)
        let after = ApplyPerfFixtures.invisiblyTouched(before, by: 1000)
        XCTAssertNotEqual(before, after, "the chat screen's old state held and compared the whole record")
        XCTAssertEqual(
            ChatHeaderModel(session: before, dataReady: true, gitStatus: nil),
            ChatHeaderModel(session: after, dataReady: true, gitStatus: nil)
        )
    }

    func testBeforeMainThreadDerivationCost() {
        for count in [1, 50, 1000] {
            let fixture = ApplyPerfFixtures.snapshot(count)
            let median = applyPerfMedian {
                var baseline = LegacyHomeApply()
                baseline.receive(fixture)
            }
            XCTAssertLessThan(median, 10_000, "generous shared-machine ceiling; not a device budget")
            print("APPLY_PERF before home-derivation-\(count): median=\(String(format: "%.3f", median))ms (was on main; Linux debug)")
        }
    }
}
