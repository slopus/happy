@testable import HappyCore
import HappyWire
import XCTest

final class StemCellsAgentsTests: XCTestCase {
    /// A list read again after a subtask was archived leaves it out from
    /// under its parent, as the live update did.
    func testAnArchivedSubtaskIsNotUnderItsParent() {
        var agents = StemCellsAgents()
        agents.absorb(.object([
            "id": .string("t"), "version": .string("1"),
            "subtasks": .array([
                .object(["id": .string("a"), "version": .string("1"), "archivedAt": .null]),
                .object(["id": .string("b"), "version": .string("2"), "archivedAt": .number(1_700_000_000_000)]),
            ]),
        ]))
        XCTAssertEqual(agents.children["t"], ["a"])
    }
}
