import Foundation
import HappyCore
import HappyWire
import XCTest

final class NativePresentationTests: XCTestCase {
    @MainActor
    func testSendAndRetryWithoutAccountFailInsteadOfDroppingDraft() async {
        let model = NativeSessionModel()
        do { try await model.send("Keep this draft"); XCTFail("send must not silently succeed") }
        catch { XCTAssertTrue(error is NativeSessionModelError) }
        do { try await model.retry("local"); XCTFail("retry must not silently succeed") }
        catch { XCTAssertTrue(error is NativeSessionModelError) }
    }

    func testToolOutputStaysSeparateFromCollapsedRowAndPermissionStaysVisible() {
        let snapshot = ChatSnapshot(sessionId: "s", messages: [
            .toolCall(.init(id: "tool", createdAt: 1, tool: .init(name: "Bash", state: .running,
                input: .object([:]), createdAt: 1, result: .string("large output"), permission: .init(id: "permit", status: .pending)))),
        ])
        let row = ConversationRow.make(snapshot)[0]
        XCTAssertEqual(row.heading, "Bash")
        XCTAssertFalse(row.text.contains("large output"))
        XCTAssertNotNil(row.detail)
        XCTAssertEqual(row.permissionID, "permit")
    }

    func testDeliveryAndUnsupportedRowsAreNotLost() {
        let snapshot = ChatSnapshot(sessionId: "s", messages: [
            .userText(.init(id: "u", localId: "pending", createdAt: 1, text: "raw", displayText: "Shown")),
        ], delivery: ["pending": .failed("offline")])
        let row = ConversationRow.make(snapshot)[0]
        XCTAssertEqual(row.text, "Shown")
        XCTAssertEqual(row.localID, "pending")
        XCTAssertEqual(row.delivery, .failed("offline"))
    }

    func testStreamDeltaReconfiguresOnlyChangedRow() {
        let first = ChatSnapshot(sessionId: "s", messages: [
            .userText(.init(id: "u", createdAt: 1, text: "Hello")),
            .agentText(.init(id: "a", createdAt: 2, text: "Hi")),
        ])
        var next = first
        next.messages[1] = .agentText(.init(id: "a", createdAt: 2, text: "Hi there"))
        let oldRows = ConversationRow.make(first)
        let newRows = ConversationRow.make(next)
        let changes = ConversationChanges(previous: oldRows, next: newRows)
        XCTAssertFalse(changes.membershipChanged)
        XCTAssertEqual(changes.changed, IndexSet(integer: 1))
        XCTAssertTrue(ConversationChanges(previous: newRows, next: newRows).changed.isEmpty)
    }
}