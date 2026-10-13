import XCTest
@testable import HappyCore

/// Receipt and ordering cases ported from pendingUserMessages.spec.ts.
final class ChatPendingUserMessagesTests: XCTestCase {
    func testHoldsJustSentMessageAndParksItBelowEverythingElse() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("local", localId: "local")], holdUserMessagesUntilAccepted: true)
        let row = try ChatRecords.userRow(state.messages)
        XCTAssertTrue(row.pending)
        XCTAssertEqual(row.sortAt, 100 + ChatMessage.pendingSortOffset)
        XCTAssertEqual(row.createdAt, 100)
    }

    func testExtremeStoredTimestampDoesNotOverflowPendingPosition() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.user("local", localId: "local", at: .max)], holdUserMessagesUntilAccepted: true)
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, .max)
    }

    func testCommitsImmediatelyInSessionThatNeverReportsAcceptance() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("local", localId: "local")])
        let row = try ChatRecords.userRow(state.messages)
        XCTAssertFalse(row.pending)
        XCTAssertNil(row.sortAt)
    }

    func testReleasesMessageWhenReceiptArrivesAtReceiptPosition() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("local", localId: "local")], holdUserMessagesUntilAccepted: true)
        _ = state.reduce([ChatRecords.user("server", localId: "local")], holdUserMessagesUntilAccepted: true)
        let result = state.reduce([ChatRecords.receipt("r", ref: "server")])
        let row = try ChatRecords.userRow(state.messages)
        XCTAssertFalse(row.pending)
        XCTAssertEqual(row.sortAt, 500)
        XCTAssertEqual(row.id, "local")
        XCTAssertEqual(result.settledMessageIds, ["local"])
    }

    func testReleasesMessageWhenReceiptOutrunsServerEcho() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("local", localId: "local")], holdUserMessagesUntilAccepted: true)
        XCTAssertTrue(state.reduce([ChatRecords.receipt("r", ref: "server")]).messages.isEmpty)
        _ = state.reduce([ChatRecords.user("server", localId: "local")])
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, 500)
    }

    func testRendersNothingForReceiptItself() {
        var state = ChatReducer()
        XCTAssertTrue(state.reduce([ChatRecords.receipt("r", ref: "unknown")]).messages.isEmpty)
        XCTAssertTrue(state.messages.isEmpty)
    }

    func testIgnoresReceiptForMessageThisDeviceNeverSent() {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.text("a")])
        XCTAssertTrue(state.reduce([ChatRecords.receipt("r", ref: "unknown")]).messages.isEmpty)
        XCTAssertEqual(state.messages.count, 1)
    }

    func testKeepsInterruptedTurnAboveMessageAndNewTurnBelowIt() {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.user("local", localId: "local", at: 100), ChatRecords.text("old", at: 200)],
            holdUserMessagesUntilAccepted: true)
        XCTAssertEqual(state.messages.map(\.id), ["old:0", "local"])
        _ = state.reduce([
            ChatRecords.user("server", localId: "local"), ChatRecords.receipt("r", ref: "server", at: 300),
            ChatRecords.text("new", at: 400),
        ])
        XCTAssertEqual(state.messages.map(\.id), ["old:0", "local", "new:0"])
    }

    func testNeverHoldsMessageReplayedFromHistory() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("server", localId: "local")], holdUserMessagesUntilAccepted: true)
        XCTAssertFalse(try ChatRecords.userRow(state.messages).pending)
    }

    func testRestoresPendingOnlyForHistorySentWithAcceptanceEnabled() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.user("server", localId: "local", expects: true)], holdUserMessagesUntilAccepted: true
        )
        XCTAssertTrue(try ChatRecords.userRow(state.messages).pending)
    }

    func testSettlesFromReceiptDaemonActuallyPutsOnWire() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.user("server", localId: "local", expects: true)], holdUserMessagesUntilAccepted: true
        )
        _ = state.reduce([ChatRecords.receipt("accepted", ref: "server")])
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, 500)
        XCTAssertEqual(state.messages.count, 1)
    }

    func testSettlesThroughSendAckWhenSocketEchoNeverArrives() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("local", localId: "local")], holdUserMessagesUntilAccepted: true)
        _ = state.reduce([ChatRecords.receipt("r", ref: "server")])
        let changed = state.registerUserMessageServerIds([("server", "local")])
        XCTAssertEqual(try ChatRecords.userRow(changed).sortAt, 500)
    }

    func testKeepsAckThatOutranOptimisticInsertUntilRowExists() throws {
        var state = ChatReducer()
        _ = state.registerUserMessageServerIds([("server", "local")])
        _ = state.reduce([ChatRecords.receipt("r", ref: "server")])
        _ = state.reduce([ChatRecords.user("local", localId: "local")], holdUserMessagesUntilAccepted: true)
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, 500)
    }

    func testGivesReplayedMessageRunOrderPlaceOnFreshReload() throws {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.receipt("r", ref: "server"), ChatRecords.user("server", localId: "local"),
        ])
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, 500)
    }

    func testNeverRepositionsMessageTwice() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("server"), ChatRecords.receipt("r", ref: "server")])
        XCTAssertTrue(state.reduce([ChatRecords.receipt("r2", ref: "server", at: 900)]).messages.isEmpty)
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, 500)
    }

    func testReportsSettleOnlyChangesSoTheyAreNotAnnouncedAsNew() {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("server")])
        let result = state.reduce([ChatRecords.receipt("r", ref: "server")])
        XCTAssertEqual(result.settledMessageIds, ["server"])
        XCTAssertEqual(result.messages.count, 1)
    }

    func testHoldsEachPendingMessageInOrderSent() {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.user("l2", localId: "l2", at: 200), ChatRecords.user("l1", localId: "l1", at: 100)],
            holdUserMessagesUntilAccepted: true)
        XCTAssertEqual(state.messages.map(\.id), ["l1", "l2"])
    }

    func testNeverHoldsOtherParticipantsMessagePublishedAtAcceptance() throws {
        var state = ChatReducer()
        var record = ChatRecords.user("participant-server")
        record.author = SessionAuthor(id: "other", name: "Other", owner: false)
        _ = state.reduce([record], holdUserMessagesUntilAccepted: true)
        let row = try ChatRecords.userRow(state.messages)
        XCTAssertFalse(row.pending)
        XCTAssertEqual(row.author?.name, "Other")
    }

    func testRejectionSettlesOriginalBubbleAndCarriesError() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("server", expects: true)], holdUserMessagesUntilAccepted: true)
        _ = state.reduce([ChatRecords.receipt("r", ref: "server", error: "Agent stopped")])
        let row = try ChatRecords.userRow(state.messages)
        XCTAssertFalse(row.pending)
        XCTAssertEqual(row.sortAt, 500)
        XCTAssertEqual(row.sendError, "Agent stopped")
    }

    func testDedupeByLocalIdWithinSameBatchStillJoinsServerReceipt() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [
                ChatRecords.user("local", localId: "local"), ChatRecords.user("server", localId: "local"),
                ChatRecords.receipt("r", ref: "server"),
            ], holdUserMessagesUntilAccepted: true)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(try ChatRecords.userRow(state.messages).sortAt, 500)
    }

    func testCarriesTurnIdOntoAgentTextToolAndEventRows() throws {
        var state = ChatReducer()
        var event = ChatRecords.agentEvent(
            "e", event: ChatRecords.json(#"{"type":"message","message":"hello"}"#))
        event.turn = "turn"
        _ = state.reduce([ChatRecords.text("a"), ChatRecords.call("c"), event])
        for row in state.messages {
            switch row {
            case .agentText(let row): XCTAssertEqual(row.turn, "turn")
            case .toolCall(let row): XCTAssertEqual(row.turn, "turn")
            case .agentEvent(let row): XCTAssertEqual(row.turn, "turn")
            default: XCTFail("agent rows")
            }
        }
    }
}
