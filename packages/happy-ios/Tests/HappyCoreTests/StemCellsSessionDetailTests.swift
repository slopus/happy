import Foundation
import HappyCore
import XCTest

final class StemCellsSessionDetailTests: XCTestCase {
    /// The bootstrap as the daemon sends it: usage by provider then model,
    /// its children newest first, its processes.
    func testTheDetailCountsTokensOverEveryModelAndSplitsTheActivity() throws {
        let json = """
        {"agent":{"id":"a","title":"Plan","status":"idle","createdAt":1000,"subagents":{"total":3,"running":1},"workspaceId":"w"},
         "mode":{"providerId":"claude","modelId":"anthropic/sonnet-5","effort":"medium","permissionMode":"auto"},
         "context":{"approximate":false,"contextTokens":10},
         "usage":{"claude":{"anthropic/sonnet-5":{"input":1200,"output":300,"cacheRead":9000}},"codex":{"openai/gpt":{"input":500,"output":0}}},
         "processes":[{"id":"p1","agentId":"a","command":"pnpm dev","status":"running","startedAt":5},{"id":"p2","agentId":"a","command":"ls","status":"exited","exitCode":0}],
         "subagents":[{"id":"c1","title":"Research","status":"running_tools","totalTokens":42,"archivedAt":null},
                      {"id":"c2","title":null,"status":"idle","totalTokens":null},
                      {"id":"c3","title":"Old","status":"idle","archivedAt":7,"totalTokens":9}],
         "pending":[],"slashCommands":[],"cursor":"x"}
        """
        let wire = try JSONDecoder().decode(AgentWire.Detail.self, from: Data(json.utf8))
        let detail = StemCellsSessionDetail(wire)
        XCTAssertEqual(detail.tokens, 2000, "input and output, never the cache")
        XCTAssertEqual(detail.title, "Plan")
        XCTAssertFalse(detail.working)
        XCTAssertFalse(detail.subtask)
        XCTAssertEqual(detail.createdAt, 1000)
        XCTAssertEqual(detail.subagentsRunning, 1)
        XCTAssertEqual(detail.subagentsTotal, 3)
        XCTAssertEqual(detail.mode?.modelId, "anthropic/sonnet-5")
        XCTAssertEqual(detail.running.map(\.id), ["c1"])
        XCTAssertEqual(detail.completed.map(\.id), ["c2", "c3"])
        XCTAssertEqual(detail.completed.map(\.archived), [false, true])
        XCTAssertEqual(detail.terminals.map(\.command), ["pnpm dev"], "running ones only")
        XCTAssertEqual(detail.terminals.first?.startedAt, 5)
        XCTAssertFalse(detail.isQuiet)
    }

    func testNoUsageIsNoCountAndNothingAtWorkIsQuiet() {
        let detail = StemCellsSessionDetail(AgentWire.Detail(agent: .init(id: "a")))
        XCTAssertNil(detail.tokens)
        XCTAssertTrue(detail.isQuiet)
        XCTAssertEqual(detail.subagentsTotal, 0)
    }

    func testTokensAreThreeFiguresAtMostAndNeverRoundedUp() {
        XCTAssertEqual(StemCellsDetailFormat.tokens(0), "0")
        XCTAssertEqual(StemCellsDetailFormat.tokens(980), "980")
        XCTAssertEqual(StemCellsDetailFormat.tokens(1_000), "1K")
        XCTAssertEqual(StemCellsDetailFormat.tokens(1_299), "1.2K")
        XCTAssertEqual(StemCellsDetailFormat.tokens(12_999), "12K")
        XCTAssertEqual(StemCellsDetailFormat.tokens(120_996_446), "120M")
        XCTAssertEqual(StemCellsDetailFormat.tokens(1_250_000_000), "1.2B")
    }

    func testAgeIsTheLargestWholeUnit() {
        let minute = 60_000.0
        XCTAssertEqual(StemCellsDetailFormat.age(since: 0, now: 30_000), .justNow)
        XCTAssertEqual(StemCellsDetailFormat.age(since: 0, now: 5 * minute), .minutes(5))
        XCTAssertEqual(StemCellsDetailFormat.age(since: 0, now: 125 * minute), .hours(2))
        XCTAssertEqual(StemCellsDetailFormat.age(since: 0, now: 3 * 1440 * minute), .days(3))
        XCTAssertEqual(StemCellsDetailFormat.age(since: 0, now: 65 * 1440 * minute), .months(2))
        XCTAssertEqual(StemCellsDetailFormat.age(since: 0, now: 800 * 1440 * minute), .years(2))
    }

