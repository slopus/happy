@testable import HappyCore
import XCTest

/// When a sidebar row is working, as desktop's
/// `happyAgentConversationActivityProject` says: the same state that
/// shimmers its title there.
final class RowActivityTests: XCTestCase {
    private typealias Agent = AgentWire.Agent
    private let wait = AgentWire.AgentWait(startedAt: 0, dueAt: 60)

    private func agent(_ status: String = "idle", wait: AgentWire.AgentWait? = nil, question: Bool = false, subagents: Int? = nil, subtasks: [Agent]? = nil, archived: Bool = false) -> Agent {
        Agent(
            id: UUID().uuidString, workspaceId: "w", status: status, wait: wait, subtasks: subtasks,
            pendingQuestionId: question ? "q" : nil, archivedAt: archived ? 1 : nil,
            subagents: subagents.map { AgentWire.AgentSubagents(total: $0, running: $0) }
        )
    }

    func testARunningTurnWorksAndAnIdleOneDoesnt() {
        XCTAssertEqual(Rows.activity(agent("running")), .working)
        XCTAssertEqual(Rows.activity(agent("queued")), .working)
        XCTAssertEqual(Rows.activity(agent()), .none)
    }

    func testAQuestionOrAWaitIsNotWork() {
        XCTAssertEqual(Rows.activity(agent("running", question: true)), .awaitingInput)
        XCTAssertEqual(Rows.activity(agent("running", wait: wait)), .waiting)
    }

    func testWorkHandedOnKeepsTheRowWorking() {
        // Hidden subagents still running.
        XCTAssertEqual(Rows.activity(agent(subagents: 2)), .working)
        // A subtask working, however deep, even while the parent waits.
        let deep = agent(subtasks: [agent(subtasks: [agent("running")])])
        XCTAssertEqual(Rows.activity(deep), .working)
        XCTAssertEqual(Rows.activity(agent("running", wait: wait, subtasks: [agent("running")])), .working)
        // The host's count takes in that subtask: nothing hidden beyond it.
        XCTAssertEqual(Rows.activity(agent(subagents: 1, subtasks: [agent("running", wait: wait)])), .waiting)
        // A question below asks for the whole row; an archived subtask says nothing.
        XCTAssertEqual(Rows.activity(agent("running", subtasks: [agent(question: true)])), .awaitingInput)
        XCTAssertEqual(Rows.activity(agent(subtasks: [agent("running", archived: true)])), .none)
    }

    /// The space's `working` is a reading from its last change; the
    /// conversation, when there is one, is what's live.
    func testTheConversationOutranksTheSpacesStaleReading() {
        XCTAssertEqual(Rows.status(agent(), working: true), .none)
        XCTAssertEqual(Rows.status(nil, working: true), .working)
        XCTAssertEqual(Rows.status(nil, working: false), .none)
    }
}
