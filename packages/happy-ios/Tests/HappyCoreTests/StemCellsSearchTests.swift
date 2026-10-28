@testable import HappyCore
import XCTest

/// Home's search: desktop's ranking, and the sidebar narrowed with the
/// rows that make sense of a match.
final class StemCellsSearchTests: XCTestCase {
    func testRankIsDesktopsStartThenWordThenAnywhere() {
        XCTAssertEqual(StemCellsSearch.rank("Plan Lisbon trip", "plan"), 0)
        XCTAssertEqual(StemCellsSearch.rank("Plan Lisbon trip", "lis"), 1)
        XCTAssertEqual(StemCellsSearch.rank("Plan Lisbon trip", "isbon"), 2)
        XCTAssertNil(StemCellsSearch.rank("Plan Lisbon trip", "porto"))
        // A word after punctuation counts as one; case and accents don't count.
        XCTAssertEqual(StemCellsSearch.rank("Day-trips", "TRIPS"), 1)
        XCTAssertEqual(StemCellsSearch.rank("Café notes", "cafe"), 0)
        // The later occurrence at a word's start is found past an earlier one inside a word.
        XCTAssertEqual(StemCellsSearch.rank("Rerun the report", "re"), 0)
        XCTAssertEqual(StemCellsSearch.rank("Theme a report", "port"), 2)
        XCTAssertEqual(StemCellsSearch.rank("Support report", "rep"), 1)
        // Nothing typed answers nothing.
        XCTAssertNil(StemCellsSearch.rank("Theme", "  "))
    }

    func testRankedIsBestFirstThenOwnOrderAndStopsAtSix() {
        let titles = ["Report an issue", "Theme", "Edit name", "Status", "Privacy policy", "Terms of service", "Stories", "Hide projects"]
        XCTAssertEqual(StemCellsSearch.ranked(titles, query: "s", title: { $0 }), ["Status", "Stories", "Terms of service", "Report an issue", "Hide projects"])
        XCTAssertEqual(StemCellsSearch.ranked(titles, query: "e", title: { $0 }).count, 6)
        XCTAssertEqual(StemCellsSearch.ranked(titles, query: "e", title: { $0 }).first, "Edit name")
        XCTAssertEqual(StemCellsSearch.ranked(titles, query: "e", limit: 2, title: { $0 }), ["Edit name", "Report an issue"])
    }

    /// Happy, then a separator, a Travel section holding a task with
    /// subtasks two deep, and a folded Bots section.
    private let all: [StemCellsRow] = {
        var happy = StemCellsRow(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", isHappy: true)
        happy.collapsed = nil
        var lisbon = StemCellsRow(id: "space:lisbon", nodeId: "lisbon", kind: .space, label: "Plan Lisbon trip", collapsed: true)
        lisbon.hasHiddenSessions = true
        return [
            happy,
            StemCellsRow(id: "divider", nodeId: "divider", kind: .separator, label: ""),
            StemCellsRow(id: "travel", nodeId: "travel", kind: .section, label: "Travel", collapsed: false),
            lisbon,
            StemCellsRow(id: "session:hoods", nodeId: "hoods", kind: .session, depth: 1, label: "Neighbourhoods", collapsed: false),
            StemCellsRow(id: "session:alfama", nodeId: "alfama", kind: .session, depth: 2, label: "Alfama walk"),
            StemCellsRow(id: "session:days", nodeId: "days", kind: .session, depth: 1, label: "Day trips"),
            StemCellsRow(id: "space:passport", nodeId: "passport", kind: .space, label: "Renew passport"),
            StemCellsRow(id: "bots", nodeId: "bots", kind: .section, label: "Bots", collapsed: true),
            StemCellsRow(id: "space:chef", nodeId: "chef", kind: .space, label: "Chef"),
            StemCellsRow(id: "space:coach", nodeId: "coach", kind: .space, label: "Fitness Coach"),
        ]
    }()

    private func ids(_ query: String) -> [String] {
        StemCellsSearch.rows(all, query: query).map(\.id)
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
        let rows = StemCellsSearch.rows(all, query: "trip")
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
        XCTAssertEqual(StemCellsSearch.rows([StemCellsRow(id: "s", nodeId: "s", kind: .search, label: "Search")] + all, query: "sea"), [])
    }
}
