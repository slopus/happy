@testable import HappyCore
import XCTest

/// The working line says what desktop's says, in desktop's order.
final class StemCellActivityTests: XCTestCase {
    private func project(working: Bool = true, status: String = "working", wait: AgentWire.AgentWait? = nil, retrying: AgentWire.AgentRetrying? = nil, question: Bool = false, subagents: Int = 0, produced: Bool = true) -> StemCellActivity.Phase? {
        StemCellActivity.project(working: working, status: status, wait: wait, retrying: retrying, question: question, subagentsRunning: subagents, produced: produced, startedAt: 1000)?.phase
    }

    func testTheAgentsStatusNamesThePhase() {
        XCTAssertEqual(project(status: "thinking"), .thinking)
        XCTAssertEqual(project(status: "generating_tools"), .preparingTools)
        XCTAssertEqual(project(status: "running_tools"), .runningTools)
        XCTAssertEqual(project(status: "working"), .working)
        XCTAssertNil(project(working: false, status: "idle"))
    }

    func testUntilTheTurnShowsAnythingItIsWaitingForTheModel() {
        XCTAssertEqual(project(status: "idle", produced: false), .waitingForModel)
        XCTAssertEqual(project(status: "thinking", produced: false), .waitingForModel)
        // Tools mean the model has answered.
        XCTAssertEqual(project(status: "running_tools", produced: false), .runningTools)
        XCTAssertEqual(project(status: "thinking", produced: true), .thinking)
    }

    func testAQuestionThenAWaitThenARetryOutrankTheStatus() {
        let wait = AgentWire.AgentWait(startedAt: 0, dueAt: 60_000)
        let retry = AgentWire.AgentRetrying(attempt: 2, maxAttempts: 10, kind: "rate_limited", vendorName: "Claude")
        XCTAssertEqual(project(wait: wait, retrying: retry, question: true), .awaitingAnswer)
        XCTAssertEqual(project(wait: wait, retrying: retry), .waiting(wait))
        XCTAssertEqual(project(status: "thinking", retrying: retry, produced: false), .retrying(retry))
        // A question is shown after its run ends too, without a clock.
        let asked = StemCellActivity.project(working: false, status: "idle", wait: nil, retrying: nil, question: true, subagentsRunning: 0, produced: false, startedAt: 5)
        XCTAssertEqual(asked, StemCellActivity(phase: .awaitingAnswer, startedAt: nil))
    }

    func testAFinishedTurnWithSubagentsStillRunningIsDelegating() {
        XCTAssertEqual(project(working: false, status: "idle", subagents: 2), .delegating)
        XCTAssertEqual(project(working: true, status: "working", subagents: 2), .working)
    }
}
