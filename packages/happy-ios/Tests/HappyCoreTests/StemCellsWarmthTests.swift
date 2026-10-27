import HappyCore
import XCTest

final class StemCellsWarmthTests: XCTestCase {
    private func row(_ agent: String, kind: StemCellsRow.Kind = .space, status: StemCellsRow.Status = .none, unread: Bool = false, target: String? = "task") -> StemCellsRow {
        StemCellsRow(id: "space:\(agent)", nodeId: agent, kind: kind, label: agent, status: status, unread: unread, agentId: agent, spaceId: agent, targetKind: target)
    }

    /// Every row that opens a conversation, once, in the sidebar's order:
    /// not a surface, a section, or the same agent twice.
    func testTheCandidatesAreTheSidebarsConversationsOnce() {
        let rows = [
            row("a"), row("doc", target: "surface"), row("b", kind: .session, status: .working),
            StemCellsRow(id: "section:s", nodeId: "s", kind: .section, label: "S"), row("a"),
        ]
        XCTAssertEqual(StemCellsWarmth.candidates(rows), [
            .init(agentId: "a", running: false, unread: false),
            .init(agentId: "b", running: true, unread: false),
        ])
    }

    /// Desktop's order, running first; then what stands for "recently
    /// updated" on a phone: the rows on screen top first, unread, the last left, the
    /// rest in the sidebar's order.
    func testTheRankingIsRunningThenWhatShowsThenNewsThenTheLastLeft() {
        let candidates = [
            StemCellsWarmth.Candidate(agentId: "top", running: false, unread: false),
            .init(agentId: "seen", running: false, unread: false),
            .init(agentId: "left-long-ago", running: false, unread: false),
            .init(agentId: "news", running: false, unread: true),
            .init(agentId: "left", running: false, unread: false),
            .init(agentId: "busy", running: true, unread: false),
            .init(agentId: "below", running: false, unread: false),
            .init(agentId: "seen-news", running: false, unread: true),
        ]
        let ranked = StemCellsWarmth.ranked(candidates, left: ["left", "left-long-ago"], visible: ["top", "seen", "seen-news"], limit: 12)
        XCTAssertEqual(ranked, ["busy", "top", "seen", "seen-news", "news", "left", "left-long-ago", "below"])
        XCTAssertEqual(StemCellsWarmth.ranked(candidates, left: [], visible: [], limit: 3), ["busy", "news", "seen-news"])
        XCTAssertEqual(StemCellsWarmth.ranked(candidates, left: [], visible: [], limit: 0), [])
    }

    /// Desktop's limits; every one read ahead laid out, but on a phone
    /// under 4GB, one per gigabyte.
    func testTheLimitsAreDesktops() {
        XCTAssertEqual(StemCellsWarmth.Limits.preloaded, 12)
        XCTAssertEqual(StemCellsWarmth.Limits.prefetched, 6)
        XCTAssertEqual(StemCellsWarmth.Limits.released, 16)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 1_500_000_000), 2)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 3_000_000_000), 3)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 6_000_000_000), 12)
        XCTAssertEqual(StemCellsWarmth.laidOut(physicalMemory: 16_000_000_000), 12)
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