    // MARK: Family

    private func space(_ id: String, depth: Int = 0, collapsed: Bool? = nil) -> StemCellsRow {
        StemCellsRow(id: id, nodeId: id, kind: .space, depth: depth, label: id, collapsed: collapsed, agentId: id, spaceId: id, targetKind: "task")
    }

    private func session(_ id: String, depth: Int) -> StemCellsRow {
        StemCellsRow(id: id, nodeId: id, kind: .session, depth: depth, label: id, agentId: id)
    }

    private func section(_ id: String) -> StemCellsRow {
        StemCellsRow(id: id, nodeId: id, kind: .section, label: id, collapsed: true)
    }

    /// A nested conversation: its parent row, its siblings a level in, and
    /// its own children a level further; nothing of the next tree.
    func testANestedConversationShowsItsParentItsSiblingsAndItsChildren() {
        let rows = [
            space("bot", collapsed: false), session("a", depth: 1), session("me", depth: 1),
            session("kid", depth: 2), session("grandkid", depth: 3), session("b", depth: 1),
            space("next"), session("other", depth: 1),
        ]
        let family = StemCellsFamily.of("me", in: rows)
        XCTAssertEqual(family.map(\.id), ["bot", "a", "me", "kid", "b"])
        XCTAssertEqual(family.map(\.depth), [0, 1, 1, 2, 1])
        XCTAssertEqual(family.map(\.collapsed), [nil, nil, nil, nil, nil], "nothing folds here")
    }

    /// At the top level, filed under a section or not: itself over its
    /// children, no section and no siblings.
    func testATopLevelConversationShowsOnlyItsChildren() {
        let rows = [space("loose"), section("Work"), space("x"), space("me"), session("kid", depth: 1), session("grandkid", depth: 2), space("y"), section("Home"), space("z")]
        let family = StemCellsFamily.of("me", in: rows)
        XCTAssertEqual(family.map(\.id), ["me", "kid"])
        XCTAssertEqual(family.map(\.depth), [0, 1])
        XCTAssertEqual(StemCellsFamily.of("loose", in: rows).map(\.id), ["loose"], "alone, with no children")
    }

    /// A surface's row opens no conversation: it isn't family.
    func testSurfacesAreNotFamily() {
        let doc = StemCellsRow(id: "doc", nodeId: "doc", kind: .session, depth: 1, label: "doc", spaceId: "doc", targetKind: "surface")
        XCTAssertEqual(StemCellsFamily.of("me", in: [space("bot"), session("a", depth: 1), doc, session("me", depth: 1)]).map(\.id), ["bot", "a", "me"])
    }

    /// Nested among many siblings: the two either side, five in all even
    /// at an end.
    func testManySiblingsAreTheNearestFive() {
        let rows = [space("bot")] + (0..<12).map { session("s\($0)", depth: 1) }
        XCTAssertEqual(StemCellsFamily.of("s6", in: rows).map(\.id), ["bot", "s4", "s5", "s6", "s7", "s8"])
        XCTAssertEqual(StemCellsFamily.of("s0", in: rows).map(\.id), ["bot", "s0", "s1", "s2", "s3", "s4"])
        XCTAssertEqual(StemCellsFamily.of("s11", in: rows).map(\.id), ["bot", "s7", "s8", "s9", "s10", "s11"])
        XCTAssertEqual(StemCellsFamily.of("missing", in: rows), [])
    }

    func testStartedReadsAsNearAsAPersonSaysIt() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_793_000_000) // Mon 2026-10-26 07:33 UTC
        func started(hoursAgo: Double) -> StemCellsDetailFormat.Started {
            StemCellsDetailFormat.started(since: (now.timeIntervalSince1970 - hoursAgo * 3600) * 1000, now: now, calendar: calendar)
        }
        func at(_ hoursAgo: Double) -> Date { now.addingTimeInterval(-hoursAgo * 3600) }
        XCTAssertEqual(started(hoursAgo: 2), .today(at(2)))
        XCTAssertEqual(started(hoursAgo: 20), .yesterday(at(20)))
        XCTAssertEqual(started(hoursAgo: 24 * 4), .weekday(at(24 * 4)))
        XCTAssertEqual(started(hoursAgo: 24 * 40), .thisYear(at(24 * 40)))
        XCTAssertEqual(started(hoursAgo: 24 * 400), .date(at(24 * 400)))
    }
}
