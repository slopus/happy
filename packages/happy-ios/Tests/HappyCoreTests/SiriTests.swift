import Foundation
import XCTest
@testable import HappyCore

/// What Siri says of home's conversations, and which one a name it heard means.
final class SiriTests: XCTestCase {
    private let now: Double = 1_800_000_000_000
    private let minute: Double = 60_000

    private func row(_ agent: String, _ label: String, kind: String = "task", status: Row.Status = .none, unread: Bool = false,
                     ago minutes: Double? = nil, depth: Int = 0) -> Row {
        var row = Row(id: "space:\(agent)", nodeId: agent, kind: .space, depth: depth, label: label, status: status, unread: unread,
                      agentId: agent, targetKind: kind)
        row.activityTime = minutes.map { now - $0 * minute }
        return row
    }

    func testNothingGoingOn() {
        XCTAssertEqual(AgentsSummary.text(rows: [], now: now), "You have no agents yet.")
        XCTAssertEqual(AgentsSummary.text(rows: [row("a", "Release notes", ago: 600)], now: now), "Nothing is working, and nothing needs you.")
    }

    func testNeedsYouFirstThenWorkingThenFinished() {
        let rows = [
            row("a", "Release notes", status: .working),
            row("b", "Docs review", status: .awaitingInput),
            row("c", "Cache fix", status: .working),
            row("d", "Sync bug", ago: 20),
            row("e", "Old thing", ago: 600),
        ]
        XCTAssertEqual(AgentsSummary.text(rows: rows, now: now),
                       "Docs review needs you. Release notes and Cache fix are working. Sync bug finished recently.")
    }

    func testAnUnreadReplyCountsAsRecentForADay() {
        let rows = [row("a", "Sync bug", unread: true, ago: 300), row("b", "Stale", unread: true, ago: 2000), row("c", "Read", ago: 300)]
        XCTAssertEqual(AgentsSummary.text(rows: rows, now: now), "Sync bug finished recently.")
    }

    func testFinishedNewestFirst() {
        let rows = [row("a", "Older", ago: 50), row("b", "Newer", ago: 5)]
        XCTAssertEqual(AgentsSummary.text(rows: rows, now: now), "Newer and Older finished recently.")
    }

    func testABigGroupNamesThreeAndCountsTheRest() {
        let rows = (1...5).map { row("a\($0)", "Task \($0)", status: .working) }
        XCTAssertEqual(AgentsSummary.text(rows: rows, now: now), "5 are working: Task 1, Task 2, Task 3 and 2 more.")
    }

    func testOfflineSaysItIsWhatThePhoneLastSaw() {
        XCTAssertEqual(AgentsSummary.text(rows: [row("a", "Release notes", status: .working)], now: now, live: false),
                       "Happy can't reach your computer, so this is from when it last could. Release notes is working.")
    }

    func testSurfacesAndHeadingsAreNotConversations() {
        let rows = [
            Row(id: "space:p", nodeId: "p", kind: .space, label: "happy", targetKind: "project"),
            row("s", "Notes", kind: "surface", status: .working),
            row("a", "Fix login", kind: "conversation", status: .working, depth: 1),
        ]
        XCTAssertEqual(AgentsSummary.text(rows: rows, now: now), "Fix login is working.")
    }

    func testTitlesAreSaidWithoutCodePathsOrIDs() {
        XCTAssertEqual(AgentsSummary.spoken("Fix `parseRow` in Sources/HappyCore/Rows.swift"), "Fix parseRow in Rows.swift")
        XCTAssertEqual(AgentsSummary.spoken("Review a32734b76 before **release**"), "Review before release")
        XCTAssertEqual(AgentsSummary.spoken("Ship 2026.11.1"), "Ship 2026.11.1")
        XCTAssertEqual(AgentsSummary.spoken("Run 0f3c2e1d-7a2b-4c1e-9d3f-123456789abc"), "Run")
        XCTAssertEqual(AgentsSummary.spoken("Refactor reconciliation"), "Refactor reconciliation")
    }

    func testUnnamedWorkIsSaidByWhatItIsUnder() {
        let rows = [
            row("bot", "Chief of Staff", kind: "bot"),
            row("sub", "New Task", kind: "conversation", status: .working, depth: 1),
            row("t", "New Task", status: .working),
        ]
        XCTAssertEqual(AgentsSummary.text(rows: rows, now: now), "A new subtask under Chief of Staff and a new task are working.")
    }

    // MARK: Names

    private let targets = [
        CallTarget(agentId: "a", title: "Release notes", kind: .task, status: .idle),
        CallTarget(agentId: "b", title: "Chief of Staff", kind: .bot, status: .idle),
        CallTarget(agentId: "c", title: "Release", kind: .task, status: .idle),
        CallTarget(agentId: "d", title: "Café réseau", kind: .task, status: .idle),
        CallTarget(agentId: "e", title: "Notes on the release", kind: .task, status: .idle),
    ]

    func testAWholeTitleWinsThenOneItStartsThenEveryWord() {
        XCTAssertEqual(AgentNameMatch.matches("release", in: targets).map(\.agentId), ["c", "a", "e"])
        XCTAssertEqual(AgentNameMatch.matches("Release Notes", in: targets).map(\.agentId), ["a", "e"])
        XCTAssertEqual(AgentNameMatch.matches("chief", in: targets).map(\.agentId), ["b"])
    }

    func testCaseAccentsAndPunctuationNeverMatter() {
        XCTAssertEqual(AgentNameMatch.matches("cafe reseau", in: targets).map(\.agentId), ["d"])
        XCTAssertEqual(AgentNameMatch.matches("Chief-of-staff!", in: targets).map(\.agentId), ["b"])
    }

    func testNothingSaidOrNothingMatchingIsNoMatch() {
        XCTAssertEqual(AgentNameMatch.matches("  ", in: targets), [])
        XCTAssertEqual(AgentNameMatch.matches("deploy", in: targets), [])
    }

    // MARK: Replies

    func testAReplyIsSaidWithoutCodeAndStopsAfterAFewSentences() {
        let reply = """
        Fixed it. The race was in `Store.flush`:

        ```swift
        await store.flush()
        ```
        I changed Sources/HappyCore/Store.swift and ran the tests. All pass. Want me to open a PR? It's ready.
        """
        XCTAssertEqual(SpokenReply.text(reply), "Fixed it. The race was in. I changed Store.swift and ran the tests. All pass.")
    }

    func testTheLastReplyIsTheNewestFinishedAnswer() {
        let target = CallTarget(agentId: "a", title: "A", kind: .task, status: .idle)
        let state = CallTargetState(target: target, messages: [CallMessage(id: "m", role: .assistant, text: "Still going", final: false)],
                                    turns: [CallTurn(id: "1", user: "go", reply: "First."), CallTurn(id: "2", user: "again", reply: "Second.")])
        XCTAssertEqual(SpokenReply.last(in: state), "Second.")
        XCTAssertNil(SpokenReply.last(in: CallTargetState(target: target)))
    }
}
