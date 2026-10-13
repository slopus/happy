import XCTest
@testable import HappyCore

final class ChatPhase0SkippingTests: XCTestCase {
    func testHandlesPermissionsWhenAgentStateAndMatchingToolsArriveTogether() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.call("start", at: 100), ChatRecords.result("end")],
            agentState: ChatRecords.permissionState(
                status: "approved",
                extra: ["decision": .string("approved_for_session"), "allowTools": .array([.string("Bash")])])
        )
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(row.tool.state, .completed)
        XCTAssertEqual(row.createdAt, 100)
        XCTAssertEqual(row.tool.createdAt, 50)
        XCTAssertEqual(row.tool.permission?.decision, .approvedForSession)
        XCTAssertEqual(row.tool.permission?.allowedTools, ["Bash"])
    }

    func testHandlesCaseWhereToolsArriveFirstThenAgentStateArrivesLater() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.call("start"), ChatRecords.result("end")])
        let before = try ChatRecords.toolRow(state.messages)
        _ = state.reduce([], agentState: ChatRecords.permissionState(status: "approved"))
        let after = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(before.id, after.id)
        XCTAssertEqual(after.tool.state, .completed)
        XCTAssertEqual(after.tool.result, .string("done"))
        XCTAssertEqual(after.tool.permission?.status, .approved)
        XCTAssertEqual(state.messages.count, 1)
    }
}
