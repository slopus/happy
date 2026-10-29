import HappyCore
import XCTest

final class StemCellsWarmthTests: XCTestCase {
    private func row(_ agent: String, kind: StemCellsRow.Kind = .space, status: StemCellsRow.Status = .none, unread: Bool = false, target: String? = "task") -> StemCellsRow {
        StemCellsRow(id: "space:\(agent)", nodeId: agent, kind: kind, label: agent, status: status, unread: unread, agentId: agent, spaceId: agent, targetKind: target)
    }

    /// Every row shown that opens a conversation, once, at its first row:
    /// not a surface, a section, or the same agent twice.
    func testTheCandidatesAreTheShownConversationsOnce() {
        let rows = [
            row("a"), row("doc", target: "surface"), row("b", kind: .session, status: .working),
            StemCellsRow(id: "section:s", nodeId: "s", kind: .section, label: "S"), row("a"),
        ]
        XCTAssertEqual(StemCellsWarmth.candidates(rows), [.init(agentId: "a", row: 0), .init(agentId: "b", row: 2)])
    }

    /// What the sidebar shows (agreed with desktop): the rows on screen top
    /// to bottom, whatever runs or is unread, then the nearest off it, the
    /// one below before the one above.
    func testTheRankingIsWhatShowsThenTheNearest() {
        let candidates = ["far-above", "above", "top", "busy", "bottom", "below", "two-below", "far-below"].enumerated().map {
            StemCellsWarmth.Candidate(agentId: $1, row: [0, 3, 4, 5, 6, 7, 8, 12][$0])
        }
        XCTAssertEqual(StemCellsWarmth.ranked(candidates, visible: 4...6, limit: 12),
                       ["top", "busy", "bottom", "below", "above", "two-below", "far-above", "far-below"])
        XCTAssertEqual(StemCellsWarmth.ranked(candidates, visible: 4...6, limit: 4), ["top", "busy", "bottom", "below"])
        // Not yet measured: the first rows.
        XCTAssertEqual(StemCellsWarmth.ranked(candidates, visible: nil, limit: 3), ["far-above", "above", "top"])
        XCTAssertEqual(StemCellsWarmth.ranked(candidates, visible: 4...6, limit: 0), [])
    }

    /// Desktop's limits; laid out, desktop's retention for the memory:
    /// one view per gigabyte, the open one included, two to eight.
    func testTheLimitsAreDesktops() {
        XCTAssertEqual(StemCellsWarmth.Limits.preloaded, 12)
        XCTAssertEqual(StemCellsWarmth.Limits.prefetched, 6)
        XCTAssertEqual(StemCellsWarmth.Limits.released, 16)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 1_500_000_000), 1)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 3_000_000_000), 2)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 6_000_000_000), 5)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 16_000_000_000), 7)
    }

    /// What is on screen and what the ranking wants stay; of the rest the
    /// last left and the last reached for, each to its own limit.
    func testRetentionKeepsTheOpenTheWantedTheLastLeftAndTheLastReachedFor() {
        let kept: [StemCellsWarmth.Kept] = [
            .init(agentId: "open", held: true),
            .init(agentId: "wanted"),
            .init(agentId: "dropped"),
            .init(agentId: "left-1", left: 1),
            .init(agentId: "left-2", left: 2),
            .init(agentId: "left-3", left: 3),
            .init(agentId: "reached-1", intent: 1),
            .init(agentId: "reached-2", intent: 2),
            // Reached for, then opened and left: counted as left.
            .init(agentId: "reached-left", left: 0, intent: 9),
        ]
        let stays = StemCellsWarmth.retained(kept, wanted: ["wanted", "not-kept"], released: 2, prefetched: 1)
        XCTAssertEqual(stays, ["open", "wanted", "left-3", "left-2", "reached-2"])
        XCTAssertEqual(StemCellsWarmth.retained(kept, wanted: []).count, kept.count - 2, "all but the wanted and the dropped")
    }

    /// Laid out first: the last reached for, the one just left, the
    /// ranking, then the rest left; never what is on screen, which lays
    /// itself out.
    func testThePlannedAreTheReachedForTheJustLeftTheRankedThenTheLeft() {
        let kept: [StemCellsWarmth.Kept] = [
            .init(agentId: "open", held: true, intent: 5),
            .init(agentId: "a"), .init(agentId: "b"),
            .init(agentId: "left-before", left: 1),
            .init(agentId: "left", left: 2),
            .init(agentId: "reached", intent: 3),
        ]
        XCTAssertEqual(StemCellsWarmth.planned(kept, ranked: ["open", "b", "a", "missing"], budget: 8), ["reached", "left", "b", "a", "left-before"])
        XCTAssertEqual(StemCellsWarmth.planned(kept, ranked: ["b", "a"], budget: 2), ["reached", "left"])
    }
}
