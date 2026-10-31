@testable import HappyCore
import XCTest

/// Home's search: desktop's ranking, and the sidebar narrowed with the
/// rows that make sense of a match.
final class SearchTests: XCTestCase {
    func testRankIsDesktopsStartThenWordThenAnywhere() {
        XCTAssertEqual(Search.rank("Plan Lisbon trip", "plan"), 0)
        XCTAssertEqual(Search.rank("Plan Lisbon trip", "lis"), 1)
        XCTAssertEqual(Search.rank("Plan Lisbon trip", "isbon"), 2)
        XCTAssertNil(Search.rank("Plan Lisbon trip", "porto"))
        // A word after punctuation counts as one; case and accents don't count.
        XCTAssertEqual(Search.rank("Day-trips", "TRIPS"), 1)
        XCTAssertEqual(Search.rank("Café notes", "cafe"), 0)
        // The later occurrence at a word's start is found past an earlier one inside a word.
        XCTAssertEqual(Search.rank("Rerun the report", "re"), 0)
        XCTAssertEqual(Search.rank("Theme a report", "port"), 2)
        XCTAssertEqual(Search.rank("Support report", "rep"), 1)
        // Nothing typed answers nothing.
        XCTAssertNil(Search.rank("Theme", "  "))
    }

    func testRankedIsBestFirstThenOwnOrderAndStopsAtSix() {
        let titles = ["Report an issue", "Theme", "Edit name", "Status", "Privacy policy", "Terms of service", "Stories", "Hide projects"]
        XCTAssertEqual(Search.ranked(titles, query: "s", title: { $0 }), ["Status", "Stories", "Terms of service", "Report an issue", "Hide projects"])
        XCTAssertEqual(Search.ranked(titles, query: "e", title: { $0 }).count, 6)
        XCTAssertEqual(Search.ranked(titles, query: "e", title: { $0 }).first, "Edit name")
        XCTAssertEqual(Search.ranked(titles, query: "e", limit: 2, title: { $0 }), ["Edit name", "Report an issue"])
    }

    /// Happy, then a separator, a Travel section holding a task with
    /// subtasks two deep, and a folded Bots section.
    private let all: [Row] = {
        var happy = Row(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", isHappy: true)
        happy.collapsed = nil
        var lisbon = Row(id: "space:lisbon", nodeId: "lisbon", kind: .space, label: "Plan Lisbon trip", collapsed: true)
        lisbon.hasHiddenSessions = true
        return [
            happy,
            Row(id: "divider", nodeId: "divider", kind: .separator, label: ""),
            Row(id: "travel", nodeId: "travel", kind: .section, label: "Travel", collapsed: false),
            lisbon,
            Row(id: "session:hoods", nodeId: "hoods", kind: .session, depth: 1, label: "Neighbourhoods", collapsed: false),
            Row(id: "session:alfama", nodeId: "alfama", kind: .session, depth: 2, label: "Alfama walk"),
            Row(id: "session:days", nodeId: "days", kind: .session, depth: 1, label: "Day trips"),
            Row(id: "space:passport", nodeId: "passport", kind: .space, label: "Renew passport"),
            Row(id: "bots", nodeId: "bots", kind: .section, label: "Bots", collapsed: true),
            Row(id: "space:chef", nodeId: "chef", kind: .space, label: "Chef"),
            Row(id: "space:coach", nodeId: "coach", kind: .space, label: "Fitness Coach"),
        ]
    }()

    private func ids(_ query: String) -> [String] {
        Search.rows(all, query: query).map(\.id)
    }

    func testANestedMatchKeepsWhatItNestsUnderAndItsSection() {
        XCTAssertEqual(ids("alfama"), ["travel", "space:lisbon", "session:hoods", "session:alfama"])
        // A sibling of an ancestor stays out.
        XCTAssertFalse(ids("alfama").contains("session:days"))
        XCTAssertEqual(ids("day"), ["travel", "space:lisbon", "session:days"])
    }

    func testFoldsDontHideMatchesAndNothingFoldsInTheResults() {
        // Chef sits under the folded Bots section.
        XCTAssertEqual(ids("chef"), ["bots", "space:chef"])
        let rows = Search.rows(all, query: "trip")
        XCTAssertEqual(rows.map(\.id), ["travel", "space:lisbon", "session:days"])
        XCTAssertTrue(rows.allSatisfy { $0.collapsed == nil && !$0.hasHiddenSessions })
        // Depths stay, so the tree draws as it does.
        XCTAssertEqual(rows.map(\.depth), [0, 0, 1])
    }

    func testAHeadingThatAnswersKeepsItsWholeSection() {
        XCTAssertEqual(ids("bots"), ["bots", "space:chef", "space:coach"])
        XCTAssertEqual(ids("trav"), ["travel", "space:lisbon", "session:hoods", "session:alfama", "session:days", "space:passport"])
    }

    func testRowsBeforeAnySectionStandAlone() {
        XCTAssertEqual(ids("happy"), ["space:happy"])
        XCTAssertEqual(ids("zzz"), [])
        // Separators and the document's Search row never show.
        XCTAssertEqual(Search.rows([Row(id: "s", nodeId: "s", kind: .search, label: "Search")] + all, query: "sea"), [])
    }

    /// An empty search: the bots and tasks last active, newest first, a
    /// subtask's activity counting for its task; a Surface, a project's
    /// session, a separator or one never active isn't among them.
    func testRecentIsTheBotsAndTasksLastActiveNewestFirst() {
        func row(_ id: String, _ kind: Row.Kind, depth: Int = 0, agent: String? = nil, at minute: Double? = nil, target: String? = nil) -> Row {
            var row = Row(id: id, nodeId: id, kind: kind, depth: depth, label: id, agentId: agent, targetKind: target)
            row.activityTime = minute.map { $0 * 60_000 }
            return row
        }
        let rows = [
            row("artifacts", .space, target: "artifacts"),
            row("surface", .space, agent: "chat", at: 99, target: "surface"),
            row("bots", .separator),
            row("happy", .space, agent: "a-happy", at: 5, target: "bot"),
            row("sub", .session, depth: 1, agent: "a-sub", at: 9),
            row("quiet", .space, agent: "a-quiet", target: "bot"),
            row("tasks", .separator),
            row("task", .space, agent: "a-task", at: 6, target: "task"),
            row("old", .space, agent: "a-old", at: 1, target: "task"),
            row("projects", .separator),
            row("project", .space, target: "project"),
            row("session", .session, depth: 1, agent: "a-session", at: 50),
        ]
        let recent = Search.recent(rows)
        XCTAssertEqual(recent.map(\.id), ["happy", "task", "old"])
        XCTAssertTrue(recent.allSatisfy { $0.collapsed == nil && !$0.hasHiddenSessions })
        XCTAssertEqual(Search.recent(rows, limit: 2).map(\.id), ["happy", "task"])
        XCTAssertEqual(Search.recent([row("quiet", .space, agent: "a", target: "bot")]), [])
    }
}
