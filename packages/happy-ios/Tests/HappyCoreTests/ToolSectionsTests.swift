import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Group tool calls as desktop's `conversationToolSections` reads a
/// transcript: runs of one-line calls are one row, live until something
/// follows them, summed up once over, and gone back to rows in a turn
/// opened on its traces.
final class ToolSectionsTests: XCTestCase {
    private func user(_ id: String, turn: String?) -> ChatItem { ChatItem(id: id, role: .user, pieces: [.text("go")], delivery: .sent, turn: turn) }
    private func agent(_ id: String, at: Double, turn: String) -> ChatItem { ChatItem(id: id, role: .agent, pieces: [.text("Looking.")], delivery: .sent, turn: turn, madeAt: at) }
    private func tool(_ id: String, _ type: String = "exec_command", status: String = "completed", at: Double, turn: String = "r", pieces: [ChatItem.Piece] = []) -> ChatItem {
        ChatItem(id: id, role: .tool(.init(name: "exec_command", status: status, presentation: AgentWire.Presentation(type: type))), pieces: pieces, delivery: .sent, turn: turn, madeAt: at)
    }
    private func ended(_ turn: String, at: Double) -> ChatItem {
        ChatItem(id: "\(turn):status", role: .turnEnd(.init(reason: "completed", durationMs: 1, tools: 3, copyText: nil, endedAt: at)), pieces: [], delivery: .sent, turn: turn)
    }
    private func section(_ item: ChatItem) -> ChatItem.Section? {
        if case .section(let section) = item.role { section } else { nil }
    }

    /// A run is one row named by its first call, live while the turn runs
    /// with nothing after it, and ended for good once words follow it.
    func testARunIsOneRowThatEndsWhenTheAgentSpeaks() throws {
        var memory = ToolSections.Memory()
        let run = [user("u", turn: "r"), tool("t1", at: 1_000), tool("t2", status: "running", at: 2_000)]
        let live = ToolSections.group(run, working: true, memory: &memory)
        XCTAssertEqual(live.map(\.id), ["u", "t1"])
        XCTAssertEqual(try XCTUnwrap(section(live[1])).members.map(\.id), ["t1", "t2"])
        XCTAssertTrue(try XCTUnwrap(section(live[1])).live)

        let spoken = run.dropLast() + [tool("t2", at: 2_000), agent("a", at: 75_000, turn: "r")]
        let ended = try XCTUnwrap(section(ToolSections.group(Array(spoken), working: true, memory: &memory)[1]))
        XCTAssertFalse(ended.live)
        XCTAssertTrue(ended.sums)
        XCTAssertEqual(ended.durationMs, 74_000)
        // The words going away again (a delta replayed) leave it ended.
        let again = try XCTUnwrap(section(ToolSections.group(Array(spoken.dropLast()), working: true, memory: &memory)[1]))
        XCTAssertFalse(again.live)
    }

    /// A call that shows something keeps its own row and ends the run; a
    /// turn's edge ends it too; queued messages after it don't.
    func testShowingACallOrANewTurnBreaksARun() {
        var memory = ToolSections.Memory()
        let items = [
            tool("t1", at: 1), tool("m", "media", at: 2, pieces: [.text("shown")]), tool("t2", at: 3),
            tool("t3", at: 4, turn: "s"), user("q", turn: nil),
        ]
        let grouped = ToolSections.group(items, working: true, queued: 1, memory: &memory)
        XCTAssertEqual(grouped.map(\.id), ["t1", "m", "t2", "t3", "q"])
        XCTAssertEqual(grouped.map { section($0)?.live }, [false, nil, false, true, nil])
    }

    /// A turn's end closes every section before it, a call left running
    /// included; a run of one call is never summed up.
    func testAStoppedTurnSumsItsRunsUp() throws {
        var memory = ToolSections.Memory()
        let items = [tool("t1", status: "running", at: 1_000), ended("r", at: 4_500)]
        let one = try XCTUnwrap(section(ToolSections.group(items, working: false, memory: &memory)[0]))
        XCTAssertFalse(one.live)
        XCTAssertFalse(one.sums)
        XCTAssertEqual(one.durationMs, 3_500)
    }

    /// Opened on its traces, a turn shows every call again; folded, its
    /// sections are steps and go with the rest, a file edit among them.
    func testAnOpenedTurnHasNoSectionsAndAClosedOneFoldsThem() {
        let items = [
            user("u", turn: "r"), tool("t1", at: 1), tool("e", "file_diff", at: 2), agent("a", at: 3, turn: "r"), ended("r", at: 4),
        ]
        var memory = ToolSections.Memory()
        let open = TurnFold.shown(items, working: false, queued: 0, grouped: true, expanded: ["r"], memory: &memory)
        XCTAssertEqual(open.map(\.id), ["u", "r:trace", "t1", "e", "a", "r:status"])
        let closed = TurnFold.shown(items, working: false, queued: 0, grouped: true, expanded: [], memory: &memory)
        XCTAssertEqual(closed.map(\.id), ["u", "r:trace", "a", "r:status"])
        let ungrouped = TurnFold.shown(items, working: false, queued: 0, grouped: false, expanded: [], memory: &memory)
        XCTAssertEqual(ungrouped.map(\.id), ["u", "e", "r:trace", "a", "r:status"])
    }

    /// An answered question is a line, unless this screen saw it waiting.
    func testAnAnsweredQuestionIsALineUnlessAskedHere() {
        let question = AgentWire.Question(id: "q", status: "answered", questions: [.init(id: "p", header: "Scope", question: "Which?", multiSelect: false, options: nil)], answers: ["p": ["All"]])
        func ask(_ phase: ChatItem.Ask.Phase) -> ChatItem { ChatItem(id: "q", role: .question(.init(question: question, phase: phase)), pieces: [], delivery: .sent, turn: "r") }
        func line(_ item: ChatItem) -> Bool { if case .question(let ask) = item.role { ask.line } else { false } }
        var fresh = ToolSections.Memory()
        XCTAssertTrue(line(ToolSections.group([ask(.answered)], working: false, memory: &fresh)[0]))
        var watched = ToolSections.Memory()
        XCTAssertFalse(line(ToolSections.group([ask(.pending)], working: true, memory: &watched)[0]))
        XCTAssertFalse(line(ToolSections.group([ask(.answered)], working: true, memory: &watched)[0]))
    }

    /// "Read 3 · Explore 2 · Edit": by count, then first run; past four
    /// kinds the rest are counted.
    func testASummaryNamesItsKindsMostFrequentFirst() {
        XCTAssertEqual(ChatItem.Section.kinds(["Edit", "Read", "Explore", "Read", "Explore", "Read"]), ["Read 3", "Explore 2", "Edit"])
        XCTAssertEqual(ChatItem.Section.kinds(["A", "B", "C", "D", "E", "E"]), ["E 2", "A", "B", "+2 more"])
        XCTAssertEqual(ChatItem.Section.kinds(["A", "B", "C", "D"]), ["A", "B", "C", "D"])
    }
}
